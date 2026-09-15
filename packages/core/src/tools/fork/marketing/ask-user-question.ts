/**
 * T56（Phase 3 W2/T-B5）：ask_user_question 表单定义纯函数层——全新建
 * （旧仓无先例，T56-plan §1 定谳 1 双件布局的 core 件）。
 *
 * 职责：
 *  - 表单定义校验（validateAskUserQuestions）：questions 1..8、id 唯一非空、
 *    label 非空、kind 四值互斥（single_select/multi_select → options 2..12
 *    且无 imageOptions；image_select → imageOptions 1..12 且无 options；
 *    text 两者皆无）、required 缺省 true、notes（波2 #8）可选布尔。
 *    失败返回 { error, message }，不 throw——
 *    pi 后端 execute 与前端卡片渲染共用本层。
 *  - formId 生成（makeFormId）：`form-<时间戳36进制>-<随机6位>`，now/rand 可注入
 *    （测试确定性）。
 *  - 答案信封序列化/解析（serializeAskAnswer/parseAskAnswer）：用户消息文本
 *    首行 `[表单作答 formId=…]` / `[表单跳过 formId=…]` + 次行 JSON。
 *    作答分支 answers 为 per-question 结构（T95，审查文档 §3.3）：
 *    `{ qid: { value } }` 普通选项/文本，`{ qid: { value: '__freeText', freeText } }`
 *    表示选了「其他」选项（FREE_TEXT_OPTION_ID）——freeText 不再是全局字段，
 *    而是每个选择类问题的自包含一等答案；跳过分支 freeText = 跳过理由（不动）。
 *    解析容错——坏 JSON/缺标记行/类型不符 → null；旧格式（T83：值是裸 string /
 *    全局 freeText 键）自动迁移——string → { value }，全局 freeText 在传入
 *    questions 时归到首个未作答选择类问题的「其他」，无法归因则原样保留在
 *    解析结果的 legacy freeText 字段（无损不覆盖，审查文档 §5.3/§6.2 落地口径）。
 *  - 作答校验纯函数（isAskQuestionAnswered/missingRequiredAskAnswers）：
 *    「其他」需 freeText 非空白才算有效作答（审查文档 §4.4/§5.2），前端卡片共用。
 *
 * 纯函数、零 figma/pi 依赖——bun 直接可测。
 */

export type AskQuestionKind = 'single_select' | 'multi_select' | 'image_select' | 'text'

export interface AskSelectOption {
  id: string
  label: string
  hint?: string
}

export interface AskImageOption {
  nodeId: string
  label?: string
}

/** 校验归一后的表单题（required 已填缺省值 true） */
export interface AskQuestionSpec {
  id: string
  kind: AskQuestionKind
  label: string
  required: boolean
  options?: AskSelectOption[]
  imageOptions?: AskImageOption[]
  /** 波2 #8：该题附带笔记输入区（与作答解耦，不影响 required 判定） */
  notes?: boolean
}

export type AskValidation = { questions: AskQuestionSpec[] } | { error: string; message: string }

export const ASK_QUESTION_LIMITS = {
  questions: { min: 1, max: 8 },
  options: { min: 2, max: 12 },
  imageOptions: { min: 1, max: 12 },
  labelMaxLength: 2000
} as const

