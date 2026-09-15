<script setup lang="ts">
import type { UIDataTypes, UIMessagePart, UITools } from 'ai'
/**
 * T56（Phase 3 W2/T-B5）：ask_user_question 聊天内表单卡片——全新建。
 *
 * 数据源 = tool part：`input.questions` 渲染表单（经 core validateAskUserQuestions
 * 归一；校验失败 → 无效定义降级提示，不崩），`output.formId`（awaiting 信封
 * details 骑 mapping 到 output）决定可提交态——formId 未就位时提交/跳过禁用。
 *
 * T95 per-question freeText（审查文档 §3/§4）：选择类问题（single_select/
 * image_select）选项列表末尾挂「其他」选项——选中（value === FREE_TEXT_OPTION_ID）
 * 出现输入框，freeText 是该题自包含的一等答案；点普通选项清空 freeText。
 * 必填校验走 core missingRequiredAskAnswers（「其他」需 freeText 非空白）。
 * 作答 → emit submit {formId, aborted:false, answers: Record<qid, AskQuestionAnswer>}；
 * 跳过 → emit submit {formId, aborted:true, freeText:''}。提交后本地禁用态；
 * 重载后由父级 answered prop（formId 相关性，ChatPanel answeredFormIds 派生）置灰。
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

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { toolCallId: string }>

/** 2026-09-15：resolved 派生复用——答/跳过/awaiting 三态形状兼容（status 收窄） */
type AskAnswerOutput =
  | {
      status: 'answered'
      questions?: AskQuestionSpec[]
      answers: Record<string, { value: string; freeText?: string }>
    }
  | { status: 'skipped'; questions?: AskQuestionSpec[] }
  | { status: 'awaiting_user' }

const {
  part,
  answered = false,
  disabled = false
} = defineProps<{
  part: ToolPart
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
  if (part.state === 'output-available') {
    const output = part.output
    if (typeof output === 'object' && output !== null && 'formId' in output) {
      const id = (output as { formId?: unknown }).formId
      if (typeof id === 'string') return id
    }
  }
  return null
})

/** 2026-09-15：resolved 派生——part.state === 'output-available' 即已了结；
 *  锁定横幅按 status 区分「已作答/已跳过」，答案摘要按 details.answers 渲染 */
const resolved = computed(() => {
  if (part.state !== 'output-available') return null
  const output = part.output
  if (typeof output !== 'object' || output === null) return null
  const status = (output as { status?: unknown }).status
  if (status === 'answered' || status === 'skipped' || status === 'awaiting_user') {
    return output as AskAnswerOutput
  }
  return null
})

// per-question 作答槽（T95）：{ value } 普通选项/文本；
// { value: FREE_TEXT_OPTION_ID, freeText } 选了「其他」
const answers = reactive<Record<string, AskQuestionAnswer>>({})
const submittedKind = ref<'answer' | 'skip' | null>(null)
const showRequiredHint = ref(false)

/** 2026-09-15：resolved（output-available 且 status in {answered,skipped,awaiting}）
 *  即已了结——本地 submittedKind 早退 + 服务端返状态双重锁；output-error
 *  （停止/abort）也锁定——后端 pending 已随 abort reject，再提交必 404 */
const isLocked = computed(
  () =>
    answered ||
    submittedKind.value !== null ||
    disabled ||
    resolved.value !== null ||
    part.state === 'output-error'
)

// 预建每题作答槽（questions 由流式 input 派生，后到题也要补槽）——
// 模板 v-model="answers[qid].value" 要求槽位恒存在
watch(
  questions,
  (list) => {
    for (const question of list) {
      if (!answers[question.id]) answers[question.id] = {}
    }
  },
  { immediate: true }
)

const missingRequired = computed(() => missingRequiredAskAnswers(questions.value, answers))

function selectOption(questionId: string, optionId: string) {
  if (optionId === FREE_TEXT_OPTION_ID) {
    // 选「其他」：保留已有 freeText（如有），输入框出现
    answers[questionId] = { ...answers[questionId], value: optionId }
    return
  }
  // 普通选项：清空 freeText（审查文档 §4.3），输入框消失
  answers[questionId] = { value: optionId }
}

function handleSubmit() {
  if (isLocked.value || !formId.value) return
  if (missingRequired.value.length > 0) {
    showRequiredHint.value = true
    return
  }
  // 提交归一：text/普通选项 → { value }（trim）；「其他」freeText 非空白才成键，
  // 空白「其他」视同未作答（选答题直接不落键）
  const normalized: Record<string, AskQuestionAnswer> = {}
  for (const question of questions.value) {
    const answer = answers[question.id]
    if (!answer) continue
    if (question.kind === 'text') {
      const value = answer.value?.trim() ?? ''
      if (value) normalized[question.id] = { value }
      continue
    }
    if (!answer.value) continue
    if (answer.value === FREE_TEXT_OPTION_ID) {
      const freeText = answer.freeText?.trim() ?? ''
      if (freeText) normalized[question.id] = { value: FREE_TEXT_OPTION_ID, freeText }
      continue
    }
    normalized[question.id] = { value: answer.value }
  }
  submittedKind.value = 'answer'
  emit('submit', { formId: formId.value, aborted: false, answers: normalized })
}

