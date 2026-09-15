<script setup lang="ts">
import type { UIDataTypes, UIMessagePart, UITools } from 'ai'
/**
 * T56（Phase 3 W2/T-B5）→ 波2 #9：ask_user_question 聊天内表单卡片。
 *
 * 数据源 = tool part：`input.questions` 渲染表单（经 core validateAskUserQuestions
 * 归一；校验失败 → 无效定义降级提示，不崩），`output.formId`（awaiting 信封
 * details 骑 mapping 到 output）决定可提交态——formId 未就位时提交/跳过禁用。
 *
 * T95 per-question freeText：选择类问题（single_select/image_select）选项列表
 * 末尾挂「其他」选项——选中（value === FREE_TEXT_OPTION_ID）出现输入框，
 * freeText 是该题自包含的一等答案；点普通选项清空 freeText。
 * 必填校验走 core missingRequiredAskAnswers（「其他」需 freeText 非空白）。
 *
 * 波2 #9 分页作答壳（owner 拍板取代施工单 #10 折叠原案）：
 *  - ≥2 题启用分页壳，恒定单题视图减少占地；1 题无壳（现状布局）
 *  - single_select 点中普通选项自动翻下一题；末题停留（等提交/回翻检查）
 *  - multi_select / text / image_select / 「其他」展开态 → 不自动翻，显式「下一题」钮
 *  - 进度点导航：题号点横排，可点击跳任意题；已答题点有视觉标记，当前题高亮
 *  - 提交闸：全部必答已答 → 「提交作答」可点；有漏答点提交 → 跳首个漏答 + 轻提示
 *  - 「跳过表单」保持卡级位置与行为不动；已锁定卡（已作答/已跳过/已停止）维持
 *    波1 渲染（徽标 + 摘要 + 禁用），不进分页壳
 *
 * 答案契约（AskFormSubmission via @open-pencil/core/tools/fork/marketing/
 * ask-user-question）：作答分支 answers[qid] = AskQuestionAnswer 含 value/
 * values/freeText/notes 字段，全局备注挂 payload.notes。multi_select 用
 * values 数组（含 FREE_TEXT_OPTION_ID 时 freeText 必填）；notes 字段在该题
 * spec.notes=true 时由本卡采集（与作答解耦）。
 *
 * 图像候选：nodeId → 当前编辑器 store renderExportImage（T55）缩略图；
 * 节点缺失/导出失败 → 占位块显 label（不崩）。v1 仅当前编辑器文档。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import {
  FREE_TEXT_OPTION_ID,
  missingRequiredAskAnswers,
  validateAskUserQuestions,
  type AskFormSubmission,
  type AskImageOption,
  type AskQuestionAnswer,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'

import { getActiveEditorStoreOrNull } from '@/app/editor/active-store'
import { useForkAsk } from '@/app/i18n/fork'
import Tip from '@/components/ui/overlay/Tip.vue'

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { toolCallId: string }>

/** 2026-09-15：resolved 派生复用——答/跳过/awaiting 三态形状兼容（status 收窄） */
type AskAnswerOutput =
  | {
      status: 'answered'
      questions?: AskQuestionSpec[]
      answers: Record<string, AskQuestionAnswer>
      /** 波2 #9：全局备注（parseAskAnswer 从载荷顶层 notes 带出） */
      notes?: string
    }
  | { status: 'skipped'; questions?: AskQuestionSpec[] }
  | { status: 'awaiting_user' }

const {
  part,
  partState,
  answered = false,
  disabled = false
} = defineProps<{
  part: ToolPart
  /** part.state 的原值直传（PiChatMessage 渲染时读现值传入）——ai SDK 就地改
   *  part 对象（引用不变），子组件 prop 浅比较不触发更新；原值 string 变化
   *  才能穿透。resolved/isLocked/formId 的状态门一律读本 prop，不读 part.state */
  partState: ToolPart['state']
  answered?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  submit: [submission: AskFormSubmission]
}>()

const askDialogs = useForkAsk()

// 归一表单定义（required 缺省 true 等由 core 校验层补齐）；非法定义 → 降级提示
const parsed = computed(() => validateAskUserQuestions(part.input))
const questions = computed<AskQuestionSpec[]>(() =>
  'questions' in parsed.value ? parsed.value.questions : []
)
const definitionError = computed(() => ('error' in parsed.value ? parsed.value.message : null))