function fail(error: string, message: string): { error: string; message: string } {
  return { error, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function validateSelectOptions(
  questionId: string,
  value: unknown
): AskSelectOption[] | { error: string; message: string } {
  if (
    !Array.isArray(value) ||
    value.length < ASK_QUESTION_LIMITS.options.min ||
    value.length > ASK_QUESTION_LIMITS.options.max
  ) {
    return fail(
      'options_bounds',
      `question "${questionId}" (single_select) needs 2-12 options, got ${Array.isArray(value) ? value.length : typeof value}`
    )
  }
  const seen = new Set<string>()
  const options: AskSelectOption[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return fail('option_shape', `question "${questionId}" options[${index}] must be an object`)
    }
    const id = nonEmptyString(item.id)
    const label = nonEmptyString(item.label)
    if (!id || !label) {
      return fail(
        'option_fields',
        `question "${questionId}" options[${index}] needs non-empty id and label`
      )
    }
    if (seen.has(id)) {
      return fail('option_id', `question "${questionId}" has duplicate option id "${id}"`)
    }
    seen.add(id)
    const hint = nonEmptyString(item.hint)
    options.push({ id, label, ...(hint ? { hint } : {}) })
  }
  return options
}

function validateImageOptions(
  questionId: string,
  value: unknown
): AskImageOption[] | { error: string; message: string } {
  if (
    !Array.isArray(value) ||
    value.length < ASK_QUESTION_LIMITS.imageOptions.min ||
    value.length > ASK_QUESTION_LIMITS.imageOptions.max
  ) {
    return fail(
      'image_options_bounds',
      `question "${questionId}" (image_select) needs 1-12 imageOptions, got ${Array.isArray(value) ? value.length : typeof value}`
    )
  }
  const imageOptions: AskImageOption[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return fail(
        'image_option_shape',
        `question "${questionId}" imageOptions[${index}] must be an object`
      )
    }
    const nodeId = nonEmptyString(item.nodeId)
    if (!nodeId) {
      return fail(
        'image_option_node',
        `question "${questionId}" imageOptions[${index}] needs a non-empty nodeId`
      )
    }
    const label = nonEmptyString(item.label)
    imageOptions.push({ nodeId, ...(label ? { label } : {}) })
  }
  return imageOptions
}

const ASK_QUESTION_KINDS: ReadonlySet<string> = new Set([
  'single_select',
  'multi_select',
  'image_select',
  'text'
])

function validateQuestion(
  item: unknown,
  index: number,
  seenIds: Set<string>
): AskQuestionSpec | { error: string; message: string } {
  if (!isRecord(item)) {
    return fail('question_shape', `questions[${index}] must be an object`)
  }
  const id = nonEmptyString(item.id)
  if (!id) return fail('question_id', `questions[${index}].id must be a non-empty string`)
  if (seenIds.has(id)) return fail('question_id', `duplicate question id "${id}"`)
  seenIds.add(id)

  const label = nonEmptyString(item.label)
  if (!label) return fail('question_label', `question "${id}" needs a non-empty label`)
  if (label.length > ASK_QUESTION_LIMITS.labelMaxLength) {
    return fail(
      'question_label_too_long',
      `question "${id}" label exceeds ${ASK_QUESTION_LIMITS.labelMaxLength} chars (got ${label.length})`
    )
  }

  const kind = item.kind
  if (typeof kind !== 'string' || !ASK_QUESTION_KINDS.has(kind)) {
    return fail(
      'question_kind',
      `question "${id}" kind must be single_select | multi_select | image_select | text`
    )
  }
  const required = item.required !== false
  // 复杂度纪律：notes 散布一次计算（三处 kind 返回共用），site 零三元
  const notesProp: { notes?: true } = item.notes === true ? { notes: true } : {}

  if (kind === 'single_select' || kind === 'multi_select') {
    if (item.imageOptions !== undefined) {
      return fail('kind_mixed_fields', `question "${id}" (${kind}) must not carry imageOptions`)
    }
    const options = validateSelectOptions(id, item.options)
    if ('error' in options) return options
    return { id, kind, label, required, options, ...notesProp }
  }
  if (kind === 'image_select') {
    if (item.options !== undefined) {
      return fail('kind_mixed_fields', `question "${id}" (image_select) must not carry options`)
    }
    const imageOptions = validateImageOptions(id, item.imageOptions)
    if ('error' in imageOptions) return imageOptions
    return { id, kind, label, required, imageOptions, ...notesProp }
  }
  if (item.options !== undefined || item.imageOptions !== undefined) {
    return fail('kind_mixed_fields', `question "${id}" (text) must not carry options`)
  }
  return { id, kind, label, required, ...notesProp }
}

/**
 * 校验并归一表单定义（required 缺省补 true，选项 trim 后回显）。
 * 输入为原始工具参数（{ questions: [...] }），失败返回 { error, message }。
 */
export function validateAskUserQuestions(input: unknown): AskValidation {
  const raw = isRecord(input) ? input : {}
  const list = raw.questions
  if (
    !Array.isArray(list) ||
    list.length < ASK_QUESTION_LIMITS.questions.min ||
    list.length > ASK_QUESTION_LIMITS.questions.max
  ) {
    return fail(
      'questions_bounds',
      `questions must be an array of 1-8 items, got ${Array.isArray(list) ? list.length : typeof list}`
    )
  }

  const seenIds = new Set<string>()
  const questions: AskQuestionSpec[] = []
  for (const [index, item] of list.entries()) {
    const question = validateQuestion(item, index, seenIds)
    if ('error' in question) return question
    questions.push(question)
  }
  return { questions }
}

