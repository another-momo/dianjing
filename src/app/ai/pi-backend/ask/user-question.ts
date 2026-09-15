/**
 * T56（Phase 3 W2/T-B5）→ 2026-09-15 改造：AI 可见 ask_user_question 的后端工具工厂。
 *
 * 语义（决策单 §4 Phase 1：软终止→硬阻断）：AI 调工具发表单 → execute 校验
 * 通过 → 注册 pending 到 AskPendingStore（formId = 'ask-'+toolCallId 双侧
 * 派生）→ 返回挂起 promise；agent loop await 期间物理停摆。
 * 用户经新端点 POST /api/pi/ask-answer {formId, answers|skip} → resolve，
 * 答案作为本工具结果在同一 turn 返回（content 含「The user answered the
 * form (formId=…).」+ 信封 JSON 原文，保持模型视野形状稳定；details 含
 * {formId, status:'answered', questions, answers}）。skip 则返 'skipped'。
 *
 * abort / 会话 GC → store.rejectForSession 触发 reject（abort signal 透传
 * 挂起期 pi run 收尾；execute 接收 signal——generate.ts 已知限制不模仿）。
 *
 * 装配形态：createAskUserQuestionTool(deps) 工厂返回 pi AgentTool——service.ts
 * 装配进 customTools。无桥调用、无凭证、无落盘——纯定义转发 + 校验 +
 * 挂起（store 单例由 service.ts 注入）。
 */

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import {
  serializeAskAnswer,
  validateAskUserQuestions,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'
import { normalizeAskParams } from '@open-pencil/core/tools/fork/marketing/normalize-params'
import { checkReservedLabels } from '@open-pencil/core/tools/fork/marketing/validate-questionnaire'

import { toToolResult } from '../tool-result'
import type { AskPendingStore } from './pending'

const ASK_USER_QUESTION_DESCRIPTION =
  'Present an in-chat form with questions for the user. The frontend renders a form card (single_select option cards, multi_select checkbox groups, image_select canvas-node thumbnails, text inputs); every single_select/multi_select/image_select question additionally offers an "Other" option that reveals a free-text input. This tool BLOCKS until the user answers or skips (or the run is aborted) — the answer arrives as THIS tool\'s result, do not assume a follow-up user message and do not call further tools before the result returns. Result content includes the answer envelope JSON where each question id maps to {"value":"<optionId or text>"} for a normal answer, {"values":["<optionId>",...]} for a multi_select answer, or {"value":"__freeText","freeText":"<the user\'s own words>"} when the user picked "Other" (for multi_select, "__freeText" appears inside "values" with "freeText" alongside) — treat that freeText as a first-class answer for that question. Per-question notes arrive as "notes" on that entry, and an optional top-level "notes" string carries the user\'s global remark. Result details also expose {formId, status, questions, answers}. If the user skipped, status is "skipped" and there are no answers — proceed with your best judgment and do not re-ask the same questions unless necessary. Rules: 1-8 questions; ids unique and non-empty; labels non-empty; single_select and multi_select need options (2-12 items, each {id,label,hint?}) and must not carry imageOptions; image_select needs imageOptions (1-12 items, each {nodeId,label?} referencing canvas nodes) and must not carry options; text carries neither; required defaults to true — set false for optional questions; notes defaults to false — set true on a question to collect an optional per-question note. Batch everything you need to ask into ONE call.' +
  " Guidelines for when to ask: only call this tool when a missing decision genuinely blocks your next design action — e.g. picking between mutually exclusive directions whose default would waste the user's time if wrong. Do NOT ask for information you can read yourself (canvas state via tools, document history, previous answers in this conversation) or for style/trend/value choices you can make a reasonable default for. Cap yourself at TWO forms per session; after that, commit to your best judgment and keep moving. Each form should batch every question you need into one call — never chain multiple forms to ask one question at a time."

/** 答案细节形状（details 字段；mapping.ts tool-output-available 骑 details 到前端） */
export type AskAnswerDetails =
  | {
      formId: string
      status: 'answered'
      questions: AskQuestionSpec[]
      answers: Record<
        string,
        { value?: string; values?: string[]; freeText?: string; notes?: string }
      >
      /** Wave 2 #9：提交时附加的全局备注（非空白才出现） */
      notes?: string
    }
  | {
      formId: string
      status: 'skipped'
      questions: AskQuestionSpec[]
    }

export interface AskUserQuestionToolDeps {
  /** pending-form 注册表（service.ts 单例注入；测试可注入假件） */
  store: AskPendingStore
  /** 当前 session id（service.ts 装配闭包注入；同 session 重复 register → alreadyPending 错误结果） */
  sessionId: string
  /** formId 注册后回调（宿主 recordAskForm——active-design-host.ts） */
  onPendingRegistered?: (formId: string) => void
  /** formId 派生（默认 'ask-'+toolCallId；测试可注入确定性） */
  makeId?: (toolCallId: string) => string
}

const QUESTION_SCHEMA = Type.Object({
  id: Type.String({ description: 'Unique question id' }),
  kind: Type.Union([
    Type.Literal('single_select'),
    Type.Literal('multi_select'),
    Type.Literal('image_select'),
    Type.Literal('text')
  ]),
  label: Type.String({ description: 'Question text shown to the user', maxLength: 2000 }),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        label: Type.String(),
        hint: Type.Optional(Type.String())
      }),
      { description: 'single_select / multi_select: 2-12 options' }
    )
  ),
  imageOptions: Type.Optional(
    Type.Array(
      Type.Object({
        nodeId: Type.String({ description: 'Canvas node id to render as thumbnail' }),
        label: Type.Optional(Type.String())
      }),
      { description: 'image_select only: 1-12 canvas-node candidates' }
    )
  ),
  required: Type.Optional(Type.Boolean({ description: 'Default true' })),
  notes: Type.Optional(
    Type.Boolean({ description: 'Wave 2 #8: include a per-question notes input' })
  )
})