function handleSkip() {
  if (isLocked.value || !formId.value) return
  submittedKind.value = 'skip'
  // T95：全局输入框随重设计移除（审查文档 §4），跳过不再附理由
  emit('submit', { formId: formId.value, aborted: true, freeText: '' })
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
      <div v-for="(answer, qid) in resolved.answers" :key="qid" class="flex gap-1">
        <span class="text-surface">{{ qid }}:</span>
        <span>{{
          answer.value === FREE_TEXT_OPTION_ID && answer.freeText ? answer.freeText : answer.value
        }}</span>
      </div>
    </div>

    <div v-if="definitionError" class="text-[11px] text-muted">
      {{ askDialogs.askInvalidDefinition }}
    </div>

    <template v-else>
      <div
        v-for="question in questions"
        :key="question.id"
        class="space-y-1.5"
        :data-test-id="`ask-question-${question.id}`"
      >
        <div class="text-[11px] text-surface">
          <span v-if="question.required" class="mr-0.5 text-accent">*</span>
          {{ question.label }}
          <span v-if="!question.required" class="ml-1 text-[10px] text-muted">{{
            askDialogs.askOptional
          }}</span>
        </div>

        <!-- single_select：选项卡片组 + 末位「其他」（T95） -->
        <div v-if="question.kind === 'single_select'" class="flex flex-col gap-1">
          <button
            v-for="option in question.options ?? []"
            :key="option.id"
            type="button"
            :disabled="isLocked"
            :data-test-id="`ask-option-${question.id}-${option.id}`"
            class="rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors"
            :class="
              answers[question.id]?.value === option.id
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-surface hover:bg-hover'
            "
            @click="selectOption(question.id, option.id)"
          >
            <div>{{ option.label }}</div>
            <div v-if="option.hint" class="mt-0.5 text-[10px] text-muted">{{ option.hint }}</div>
          </button>
          <button
            type="button"
            :disabled="isLocked"
            :data-test-id="`ask-other-${question.id}`"
            class="rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors"
            :class="
              answers[question.id]?.value === FREE_TEXT_OPTION_ID
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-surface hover:bg-hover'
            "
            @click="selectOption(question.id, FREE_TEXT_OPTION_ID)"
          >
            {{ askDialogs.askOtherOption }}
          </button>
        </div>

        <!-- image_select：画布节点缩略图网格 + 下方「其他」（T95） -->
        <div v-else-if="question.kind === 'image_select'" class="flex flex-col gap-1.5">
          <div class="grid grid-cols-3 gap-1.5">
            <button
              v-for="option in question.imageOptions ?? []"
              :key="option.nodeId"
              type="button"
              :disabled="isLocked"
              :data-test-id="`ask-image-option-${question.id}-${option.nodeId}`"
              class="overflow-hidden rounded-md border transition-colors"
              :class="
                answers[question.id]?.value === option.nodeId
                  ? 'border-accent'
                  : 'border-border hover:border-accent/50'
              "
              @click="selectOption(question.id, option.nodeId)"
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
            :data-test-id="`ask-other-${question.id}`"
            class="rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors"
            :class="
              answers[question.id]?.value === FREE_TEXT_OPTION_ID
                ? 'border-accent bg-accent/10 text-surface'
                : 'border-border bg-input text-surface hover:bg-hover'
            "
            @click="selectOption(question.id, FREE_TEXT_OPTION_ID)"
          >
            {{ askDialogs.askOtherOption }}
          </button>
        </div>

        <!-- 「其他」选中后的 freeText 输入框（T95：随普通选项选中消失） -->
        <input
          v-if="question.kind !== 'text' && answers[question.id]?.value === FREE_TEXT_OPTION_ID"
          v-model="answers[question.id].freeText"
          type="text"
          :disabled="isLocked"
          :placeholder="askDialogs.askOtherPlaceholder"
          :data-test-id="`ask-other-input-${question.id}`"
          class="block w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
        />

        <!-- text：自由文本输入 -->
        <input
          v-if="question.kind === 'text'"
          v-model="answers[question.id].value"
          type="text"
          :disabled="isLocked"
          :placeholder="askDialogs.askTextPlaceholder"
          :data-test-id="`ask-text-${question.id}`"
          class="block w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
        />
      </div>

      <div v-if="showRequiredHint && !isLocked" class="text-[10px] text-red-400">
        {{ askDialogs.askRequiredHint }}
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