// 2026-09-15：formId 双源——新流（part.state === 'output-available' 且
// output.status === 'answered'|'skipped'）→ 'ask-'+toolCallId 派生
// （ask-user-question.ts makeId 默认规则，挂起期间 part.output 不存在，
// 前端按 toolCallId 同串派生保持一致）；旧 awaiting 信封 formId 仍可作
// fallback（历史会话保留）
const formId = computed(() => {
  // 新流：toolCallId 派生（output 未就位时也能给出 formId，提交按钮可交互）
  if ('toolCallId' in part && typeof part.toolCallId === 'string') {
    return `ask-${part.toolCallId}`
  }
  // 兼容：旧 awaiting 信封 details 里的 formId
  if (partState === 'output-available') {
    const output = part.output
    if (typeof output === 'object' && output !== null && 'formId' in output) {
      const id = (output as { formId?: unknown }).formId
      if (typeof id === 'string') return id
    }
  }
  return null
})

/** 2026-09-15：resolved 派生——partState === 'output-available' 即已了结；
 *  锁定横幅按 status 区分「已作答/已跳过」，答案摘要按 details.answers 渲染 */
const resolved = computed(() => {
  if (partState !== 'output-available') return null
  const output = part.output
  if (typeof output !== 'object' || output === null) return null
  const status = (output as { status?: unknown }).status
  if (status === 'answered' || status === 'skipped' || status === 'awaiting_user') {
    return output as AskAnswerOutput
  }
  return null
})

/** 已作答时的全局备注（resolved.notes 来自详情；解析路径见 parseAskAnswer） */
const resolvedNotes = computed(() => {
  const r = resolved.value
  return r && r.status === 'answered' ? (r.notes ?? '') : ''
})

// per-question 作答槽（T95）：{ value } 普通选项/文本；
// { value: FREE_TEXT_OPTION_ID, freeText } 选了「其他」；
// multi_select 用 { values: string[] }；notes 字段为该题笔记（spec.notes=true 时）
const answers = reactive<Record<string, AskQuestionAnswer>>({})
const submittedKind = ref<'answer' | 'skip' | null>(null)
const showRequiredHint = ref(false)
/** 波2 #9：分页壳当前页（仅 paginate=true 即 ≥2 题时使用） */
const currentIndex = ref(0)
/** 波2 #9：全局备注（卡片底部输入区） */
const globalNotes = ref('')

/** 2026-09-15：resolved（output-available 且 status in {answered,skipped,awaiting}）
 *  即已了结——本地 submittedKind 早退 + 服务端返状态双重锁；output-error
 *  （停止/abort）也锁定——后端 pending 已随 abort reject，再提交必 404 */
const isLocked = computed(
  () =>
    answered ||
    submittedKind.value !== null ||
    disabled ||
    resolved.value !== null ||
    partState === 'output-error'
)

// 预建每题作答槽（questions 由流式 input 派生，后到题也要补槽）——
// 模板 v-model="answers[qid].value" 要求槽位恒存在
watch(
  questions,
  (list) => {
    for (const question of list) {
      if (!answers[question.id]) answers[question.id] = {}
    }
    // 锁定后再到题不抢光当前页（边界保护）
    if (!isLocked.value && currentIndex.value >= list.length && list.length > 0) {
      currentIndex.value = list.length - 1
    }
  },
  { immediate: true }
)

const missingRequired = computed(() => missingRequiredAskAnswers(questions.value, answers))

/** 波2 #9：≥2 题启用分页壳；1 题保持原纵向平铺以减少不必要的点击成本 */
const usePaginate = computed(() => questions.value.length >= 2)
const currentQuestion = computed<AskQuestionSpec | null>(() => {
  const list = questions.value
  if (list.length === 0) return null
  // paginate=true 用 currentIndex 选页；否则恒定渲染首题
  const index = usePaginate.value ? Math.min(currentIndex.value, list.length - 1) : 0
  return list[index]
})

/** 进度点：当前题高亮 + 已答题勾（必填已答即视为已答） */
function isQuestionAnswered(qid: string): boolean {
  return !missingRequired.value.some((m) => m.id === qid)
}

