/**
 * ask_user_question 工具参数执行前归一（2026-09-15 决策单 §4 Phase 1 第 5 项，
 * rpiv 移植器官——validate-questionnaire.ts / normalize-params.ts）。
 *
 * 归一是纯数据变换，不报错；下游 validateAskUserQuestions 看到的就是已
 * 归一的数据（消除 `\"Other\\r\"` 类行尾绕过）。
 *
 * 覆盖：
 *  - questions[].label / options[].label / options[].hint 内 \\r\\n → \\n
 *  - label 内连续空白 collapse 为单空格 + trim（去首尾 + 压中段）
 *  - label 归一后完全相同的重复题去重，保留首现
 *    （保留重复 id 的合法副本，使后续 validate 不因 duplicate id 报错）
 *
 * 纯函数、零依赖——bun 直接可测。
 */

const WHITESPACE_RUN = /\s+/g

/** 把空白 run 压成单空格并 trim；空串归一为 ''（不报错） */
export function collapseWhitespace(input: string): string {
  return input.replace(WHITESPACE_RUN, ' ').trim()
}

/** 行尾规范化：\\r\\n → \\n（兼容纯 \\r 行尾情况——保留单 \\n） */
export function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * 单题 label 归一——同时做行尾规范化 + 空白 collapse。
 * options[].label / options[].hint 也走这条（hint 不报空，collapse 即可）。
 */
export function normalizeLabel(label: string): string {
  return collapseWhitespace(normalizeLineEndings(label))
}

/**
 * 对原始工具参数做执行前归一。
 *
 * 规则：
 *  1. questions[].label / options[].label / options[].hint 行尾规范化
 *     + 空白 collapse；
 *  2. label 归一后（collapse + trim）完全相同的题去重保留首现。
 *
 * 入参为 validateAskUserQuestions 同一形态的原始 payload；非对象视为空
 * （与 validate 兜底同律），不报错——validate 兜底负责边界。
 */
export function normalizeAskParams(params: unknown): unknown {
  if (!isRecord(params)) return params
  const list = params.questions
  if (!Array.isArray(list)) return params

  const seenLabels = new Set<string>()
  const out: unknown[] = []
  for (const item of list) {
    if (!isRecord(item)) {
      out.push(item)
      continue
    }
    const normLabel = typeof item.label === 'string' ? normalizeLabel(item.label) : item.label
    const next: Record<string, unknown> = { ...item, label: normLabel }
    if (Array.isArray(item.options)) {
      next.options = item.options.map((opt) => {
        if (!isRecord(opt)) return opt
        const o: Record<string, unknown> = { ...opt }
        if (typeof opt.label === 'string') o.label = normalizeLabel(opt.label)
        if (typeof opt.hint === 'string') o.hint = normalizeLabel(opt.hint)
        return o
      })
    }
    if (typeof normLabel === 'string' && normLabel.length > 0) {
      if (seenLabels.has(normLabel)) continue
      seenLabels.add(normLabel)
    }
    out.push(next)
  }
  return { ...params, questions: out }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
