import { describe, expect, test } from 'bun:test'
/**
 * T56（Phase 3 W2/T-B5）：ask_user_question tool part 跨重载存续钉扎——
 * pi JSONL 会话文件经 readPiHistoryFile 恢复后，tool part 的 input.questions
 * 完整、output 折叠 awaiting 信封 details（formId/status）；后续用户消息里的
 * 答案信封文本原样存续（answeredFormIds 派生的输入）。
 * T95：新格式（per-question { value } / __freeText）与旧格式（T83 全局 freeText）
 * 双通道 round-trip——旧会话信封带 questions 解析自动迁移钉扎。
 *
 * 先例：tests/engine/rebuild/image-gen/orchestration.test.ts 的 `@/app/...`
 * 导入口径；会话文件格式 = pi parseSessionEntries 的 JSONL（header + message 行）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FREE_TEXT_OPTION_ID,
  parseAskAnswer,
  serializeAskAnswer,
  validateAskUserQuestions
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'

import { readPiHistoryFile } from '@/app/ai/pi-backend/history'

const QUESTIONS = [
  {
    id: 'hero_pick',
    kind: 'image_select',
    label: '选一帧作为 hero 候选',
    imageOptions: [{ nodeId: '0:11', label: '候选 A' }, { nodeId: '0:12' }]
  },
  {
    id: 'tone',
    kind: 'single_select',
    label: '整体调性',
    options: [
      { id: 'warm', label: '暖色', hint: '亲和' },
      { id: 'cold', label: '冷色' }
    ]
  },
  { id: 'note', kind: 'text', label: '补充说明', required: false }
]

const AWAITING_DETAILS = {
  formId: 'form-roundtrip-000000',
  status: 'awaiting_user',
  questions: QUESTIONS
}

/** QUESTIONS 经 core 校验归一的 AskQuestionSpec[]（parseAskAnswer 迁移参） */
const QUESTIONS_PARSED = (() => {
  const validated = validateAskUserQuestions({ questions: QUESTIONS })
  if ('error' in validated) throw new Error(validated.message)
  return validated.questions
})()

function sessionFile(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 't56-history-'))
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return file
}

function messageEntry(id: string, parentId: string | null, message: unknown) {
  return { type: 'message', id, parentId, timestamp: '2026-09-01T00:00:00Z', message }
}