// ── 选择动作（kind 分派 + 波2 自动翻决策） ──

function selectSingleOption(questionId: string, optionId: string) {
  if (optionId === FREE_TEXT_OPTION_ID) {
    // 选「其他」：保留已有 freeText（如有），输入框出现，不自动翻（freeText 待填）
    answers[questionId] = { ...answers[questionId], value: optionId }
    return
  }
  // 普通选项：清空 freeText（审查文档 §4.3），输入框消失
  answers[questionId] = { value: optionId }
  // 波2 #9：单选点中普通选项 → 自动翻下一题（末题停留）
  if (usePaginate.value) {
    goNextAfterSelect()
  }
}

function selectImageOption(questionId: string, nodeId: string) {
  if (nodeId === FREE_TEXT_OPTION_ID) {
    answers[questionId] = { ...answers[questionId], value: nodeId }
    return
  }
  answers[questionId] = { value: nodeId }
  // image_select 不自动翻（grid 选项多，手动翻确认感更稳）
}

function toggleMultiOption(questionId: string, optionId: string) {
  const current = answers[questionId]
  const list = current?.values ?? []
  // 「其他」特殊处理：单选卡语义下要么勾上要么取消，没有重复 freeText
  if (optionId === FREE_TEXT_OPTION_ID) {
    if (list.includes(FREE_TEXT_OPTION_ID)) {
      const next = list.filter((v) => v !== FREE_TEXT_OPTION_ID)
      answers[questionId] = { values: next, freeText: undefined }
    } else {
      answers[questionId] = { values: [...list, optionId], freeText: current?.freeText }
    }
    return
  }
  if (list.includes(optionId)) {
    answers[questionId] = { values: list.filter((v) => v !== optionId) }
  } else {
    answers[questionId] = { values: [...list, optionId] }
  }
}

/** 单选题自动翻：当前页已是末题则停留；否则翻下一题 */
function goNextAfterSelect() {
  const list = questions.value
  if (currentIndex.value < list.length - 1) {
    currentIndex.value += 1
  }
}

// ── 手动翻页（进度点 + 上一题/下一题钮） ──

function goTo(index: number) {
  if (isLocked.value) return
  const list = questions.value
  if (index < 0 || index >= list.length) return
  currentIndex.value = index
  // 用户显式翻页 → 隐藏上一轮漏答提示，避免干扰
  showRequiredHint.value = false
}

function goNext() {
  if (currentIndex.value < questions.value.length - 1) {
    currentIndex.value += 1
    showRequiredHint.value = false
  }
}

function goPrev() {
  if (currentIndex.value > 0) {
    currentIndex.value -= 1
    showRequiredHint.value = false
  }
}

// ── 提交（带漏答跳首漏闸） ──

function handleSubmit() {
  if (isLocked.value || !formId.value) return
  const missing = missingRequired.value
  if (missing.length > 0) {
    showRequiredHint.value = true
    // 跳首个漏答题（仅分页壳生效；1 题时已是当前页无需跳）
    if (usePaginate.value) {
      const firstMissingIndex = questions.value.findIndex((q) => q.id === missing[0].id)
      if (firstMissingIndex !== -1) currentIndex.value = firstMissingIndex
    }
    return
  }
  const normalized = normalizeForSubmit()
  submittedKind.value = 'answer'
  // 全局备注 trim 后非空白才挂（避免空串噪声）
  const trimmedNotes = globalNotes.value.trim()
  emit('submit', {
    formId: formId.value,
    aborted: false,
    answers: normalized,
    ...(trimmedNotes ? { notes: trimmedNotes } : {})
  })
}

function handleSkip() {
  if (isLocked.value || !formId.value) return
  submittedKind.value = 'skip'
  // T95：全局输入框随重设计移除（审查文档 §4），跳过不再附理由
  emit('submit', { formId: formId.value, aborted: true, freeText: '' })
}

/**
 * 提交归一：
 *  - text → { value }（trim）；空白丢弃
 *  - multi_select → { values } 数组（trim 后非空白项）；空白值/空数组丢弃
 *  - 「其他」→ { value: FREE_TEXT_OPTION_ID, freeText }；freeText 空白则视为未作答（不落键）
 *  - 普通选项 → { value }
 *  - notes 字段在该题 spec.notes=true 时采集；空白丢弃
 */