// ── formId ──

export const FORM_ID_PATTERN = /^form-[0-9a-z]+-[0-9a-z]{6}$/

/** `form-<时间戳36进制>-<随机6位>`；now/rand 可注入（测试确定性） */
export function makeFormId(now: () => number = Date.now, rand: () => number = Math.random): string {
  const stamp = Math.max(0, Math.floor(now())).toString(36)
  const random = Math.floor(rand() * 36 ** 6)
    .toString(36)
    .padStart(6, '0')
  return `form-${stamp}-${random}`
}

// ── 答案信封（用户消息文本：首行标记 + 次行 JSON） ──

const ANSWER_MARKER = /^\[表单作答 formId=([^\]\s]+)\]\s*$/
const SKIP_MARKER = /^\[表单跳过 formId=([^\]\s]+)\]\s*$/

/** 特殊选项值：选择类问题的「其他」选项 id（T95，审查文档 §3.3） */
export const FREE_TEXT_OPTION_ID = '__freeText'

/**
 * per-question 作答（T95）：普通选项/文本 → { value }；
 * 「其他」→ { value: FREE_TEXT_OPTION_ID, freeText }（freeText 非空白才算有效作答）。
 * 波2 增量：multi_select → { values: 选项id数组 }（含「其他」时数组含
 * FREE_TEXT_OPTION_ID 且 freeText 非空白才算有效）；notes = 该题笔记
 * （与作答解耦，仅在该题 spec.notes=true 时由 UI 采集）。
 */
export interface AskQuestionAnswer {
  value?: string
  values?: string[]
  freeText?: string
  notes?: string
}

export type AskAnswerPayload =
  | { aborted: false; answers: Record<string, AskQuestionAnswer>; notes?: string }
  | { aborted: true; freeText: string }

/** 前端提交路径用的完整载荷（formId + 判别联合） */
export type AskFormSubmission = { formId: string } & AskAnswerPayload

export function serializeAskAnswer(formId: string, payload: AskAnswerPayload): string {
  const marker = payload.aborted ? `[表单跳过 formId=${formId}]` : `[表单作答 formId=${formId}]`
  return `${marker}\n${JSON.stringify(payload)}`
}

/**
 * 解析结果：作答分支带可选 legacy freeText——仅旧格式（T83 全局 freeText）
 * 无法归因到选择类问题时原样保留（无损不覆盖；见 parseAskAnswer 迁移段）
 */
export type ParsedAskAnswer =
  | {
      formId: string
      aborted: false
      answers: Record<string, AskQuestionAnswer>
      freeText?: string
      /** 波2 #9：提交时附加的全局备注（非空白才出现） */
      notes?: string
    }
  | { formId: string; aborted: true; freeText: string }

/** 单键归一：旧格式裸 string → { value }；新格式对象取非空白 value/values/freeText/notes；空键丢弃 */
function normalizeQuestionAnswer(value: unknown): AskQuestionAnswer | null {
  if (typeof value === 'string') {
    return value.trim() !== '' ? { value } : null
  }
  if (!isRecord(value)) return null
  const answer: AskQuestionAnswer = {}
  if (typeof value.value === 'string' && value.value.trim() !== '') answer.value = value.value
  if (Array.isArray(value.values)) {
    const list = value.values.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    if (list.length > 0) answer.values = list
  }
  if (typeof value.freeText === 'string' && value.freeText.trim() !== '') {
    answer.freeText = value.freeText
  }
  if (typeof value.notes === 'string' && value.notes.trim() !== '') {
    answer.notes = value.notes
  }
  return answer.value !== undefined ||
    answer.values !== undefined ||
    answer.freeText !== undefined ||
    answer.notes !== undefined
    ? answer
    : null
}

/**
 * 旧格式（T83）全局 freeText 迁移（审查文档 §5.3/§6.2）：给了 questions 归到首个
 * 未作答的选择类问题的「其他」；无法归因（未传 questions / 选择类问题全已答 /
 * 全是 text 题）→ 返回原文由调用方保留，不覆盖已选选项（无损优先于示意代码的
 * 无条件覆盖）。
 */
