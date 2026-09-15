/**
 * ask_user_question 卡片答案摘要纯函数（labelForOption + summarizeAnswer 搬迁）。
 *
 * 原样迁移自卡片 427-455 行：
 *  - labelForOption：image_select 用 imageOptions.find；其它 kind 用 options.find；
 *    找不到回落 optionId；FREE_TEXT_OPTION_ID 一律走「其他」i18n 文案。
 *  - summarizeAnswer：multi_select 走 values 数组（含「其他」时优先 freeText 否则
 *    「其他」文案）；其它 kind 按 value/freeText 解析；空值 → 空串。
 *
 * 注：i18n 文案从外部注入（avoid pulling vue/Composables into a pure module）；
 * 卡片在调用点把 askDialogs.value 传入即可。
 */
import {
  FREE_TEXT_OPTION_ID,
  type AskQuestionAnswer,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'

/** i18n 文案最小子集（卡片调用时透传 useForkAsk().value 的相关 key） */
export interface AskDialogStrings {
  askOtherOption: string
}

export function labelForOption(
  question: AskQuestionSpec,
  optionId: string,
  strings: AskDialogStrings
): string {
  if (optionId === FREE_TEXT_OPTION_ID) return strings.askOtherOption
  if (question.kind === 'image_select') {
    const opt = question.imageOptions?.find((o) => o.nodeId === optionId)
    return opt?.label ?? optionId
  }
  const opt = question.options?.find((o) => o.id === optionId)
  return opt?.label ?? optionId
}

export function summarizeAnswer(
  question: AskQuestionSpec,
  answer: AskQuestionAnswer | undefined,
  strings: AskDialogStrings
): string {
  if (!answer) return ''
  if (question.kind === 'multi_select' && Array.isArray(answer.values)) {
    if (answer.values.length === 0) return ''
    const labels = answer.values.map((v) =>
      v === FREE_TEXT_OPTION_ID
        ? answer.freeText?.trim() || strings.askOtherOption
        : labelForOption(question, v, strings)
    )
    return labels.join('、')
  }
  if (answer.value === FREE_TEXT_OPTION_ID) {
    return answer.freeText?.trim() || strings.askOtherOption
  }
  if (typeof answer.value === 'string') {
    return answer.value === '' ? '' : labelForOption(question, answer.value, strings)
  }
  return answer.freeText?.trim() ?? ''
}