export function createAskUserQuestionTool(deps: AskUserQuestionToolDeps) {
  const makeId = deps.makeId ?? ((toolCallId: string): string => `ask-${toolCallId}`)
  return defineTool({
    name: 'ask_user_question',
    label: 'Ask User Question',
    description: ASK_USER_QUESTION_DESCRIPTION,
    // 2026-09-15：顺序约束——挂起期不能与其他工具并行跑（同一 agent run 串行）
    executionMode: 'sequential' as const,
    parameters: Type.Object({
      questions: Type.Array(QUESTION_SCHEMA, { description: '1-8 form questions' })
    }),
    async execute(toolCallId, params, signal): Promise<AgentToolResult<Record<string, unknown>>> {
      // Wave 2 #5：先归一后校验——消除 `\"Other\\r\"` 类行尾绕过、合并重复题
      const normalized = normalizeAskParams(params)
      const validated = checkReservedLabels(validateAskUserQuestions(normalized))
      if ('error' in validated) {
        return toToolResult({ error: validated.error, message: validated.message })
      }

      const formId = makeId(toolCallId)
      const { promise, alreadyPending } = deps.store.register(deps.sessionId, formId, signal)
      if (alreadyPending) {
        // 同 session 上一表单未答 → 硬错误结果（execute 不挂起）；模型应停手
        return toToolResult({
          error: 'ask_pending',
          message: 'A previous form is still awaiting the user answer.'
        })
      }
      deps.onPendingRegistered?.(formId)
      const questions = validated.questions

      // 挂起 → resolve/reject → 构造工具结果
      const payload = await promise
      if (payload.skip) {
        const details: AskAnswerDetails = { formId, status: 'skipped', questions }
        const text =
          `The user skipped the form (formId=${formId}). ` +
          'Proceed with your best judgment and do not re-ask the same questions unless necessary.'
        return { content: [{ type: 'text', text }], details }
      }
      const answers = payload.answers ?? {}
      const globalNotes = typeof payload.notes === 'string' ? payload.notes : undefined
      const details: AskAnswerDetails = {
        formId,
        status: 'answered',
        questions,
        answers,
        ...(globalNotes ? { notes: globalNotes } : {})
      }
      const envelopeJSON = serializeAskAnswer(formId, {
        aborted: false,
        answers,
        ...(globalNotes ? { notes: globalNotes } : {})
      })
      const text =
        `The user answered the form (formId=${formId}).\n` +
        'Answer envelope JSON (per-question; "__freeText" entries carry freeText as a first-class answer; multi_select answers use {values:[...]}; per-question notes appear under "notes"):\n' +
        envelopeJSON
      return { content: [{ type: 'text', text }], details }
    }
  })
}