function migrateLegacyFreeText(
  answers: Record<string, AskQuestionAnswer>,
  freeText: string,
  questions?: AskQuestionSpec[]
): string | undefined {
  if (!questions) return freeText
  const target = questions.filter((q) => q.kind !== 'text').find((q) => !(q.id in answers))
  if (!target) return freeText
  answers[target.id] = { value: FREE_TEXT_OPTION_ID, freeText }
  return undefined
}

/**
 * 解析答案信封——只认首行标记（ChatPanel answeredFormIds 派生同律）；
 * 坏 JSON、缺标记、aborted 与标记不符、JSON 非对象 → null（容错不 throw）。
 * questions 可选：传入时旧格式全局 freeText 参与归因迁移（见 migrateLegacyFreeText）。
 */
export function parseAskAnswer(
  text: string,
  questions?: AskQuestionSpec[]
): ParsedAskAnswer | null {
  const newline = text.indexOf('\n')
  if (newline === -1) return null
  const firstLine = text.slice(0, newline)
  const answerMatch = ANSWER_MARKER.exec(firstLine)
  const skipMatch = SKIP_MARKER.exec(firstLine)
  if (!answerMatch && !skipMatch) return null
  const formId = answerMatch?.[1] ?? skipMatch?.[1] ?? ''
  const aborted = skipMatch !== null

  let payload: unknown
  try {
    payload = JSON.parse(text.slice(newline + 1))
  } catch {
    return null
  }
  if (!isRecord(payload)) return null
  if (payload.aborted !== aborted) return null

  if (aborted) {
    return {
      formId,
      aborted: true,
      freeText: typeof payload.freeText === 'string' ? payload.freeText : ''
    }
  }
  const answers: Record<string, AskQuestionAnswer> = {}
  if (isRecord(payload.answers)) {
    for (const [key, value] of Object.entries(payload.answers)) {
      const answer = normalizeQuestionAnswer(value)
      if (answer) answers[key] = answer
    }
  }
  const parsed: ParsedAskAnswer = { formId, aborted: false, answers }
  // 波2 #9：全局备注（非空白才收；nonEmptyString 调用点单分支，复杂度纪律）
  const globalNotes = nonEmptyString(payload.notes)
  if (globalNotes !== null) parsed.notes = globalNotes
  // 旧格式迁移（T95）：全局 freeText 非空白才处理；空白直接丢弃（T83 同律）
  if (typeof payload.freeText === 'string' && payload.freeText.trim() !== '') {
    const legacy = migrateLegacyFreeText(answers, payload.freeText, questions)
    if (legacy !== undefined) parsed.freeText = legacy
  }
  return parsed
}

// ── 作答校验（前端卡片共用；审查文档 §4.4/§5.2） ──

/**
 * 单题是否已有效作答：text → value 非空白；multi_select → values 非空
 * （含「其他」时 freeText 非空白）；选择类普通选项 → value 非空且非
 * FREE_TEXT_OPTION_ID；「其他」→ value === FREE_TEXT_OPTION_ID 且 freeText 非空白。
 */
export function isAskQuestionAnswered(
  question: AskQuestionSpec,
  answer: AskQuestionAnswer | undefined
): boolean {
  if (!answer) return false
  if (question.kind === 'text') {
    return typeof answer.value === 'string' && answer.value.trim() !== ''
  }
  if (question.kind === 'multi_select') {
    if (!Array.isArray(answer.values) || answer.values.length === 0) return false
    if (answer.values.includes(FREE_TEXT_OPTION_ID)) {
      return typeof answer.freeText === 'string' && answer.freeText.trim() !== ''
    }
    return true
  }
  if (answer.value === FREE_TEXT_OPTION_ID) {
    return typeof answer.freeText === 'string' && answer.freeText.trim() !== ''
  }
  return typeof answer.value === 'string' && answer.value !== ''
}

/** 未有效作答的必填题列表（空数组 = 可提交） */
export function missingRequiredAskAnswers(
  questions: AskQuestionSpec[],
  answers: Record<string, AskQuestionAnswer>
): AskQuestionSpec[] {
  return questions.filter(
    (question) => question.required && !isAskQuestionAnswered(question, answers[question.id])
  )
}
