/**
 * ask_user_question rpiv 式结构化校验（2026-09-15 决策单 §4 Phase 1 第 5 项，
 * 与 validateAskUserQuestions 同一 AskValidation 返回类型，不另起异常体系）。
 *
 * 在既有校验（id/label/kind/options 边界）之上补：
 *  - 保留标签拦截（reserved_label）：option.id === '__freeText' → 拒
 *    （防止用户标签覆盖 UI 哨兵 / 「其他」选项；label 同名暂不拦
 *    ——id 是路由键，label 重复可同名不同 id）
 *  - multi_select 答案面校验辅助：isValidMultiAnswer(answer, spec)
 *
 * 纯函数、零依赖——bun 直接可测；纯校验不报错结构化，错误码沿用
 * validateAskUserQuestions 既有 `{ error, message }` 形态。
 */

import {
  FREE_TEXT_OPTION_ID,
  type AskQuestionAnswer,
  type AskQuestionSpec,
  type AskValidation
} from './ask-user-question'

/**
 * UI / 路由保留的 option id 集合——禁止用户标签使用。
 * 当前仅 FREE_TEXT_OPTION_ID 一个哨兵；扩展时按需追加。
 */
export const RESERVED_OPTION_IDS: ReadonlySet<string> = new Set([FREE_TEXT_OPTION_ID])

/**
 * 校验 questions 内 option 是否使用了保留 id——返回首个冲突或 null。
 * 仅检 options（image_select 不存在 options 字段——天然豁免；multi_select
 * 与 single_select 共用 options 字段）。
 */
export function findReservedOptionId(question: AskQuestionSpec): string | null {
  if (!question.options) return null
  for (const opt of question.options) {
    if (RESERVED_OPTION_IDS.has(opt.id)) return opt.id
  }
  return null
}

/**
 * multi_select 答案面形态校验——用于执行后 / 落库前的二次把关。
 *
 * 规则：
 *  - answer 必须有 values 且为非空数组（每项 string）
 *  - values 数量在 1..spec.options.length 之间
 *  - 每项 id 必须 ∈ spec.options.id 集，或 === FREE_TEXT_OPTION_ID
 *  - 含 FREE_TEXT_OPTION_ID 时，freeText 必须非空白
 */
export function isValidMultiAnswer(
  answer: AskQuestionAnswer | undefined,
  spec: AskQuestionSpec
): boolean {
  if (!answer) return false
  if (!Array.isArray(answer.values) || answer.values.length === 0) return false
  const opts = spec.options ?? []
  if (answer.values.length > opts.length) return false
  const ids = new Set(opts.map((o) => o.id))
  let hasFreeText = false
  for (const v of answer.values) {
    if (typeof v !== 'string') return false
    if (v === FREE_TEXT_OPTION_ID) {
      hasFreeText = true
      continue
    }
    if (!ids.has(v)) return false
  }
  if (hasFreeText) {
    return typeof answer.freeText === 'string' && answer.freeText.trim() !== ''
  }
  return true
}

/**
 * 在 validateAskUserQuestions 同一返回类型上叠加保留标签校验。
 * 不重新跑全部边界——只做 reserved 选项兜底（call site 先跑
 * validateAskUserQuestions，失败即返回；通过后再叠此层）。
 */
export function checkReservedLabels(validation: AskValidation): AskValidation {
  if ('error' in validation) return validation
  for (const q of validation.questions) {
    const reserved = findReservedOptionId(q)
    if (reserved !== null) {
      return {
        error: 'reserved_label',
        message: `question "${q.id}" option id "${reserved}" is reserved by the UI`
      }
    }
  }
  return validation
}
