/**
 * ask_user_question 卡片交互状态纯 reducer 层（波3 阶段一抽纯）。
 *
 * 设计约束：
 *  - 零 vue / 零 DOM 依赖，bun 直测。
 *  - 不持有 formId / isLocked / submit emit——表单决策（attemptSubmit 的可提交路径）
 *    在此处只产出「缺失列表」「已可提交」两类纯事实，由卡片负责 emit 契约。
 *  - 自动翻页仅「单选点中普通选项」一条路径：usePaginate（≥2 题）且非末题
 *    → currentIndex + 1；末题原地；image_select / multi_select / 文本 /
 *    「其他」展开态不自动翻（grid 选项多手动翻确认感更稳；「其他」freeText 待填）。
 *  - ensureSlots 复现 watch 补槽现行为：questions 流式后到题也要补槽（v-model
 *    要求槽位恒存在）；锁定后再到题不抢光当前页（currentIndex 钳到末尾）。
 *  - toggleMultiOption 复现 multi_select 现行为：「其他」勾选/取消联动 freeText；
 *    普通选项勾上 / 取消不污染 freeText。
 */
import {
  FREE_TEXT_OPTION_ID,
  missingRequiredAskAnswers,
  type AskQuestionAnswer,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'

/** 卡片本地交互状态（与 props 派生 resolved/isLocked/formId 解耦） */
export interface AskCardState {
  currentIndex: number
  answers: Record<string, AskQuestionAnswer>
  submittedKind: 'answer' | 'skip' | null
  showRequiredHint: boolean
  globalNotes: string
  /**
   * 波3 阶段二：single_select preview 面板的焦点（qid → optionId）。
   * 翻题后该题焦点自然保留；脱离作用域（题被剔除）由卡片 computed 兜底回退
   * 到已选/首个带 preview 选项。
   */
  previewFocus: Record<string, string>
}

/** 工厂：初始值工厂，无副作用 */
export function createAskCardState(): AskCardState {
  return {
    currentIndex: 0,
    answers: {},
    submittedKind: null,
    showRequiredHint: false,
    globalNotes: '',
    previewFocus: {}
  }
}

/** reducer 调用所需的派生信息（questions 流式到达，外部传入避免 reducer 持有 ref） */
export interface AskCardContext {
  questions: AskQuestionSpec[]
  /** 锁定态（answered / 本地 submittedKind 非空 / 父级 disabled / resolved/output-error） */
  isLocked: boolean
}

/** 判别联合：每种动作对应卡片里的一个交互入口 */
export type AskCardAction =
  | { type: 'ensureSlots' }
  | { type: 'selectSingleOption'; questionId: string; optionId: string }
  | { type: 'selectImageOption'; questionId: string; nodeId: string }
  | { type: 'toggleMultiOption'; questionId: string; optionId: string }
  | { type: 'setFreeText'; questionId: string; freeText: string }
  | { type: 'setText'; questionId: string; value: string }
  | { type: 'setNotes'; questionId: string; notes: string }
  | { type: 'setGlobalNotes'; notes: string }
  | { type: 'setPreviewFocus'; questionId: string; optionId: string }
  | { type: 'goTo'; index: number }
  | { type: 'goNext' }
  | { type: 'goPrev' }
  | { type: 'attemptSubmit' }
  | { type: 'markSubmitted'; kind: 'answer' | 'skip' }

/** 自动翻页统一规则：≥2 题（usePaginate）且非末题 → 翻下一题；否则原地 */
function advanceAfterSelect(state: AskCardState, ctx: AskCardContext): void {
  const list = ctx.questions
  if (list.length < 2) return
  if (state.currentIndex < list.length - 1) {
    state.currentIndex += 1
  }
}

/** 取某个 action 变体的载荷类型（case 委托小函数的形参用） */
type ActionOf<T extends AskCardAction['type']> = Extract<AskCardAction, { type: T }>

function applyEnsureSlots(state: AskCardState, ctx: AskCardContext): void {
  for (const question of ctx.questions) {
    if (!state.answers[question.id]) state.answers[question.id] = {}
  }
  // 锁定后再到题不抢光当前页：currentIndex 钳到合法末尾
  if (!ctx.isLocked && state.currentIndex >= ctx.questions.length && ctx.questions.length > 0) {
    state.currentIndex = ctx.questions.length - 1
  }
}

function applySelectSingle(
  state: AskCardState,
  action: ActionOf<'selectSingleOption'>,
  ctx: AskCardContext
): void {
  if (action.optionId === FREE_TEXT_OPTION_ID) {
    // 选「其他」：保留已有 freeText（如有），输入框出现，不自动翻
    const current = state.answers[action.questionId]
    state.answers[action.questionId] = { ...current, value: action.optionId }
    return
  }
  // 普通选项：清空 freeText
  state.answers[action.questionId] = { value: action.optionId }
  advanceAfterSelect(state, ctx)
}

function applySelectImage(state: AskCardState, action: ActionOf<'selectImageOption'>): void {
  if (action.nodeId === FREE_TEXT_OPTION_ID) {
    const current = state.answers[action.questionId]
    state.answers[action.questionId] = { ...current, value: action.nodeId }
    return
  }
  state.answers[action.questionId] = { value: action.nodeId }
  // image_select 不自动翻（grid 选项多，手动翻确认感更稳）
}

function applyToggleMulti(state: AskCardState, action: ActionOf<'toggleMultiOption'>): void {
  const current = state.answers[action.questionId]
  const list = current?.values ?? []
  if (action.optionId === FREE_TEXT_OPTION_ID) {
    if (list.includes(FREE_TEXT_OPTION_ID)) {
      const next = list.filter((v) => v !== FREE_TEXT_OPTION_ID)
      state.answers[action.questionId] = { values: next, freeText: undefined }
    } else {
      state.answers[action.questionId] = {
        values: [...list, action.optionId],
        freeText: current?.freeText
      }
    }
    return
  }
  if (list.includes(action.optionId)) {
    state.answers[action.questionId] = { values: list.filter((v) => v !== action.optionId) }
  } else {
    state.answers[action.questionId] = { values: [...list, action.optionId] }
  }
}

/** setFreeText/setText/setNotes 同形：给槽位合并一个字段 */
function applyMergeAnswer(state: AskCardState, questionId: string, patch: AskQuestionAnswer): void {
  const current = state.answers[questionId] ?? {}
  state.answers[questionId] = { ...current, ...patch }
}

function applyGoTo(state: AskCardState, action: ActionOf<'goTo'>, ctx: AskCardContext): void {
  if (ctx.isLocked) return
  if (action.index < 0 || action.index >= ctx.questions.length) return
  state.currentIndex = action.index
  // 用户显式翻页 → 隐藏上一轮漏答提示
  state.showRequiredHint = false
}

function applyAttemptSubmit(state: AskCardState, ctx: AskCardContext): void {
  const missing = missingRequiredAskAnswers(ctx.questions, state.answers)
  if (missing.length === 0) return
  state.showRequiredHint = true
  // 跳首个漏答题（仅分页壳生效；1 题时已是当前页无需跳）
  if (ctx.questions.length < 2) return
  const firstMissingId = missing[0].id
  const target = ctx.questions.findIndex((q) => q.id === firstMissingId)
  if (target !== -1) state.currentIndex = target
}

/** reducer：纯函数 + 局部可变（state 本身是组件持有的 reactive 对象），无外部副作用。
 *  复杂度纪律：case 体委托上方小函数，本函数只做分派与零分支直写 */
export function reduceAskCard(
  state: AskCardState,
  action: AskCardAction,
  ctx: AskCardContext
): void {
  switch (action.type) {
    case 'ensureSlots':
      applyEnsureSlots(state, ctx)
      return
    case 'selectSingleOption':
      applySelectSingle(state, action, ctx)
      return
    case 'selectImageOption':
      applySelectImage(state, action)
      return
    case 'toggleMultiOption':
      applyToggleMulti(state, action)
      return
    case 'setFreeText':
      applyMergeAnswer(state, action.questionId, { freeText: action.freeText })
      return
    case 'setText':
      applyMergeAnswer(state, action.questionId, { value: action.value })
      return
    case 'setNotes':
      applyMergeAnswer(state, action.questionId, { notes: action.notes })
      return
    case 'setGlobalNotes':
      state.globalNotes = action.notes
      return
    case 'setPreviewFocus':
      // 写入即可——翻题后该题焦点自然保留；脱离作用域由卡片 computed 兜底回退
      state.previewFocus[action.questionId] = action.optionId
      return
    case 'goTo':
      applyGoTo(state, action, ctx)
      return
    case 'goNext':
      if (state.currentIndex < ctx.questions.length - 1) {
        state.currentIndex += 1
        state.showRequiredHint = false
      }
      return
    case 'goPrev':
      if (state.currentIndex > 0) {
        state.currentIndex -= 1
        state.showRequiredHint = false
      }
      return
    case 'attemptSubmit':
      applyAttemptSubmit(state, ctx)
      return
    case 'markSubmitted':
      state.submittedKind = action.kind
  }
}

/** 给卡片消费：attemptSubmit 路径是否可提交（无必填缺口） */
export function isSubmittable(state: AskCardState, ctx: AskCardContext): boolean {
  return missingRequiredAskAnswers(ctx.questions, state.answers).length === 0
}