describe('readPiHistoryFile × ask_user_question round-trip', () => {
  test('tool part 重载后 input.questions 完整 + output 折叠 awaiting details', () => {
    const file = sessionFile([
      { type: 'session', id: 's-t56', timestamp: '2026-09-01T00:00:00Z', cwd: '/tmp' },
      messageEntry('m1', null, {
        role: 'user',
        content: [{ type: 'text', text: '帮我设计一个营销页' }]
      }),
      messageEntry('m2', 'm1', {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-ask-1',
            name: 'ask_user_question',
            arguments: { questions: QUESTIONS }
          }
        ]
      }),
      messageEntry('m3', 'm2', {
        role: 'toolResult',
        toolCallId: 'call-ask-1',
        content: [{ type: 'text', text: '表单已渲染给用户（formId=form-roundtrip-000000）' }],
        details: AWAITING_DETAILS,
        isError: false
      })
    ])

    const messages = readPiHistoryFile(file)
    expect(messages).toHaveLength(2)
    const assistant = messages[1]
    expect(assistant.role).toBe('assistant')

    const part = assistant.parts[0] as {
      type: string
      toolCallId: string
      state: string
      input: { questions: unknown }
      output: { formId?: string; status?: string; questions?: unknown }
    }
    expect(part.type).toBe('tool-ask_user_question')
    expect(part.toolCallId).toBe('call-ask-1')
    expect(part.state).toBe('output-available')
    // input.questions 跨重载完整（卡片渲染数据源）
    expect(part.input.questions).toEqual(QUESTIONS)
    // output = details（mapping.ts 骑 details 语义的镜像）
    expect(part.output.formId).toBe('form-roundtrip-000000')
    expect(part.output.status).toBe('awaiting_user')
    expect(part.output.questions).toEqual(QUESTIONS)
  })

  test('答案信封用户消息原样存续，parseAskAnswer 可还原 formId（answeredFormIds 输入）', () => {
    const envelope = serializeAskAnswer('form-roundtrip-000000', {
      aborted: false,
      answers: { hero_pick: { value: '0:11' }, tone: { value: 'warm' } }
    })
    const file = sessionFile([
      { type: 'session', id: 's-t56', timestamp: '2026-09-01T00:00:00Z', cwd: '/tmp' },
      messageEntry('m1', null, {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-ask-1',
            name: 'ask_user_question',
            arguments: { questions: QUESTIONS }
          }
        ]
      }),
      messageEntry('m2', 'm1', {
        role: 'toolResult',
        toolCallId: 'call-ask-1',
        content: [{ type: 'text', text: '表单已渲染' }],
        details: AWAITING_DETAILS,
        isError: false
      }),
      messageEntry('m3', 'm2', {
        role: 'user',
        content: [{ type: 'text', text: envelope }]
      })
    ])

    const messages = readPiHistoryFile(file)
    expect(messages).toHaveLength(2)
    const user = messages[1]
    expect(user.role).toBe('user')
    const text = user.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('')
    const parsed = parseAskAnswer(text)
    expect(parsed).toEqual({
      formId: 'form-roundtrip-000000',
      aborted: false,
      answers: { hero_pick: { value: '0:11' }, tone: { value: 'warm' } }
    })
  })

  test('per-question「其他」（T95）：__freeText 作答信封跨重载存续并还原', () => {
    const envelope = serializeAskAnswer('form-roundtrip-000000', {
      aborted: false,
      answers: {
        tone: { value: FREE_TEXT_OPTION_ID, freeText: '候选都不满意，想要更简洁的构图' }
      }
    })
    const file = sessionFile([
      { type: 'session', id: 's-t95', timestamp: '2026-09-04T00:00:00Z', cwd: '/tmp' },
      messageEntry('m1', null, {
        role: 'user',
        content: [{ type: 'text', text: envelope }]
      })
    ])

    const messages = readPiHistoryFile(file)
    expect(messages).toHaveLength(1)
    const text = messages[0].parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('')
    expect(parseAskAnswer(text)).toEqual({
      formId: 'form-roundtrip-000000',
      aborted: false,
      answers: {
        tone: { value: FREE_TEXT_OPTION_ID, freeText: '候选都不满意，想要更简洁的构图' }
      }
    })
  })

  test('旧格式（T83 全局 freeText）：历史会话信封跨重载存续，带 questions 解析自动迁移', () => {
    // 旧会话文件里的信封是 T83 形态（裸 string 值 + 全局 freeText）——手写原文钉扎兼容
    const legacyEnvelope = `[表单作答 formId=form-roundtrip-000000]\n${JSON.stringify({
      aborted: false,
      answers: { tone: 'cold' },
      freeText: '候选都不满意，想要更简洁的构图'
    })}`
    const file = sessionFile([
      { type: 'session', id: 's-t83', timestamp: '2026-09-02T00:00:00Z', cwd: '/tmp' },
      messageEntry('m1', null, {
        role: 'user',
        content: [{ type: 'text', text: legacyEnvelope }]
      })
    ])

    const messages = readPiHistoryFile(file)
    expect(messages).toHaveLength(1)
    const text = messages[0].parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('')
    // 传 questions → 全局 freeText 归到首个未作答选择类题（hero_pick；tone 已答、note 是 text）
    const migrated = parseAskAnswer(text, QUESTIONS_PARSED)
    expect(migrated).toEqual({
      formId: 'form-roundtrip-000000',
      aborted: false,
      answers: {
        tone: { value: 'cold' },
        hero_pick: {
          value: FREE_TEXT_OPTION_ID,
          freeText: '候选都不满意，想要更简洁的构图'
        }
      }
    })
    // 不传 questions → 不猜归属，legacy freeText 原样保留（无损）
    expect(parseAskAnswer(text)).toEqual({
      formId: 'form-roundtrip-000000',
      aborted: false,
      answers: { tone: { value: 'cold' } },
      freeText: '候选都不满意，想要更简洁的构图'
    })
  })
})
