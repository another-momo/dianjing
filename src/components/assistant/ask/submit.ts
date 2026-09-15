/**
 * ask_user_question 卡片提交归一（normalizeForSubmit 家族纯函数搬迁）。
 *
 * 原样迁移自卡片 306-375 行：
 *  - text → { value }（trim）；空白丢弃
 *  - multi_select → { values } 数组（trim 后非空白项）；空白值/空数组丢弃
 *  - 「其他」→ { value: FREE_TEXT_OPTION_ID, freeText }；freeText 空白则视为未作答（不落键）
 *  - 普通选项 → { value }
 *  - notes 字段在该题 spec.notes=true 时采集；空白丢弃（波2 修复原样保留）
 *
 * 零 vue / 零 DOM 依赖，bun 直测。
 */
import {
  FREE_TEXT_OPTION_ID,
  type AskQuestionAnswer,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'

/** 单题是否至少有一个有效字段（与 core normalizeQuestionAnswer 同律） */
export function hasContent(answer: AskQuestionAnswer): boolean {
  return answer.value !== undefined || answer.values !== undefined || answer.notes !== undefined
}

/** 单题归一（每 kind 独立分支，避免单函数复杂度爆栈） */
function normalizeSingle(question: AskQuestionSpec, answer: AskQuestionAnswer): AskQuestionAnswer {
  if (question.kind === 'text') return normalizeText(answer)
  if (question.kind === 'multi_select') return normalizeMulti(answer)
  if (answer.value === FREE_TEXT_OPTION_ID) return normalizeFreeText(answer)
  return normalizeSingleSelect(answer)
}

function normalizeText(answer: AskQuestionAnswer): AskQuestionAnswer {
  const value = answer.value?.trim() ?? ''
  const out: AskQuestionAnswer = {}
  if (value) out.value = value
  return out
}

function normalizeSingleSelect(answer: AskQuestionAnswer): AskQuestionAnswer {
  const out: AskQuestionAnswer = {}
  if (typeof answer.value === 'string' && answer.value !== '') out.value = answer.value
  return out
}

function normalizeFreeText(answer: AskQuestionAnswer): AskQuestionAnswer {
  const out: AskQuestionAnswer = {}
  const freeText = answer.freeText?.trim() ?? ''
  if (freeText) {
    out.value = FREE_TEXT_OPTION_ID
    out.freeText = freeText
  }
  return out
}

function normalizeMulti(answer: AskQuestionAnswer): AskQuestionAnswer {
  const out: AskQuestionAnswer = {}
  const rawValues = Array.isArray(answer.values) ? answer.values : []
  const cleaned = rawValues.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  if (cleaned.length > 0) out.values = cleaned
  if (!cleaned.includes(FREE_TEXT_OPTION_ID)) return out
  const freeText = answer.freeText?.trim() ?? ''
  if (freeText) {
    out.freeText = freeText
    return out
  }
  // freeText 空白：清掉 FREE_TEXT_OPTION_ID 让必填校验拦下
  const filtered = cleaned.filter((v) => v !== FREE_TEXT_OPTION_ID)
  if (filtered.length > 0) out.values = filtered
  else delete out.values
  return out
}

/** 整表归一（卡片 emit submit 前的最后一道关口） */
export function normalizeForSubmit(
  questions: AskQuestionSpec[],
  answers: Record<string, AskQuestionAnswer>
): Record<string, AskQuestionAnswer> {
  const normalized: Record<string, AskQuestionAnswer> = {}
  for (const question of questions) {
    const answer = answers[question.id]
    if (!answer) continue
    const out = normalizeSingle(question, answer)
    // notes 与作答解耦：spec.notes=true 时采集，trim 非空白才携带
    if (question.notes === true) {
      const notes = answer.notes?.trim() ?? ''
      if (notes) out.notes = notes
    }
    // 至少有一个有效字段才落键
    if (hasContent(out)) normalized[question.id] = out
  }
  return normalized
}