function normalizeForSubmit(): Record<string, AskQuestionAnswer> {
  const normalized: Record<string, AskQuestionAnswer> = {}
  for (const question of questions.value) {
    const answer = answers[question.id]
    if (!answer) continue
    const out = normalizeSingle(question, answer)
    // notes 与作答解耦：spec.notes=true 时采集，trim 非空白才携带
    if (question.notes === true) {
      const notes = answer.notes?.trim() ?? ''
      if (notes) out.notes = notes
    }
    // 至少有一个有效字段才落键（与 core normalizeQuestionAnswer 同律）
    if (hasContent(out)) normalized[question.id] = out
  }
  return normalized
}

function hasContent(answer: AskQuestionAnswer): boolean {
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

// ── 图像候选缩略图（当前编辑器文档；失败 → null → 占位块） ──

const THUMBNAIL_RENDER_SIZE = 192
const thumbnails = reactive<Record<string, string | null | undefined>>({})
const createdUrls: string[] = []

const imageOptionList = computed(() =>
  questions.value.flatMap((question) => question.imageOptions ?? [])
)

function setThumbnail(nodeId: string, url: string | null) {
  thumbnails[nodeId] = url
}

function thumbnailURL(nodeId: string): string | undefined {
  const url = thumbnails[nodeId]
  return typeof url === 'string' ? url : undefined
}

async function loadThumbnail(option: AskImageOption) {
  const store = getActiveEditorStoreOrNull()
  const node = store?.graph.getNode(option.nodeId)
  if (!store || !node) {
    setThumbnail(option.nodeId, null)
    return
  }
  const scale = THUMBNAIL_RENDER_SIZE / Math.max(node.width, node.height, 1)
  try {
    const data = await store.renderExportImage([option.nodeId], scale, 'PNG')
    if (!data) {
      setThumbnail(option.nodeId, null)
      return
    }
    const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }))
    createdUrls.push(url)
    setThumbnail(option.nodeId, url)
  } catch {
    setThumbnail(option.nodeId, null)
  }
}

onMounted(() => {
  for (const option of imageOptionList.value) void loadThumbnail(option)
})

onBeforeUnmount(() => {
  for (const url of createdUrls) URL.revokeObjectURL(url)
})

// ── 摘要渲染辅助（已锁定卡的答案摘要；值/values/notes 三形态兼容） ──

function labelForOption(question: AskQuestionSpec, optionId: string): string {
  if (optionId === FREE_TEXT_OPTION_ID) return askDialogs.value.askOtherOption
  if (question.kind === 'image_select') {
    const opt = question.imageOptions?.find((o) => o.nodeId === optionId)
    return opt?.label ?? optionId
  }
  const opt = question.options?.find((o) => o.id === optionId)
  return opt?.label ?? optionId
}

function summarizeAnswer(question: AskQuestionSpec, answer: AskQuestionAnswer | undefined): string {
  if (!answer) return ''
  if (question.kind === 'multi_select' && Array.isArray(answer.values)) {
    if (answer.values.length === 0) return ''
    const labels = answer.values.map((v) =>
      v === FREE_TEXT_OPTION_ID
        ? answer.freeText?.trim() || askDialogs.value.askOtherOption
        : labelForOption(question, v)
    )
    return labels.join('、')
  }
  if (answer.value === FREE_TEXT_OPTION_ID) {
    return answer.freeText?.trim() || askDialogs.value.askOtherOption
  }
  if (typeof answer.value === 'string') {
    return answer.value === '' ? '' : labelForOption(question, answer.value)
  }
  return answer.freeText?.trim() ?? ''
}
</script>

<template>
  <div data-test-id="ask-form-card" class="space-y-3 rounded-lg border border-border bg-canvas p-3">
    <div class="flex items-center gap-2">
      <icon-lucide-list-checks class="size-3.5 shrink-0 text-accent" />
      <span class="text-[11px] font-medium text-surface">{{ askDialogs.askFormTitle }}</span>
      <span
        v-if="
          submittedKind !== null ||
          answered ||
          (resolved !== null && (resolved.status === 'answered' || resolved.status === 'skipped'))
        "
        data-test-id="ask-form-answered-badge"
        class="rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted"
      >
        <!-- 2026-09-15：服务端返状态优先（'answered'/'skipped'）→ 本地 submittedKind 兜底；
             历史 awaiting_user 未答表单与 output-error（停止）只锁不标（勿误标「已作答」） -->
        {{
          resolved?.status === 'skipped' || submittedKind === 'skip'
            ? askDialogs.askSkipped
            : askDialogs.askAnswered
        }}
      </span>
    </div>

    <!-- 2026-09-15：resolved 详情（仅 answered 展示逐题答案摘要；skipped 仅状态） -->
    <div
      v-if="resolved?.status === 'answered'"
      data-test-id="ask-form-summary"
      class="space-y-0.5 text-[10px] text-muted"
    >
      <div v-for="(answer, qid) in resolved.answers" :key="qid" class="flex flex-col gap-0.5">
        <div class="flex gap-1">
          <span class="text-surface">{{ qid }}:</span>
          <span>{{
            summarizeAnswer(
              questions.find((q) => q.id === qid) ?? {
                id: qid,
                kind: 'text',
                label: qid,
                required: true
              },
              answer
            )
          }}</span>
        </div>
        <div v-if="(answer as AskQuestionAnswer).notes" class="ml-3 text-muted">
          {{ askDialogs.askSummaryNotes({ notes: (answer as AskQuestionAnswer).notes ?? '' }) }}
        </div>
      </div>
      <div v-if="resolvedNotes" class="mt-1 border-t border-border pt-1 text-muted">
        {{ askDialogs.askSummaryNotes({ notes: resolvedNotes }) }}
      </div>
    </div>

    <div v-if="definitionError" class="text-[11px] text-muted">
      {{ askDialogs.askInvalidDefinition }}
    </div>

    <template v-else-if="currentQuestion">
      <!-- 波2 #9：分页壳——≥2 题启用；恒定单题视图 -->
      <!-- 进度点导航（仅分页壳显示；1 题无壳时隐藏） -->
      <div v-if="usePaginate" data-test-id="ask-form-progress" class="flex items-center gap-1">
        <Tip v-for="(q, index) in questions" :key="q.id" :label="q.label">
          <button
            type="button"
            :disabled="isLocked"
            :data-test-id="`ask-progress-${index}`"
            class="flex size-4 items-center justify-center rounded-full border transition-colors"
            :class="
              index === currentIndex
                ? 'border-accent bg-accent text-white'
                : isQuestionAnswered(q.id)
                  ? 'border-accent bg-accent/30 text-surface'
                  : 'border-border bg-input text-muted hover:border-accent/50'
            "
            @click="goTo(index)"
          >
            <icon-lucide-check
              v-if="isQuestionAnswered(q.id) && index !== currentIndex"
              class="size-2.5"
            />
            <span v-else class="text-[9px] leading-none">{{ index + 1 }}</span>
          </button>
        </Tip>
        <span class="ml-1 text-[10px] text-muted">
          {{
            askDialogs.askProgress({
              current: currentIndex + 1,
              total: questions.length
            })
          }}
        </span>
      </div>

      <!-- 单题视图（不论分页与否，每页一道题） -->
      <div
        :key="currentQuestion.id"
        :data-test-id="`ask-question-${currentQuestion.id}`"
        class="space-y-1.5"
      >
        <div class="text-[11px] text-surface">
          <span v-if="currentQuestion.required" class="mr-0.5 text-accent">*</span>
          {{ currentQuestion.label }}
          <span v-if="!currentQuestion.required" class="ml-1 text-[10px] text-muted">{{
            askDialogs.askOptional
          }}</span>
        </div>

        <!-- single_select：选项卡片组 + 末位「其他」（T95） -->
        <div v-if="currentQuestion.kind === 'single_select'" class="flex flex-col gap-1">
          <button
            v-for="option in currentQuestion.options ?? []"
            :key="option.id"
            type="button"
            :disabled="isLocked"
            :data-test-id="`ask-option-${currentQuestion.id}-${option.id}`"
            class="rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors"
            :class="
              answers[currentQuestion.id]?.value === option.id
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-surface hover:bg-hover'
            "
            @click="selectSingleOption(currentQuestion.id, option.id)"
          >
            <div>{{ option.label }}</div>
            <div v-if="option.hint" class="mt-0.5 text-[10px] text-muted">{{ option.hint }}</div>
          </button>
          <button
            type="button"
            :disabled="isLocked"
            :data-test-id="`ask-other-${currentQuestion.id}`"
            class="rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors"
            :class="
              answers[currentQuestion.id]?.value === FREE_TEXT_OPTION_ID
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-surface hover:bg-hover'
            "
            @click="selectSingleOption(currentQuestion.id, FREE_TEXT_OPTION_ID)"
          >
            {{ askDialogs.askOtherOption }}
          </button>
        </div>

        <!-- multi_select：checkbox 多选组 + 末位「其他」 -->
        <div v-else-if="currentQuestion.kind === 'multi_select'" class="flex flex-col gap-1">
          <div class="text-[10px] text-muted">{{ askDialogs.askMultiHint }}</div>
          <label
            v-for="option in currentQuestion.options ?? []"
            :key="option.id"
            :data-test-id="`ask-option-${currentQuestion.id}-${option.id}`"
            class="flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors"
            :class="
              (answers[currentQuestion.id]?.values ?? []).includes(option.id)
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-surface hover:bg-hover'
            "
          >
            <input
              type="checkbox"
              :checked="(answers[currentQuestion.id]?.values ?? []).includes(option.id)"
              :disabled="isLocked"
              class="mt-0.5 size-3 accent-accent"
              @change="toggleMultiOption(currentQuestion.id, option.id)"
            />
            <div class="flex-1">
              <div>{{ option.label }}</div>
              <div v-if="option.hint" class="mt-0.5 text-[10px] text-muted">{{ option.hint }}</div>
            </div>
          </label>
          <label
            :data-test-id="`ask-other-${currentQuestion.id}`"
            class="flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px] transition-colors"
            :class="
              (answers[currentQuestion.id]?.values ?? []).includes(FREE_TEXT_OPTION_ID)
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-surface hover:bg-hover'
            "
          >
            <input
              type="checkbox"
              :checked="(answers[currentQuestion.id]?.values ?? []).includes(FREE_TEXT_OPTION_ID)"
              :disabled="isLocked"
              class="mt-0.5 size-3 accent-accent"
              @change="toggleMultiOption(currentQuestion.id, FREE_TEXT_OPTION_ID)"
            />
            <span>{{ askDialogs.askOtherOption }}</span>
          </label>
        </div>

        <!-- image_select：画布节点缩略图网格 + 下方「其他」（T95） -->
        <div v-else-if="currentQuestion.kind === 'image_select'" class="flex flex-col gap-1.5">
          <div class="grid grid-cols-3 gap-1.5">
            <button
              v-for="option in currentQuestion.imageOptions ?? []"
              :key="option.nodeId"
              type="button"
              :disabled="isLocked"
              :data-test-id="`ask-image-option-${currentQuestion.id}-${option.nodeId}`"
              class="overflow-hidden rounded-md border transition-colors"
              :class="
                answers[currentQuestion.id]?.value === option.nodeId
                  ? 'border-accent'
                  : 'border-border hover:border-accent/50'
              "
              @click="selectImageOption(currentQuestion.id, option.nodeId)"
            >
              <div class="flex h-20 items-center justify-center bg-input">
                <img
                  v-if="thumbnailURL(option.nodeId)"
                  :src="thumbnailURL(option.nodeId)"
                  :alt="option.label ?? option.nodeId"
                  class="max-h-full max-w-full object-contain"
                  draggable="false"
                />
                <div v-else class="flex flex-col items-center gap-1 px-1 text-[10px] text-muted">
                  <icon-lucide-loader-circle
                    v-if="thumbnails[option.nodeId] === undefined"
                    class="size-3 animate-spin"
                  />
                  <template v-else>
                    <icon-lucide-image-off class="size-3" />
                    <span>{{ askDialogs.askImageUnavailable }}</span>
                  </template>
                </div>
              </div>
              <div class="truncate px-1.5 py-1 text-[10px] text-surface">
                {{ option.label ?? option.nodeId }}
              </div>
            </button>
          </div>
          <button
            type="button"
            :disabled="isLocked"
            :data-test-id="`ask-other-${currentQuestion.id}`"
            class="rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors"
            :class="
              answers[currentQuestion.id]?.value === FREE_TEXT_OPTION_ID
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-surface hover:bg-hover'
            "
            @click="selectImageOption(currentQuestion.id, FREE_TEXT_OPTION_ID)"
          >
            {{ askDialogs.askOtherOption }}
          </button>
        </div>

        <!-- 「其他」选中后的 freeText 输入框（T95：随普通选项选中消失） -->
        <input
          v-if="
            currentQuestion.kind !== 'text' &&
            currentQuestion.kind !== 'multi_select' &&
            answers[currentQuestion.id]?.value === FREE_TEXT_OPTION_ID
          "
          v-model="answers[currentQuestion.id].freeText"
          type="text"
          :disabled="isLocked"
          :placeholder="askDialogs.askOtherPlaceholder"
          :data-test-id="`ask-other-input-${currentQuestion.id}`"
          class="block w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
        />

        <!-- multi_select 选中「其他」后的 freeText 输入框 -->
        <input
          v-if="
            currentQuestion.kind === 'multi_select' &&
            (answers[currentQuestion.id]?.values ?? []).includes(FREE_TEXT_OPTION_ID)
          "
          v-model="answers[currentQuestion.id].freeText"
          type="text"
          :disabled="isLocked"
          :placeholder="askDialogs.askOtherPlaceholder"
          :data-test-id="`ask-other-input-${currentQuestion.id}`"
          class="block w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
        />

        <!-- text：自由文本输入 -->
        <input
          v-if="currentQuestion.kind === 'text'"
          v-model="answers[currentQuestion.id].value"
          type="text"
          :disabled="isLocked"
          :placeholder="askDialogs.askTextPlaceholder"
          :data-test-id="`ask-text-${currentQuestion.id}`"
          class="block w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
        />

        <!-- per-question 笔记（spec.notes=true 时显示） -->
        <textarea
          v-if="currentQuestion.notes"
          v-model="answers[currentQuestion.id].notes"
          :disabled="isLocked"
          rows="1"
          :placeholder="askDialogs.askNotesPlaceholder"
          :data-test-id="`ask-notes-${currentQuestion.id}`"
          class="block w-full resize-none rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
        />
      </div>

      <!-- 分页壳：上一题/下一题 翻页行 -->
      <div
        v-if="usePaginate && !isLocked"
        class="flex items-center justify-between"
        data-test-id="ask-form-pager"
      >
        <button
          type="button"
          :disabled="currentIndex === 0"
          data-test-id="ask-form-prev"
          class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          @click="goPrev"
        >
          {{ askDialogs.askPrev }}
        </button>
        <button
          type="button"
          :disabled="currentIndex >= questions.length - 1"
          data-test-id="ask-form-next"
          class="rounded-md border border-border px-2.5 py-1 text-[11px] text-surface hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          @click="goNext"
        >
          {{ askDialogs.askNext }}
        </button>
      </div>

      <!-- 全局备注（卡片底部，跳过/提交行上方）——仅分页壳生效，
           1 题无壳时与下排提交行共位（UX 一致性） -->
      <textarea
        v-if="usePaginate || questions.length === 1"
        v-model="globalNotes"
        :disabled="isLocked"
        rows="1"
        :placeholder="askDialogs.askGlobalNotesPlaceholder"
        data-test-id="ask-form-global-notes"
        class="block w-full resize-none rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
      />

      <div
        v-if="showRequiredHint && !isLocked && missingRequired.length > 0"
        class="text-[10px] text-red-400"
      >
        {{
          missingRequired.length === 1
            ? askDialogs.askMissingCount({ count: 1 })
            : askDialogs.askMissingCountPlural({ count: missingRequired.length })
        }}
      </div>

      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          :disabled="isLocked || !formId"
          data-test-id="ask-form-skip"
          class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          @click="handleSkip"
        >
          {{ askDialogs.askSkip }}
        </button>
        <button
          type="button"
          :disabled="isLocked || !formId"
          data-test-id="ask-form-submit"
          class="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
          @click="handleSubmit"
        >
          {{ askDialogs.askSubmit }}
        </button>
      </div>
    </template>
  </div>
</template>
