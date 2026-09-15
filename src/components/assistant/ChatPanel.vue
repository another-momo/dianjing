<script setup lang="ts">
import type { Chat } from '@ai-sdk/vue'
import { refAutoReset } from '@vueuse/core'
import { isTextUIPart, isToolUIPart } from 'ai'
import type { UIMessage } from 'ai'
// Batch 2a 路径分离（2026-09-05）：本面板自 src/components/ChatPanel.vue 迁入
// ownedRoot src/components/assistant/（Batch 2f 自 chat/ 整体改名），原上游路径
// 留给 deletedPaths 落账；ChatInput/ChatMessage 同批改名 PiChatInput/PiChatMessage 完成命名分离。
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  ScrollAreaRoot,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport
} from 'reka-ui'
import { computed, markRaw, nextTick, onErrorCaptured, onMounted, ref, watch } from 'vue'

import { parseAskAnswer } from '@open-pencil/core/tools/fork/marketing/ask-user-question'
import type { AskFormSubmission } from '@open-pencil/core/tools/fork/marketing/ask-user-question'
import type { JSONObject } from '@open-pencil/scene-graph/primitives'
import { useI18n } from '@open-pencil/vue'

import { copyChatLog } from '@/app/ai/fork/debug'
import { isAbortShapedError, markIntentionalStop } from '@/app/ai/fork/transports'
import { useAIChat } from '@/app/ai/fork/use'
import { piDesignAssignment } from '@/app/ai/pi-backend/assignment'
import { piCatalog, postAskAnswer, refreshPiCatalog } from '@/app/ai/pi-backend/client'
import {
  getPiCurrentSessionId,
  hasPiDocId,
  listPiSessionFamily,
  switchPiSession,
  type PiSessionSummary
} from '@/app/ai/pi-backend/document-key'
import {
  clearPiPendingNewIntent,
  piActiveDesign,
  piPendingNewIntent,
  piStudioManifest,
  resyncPiActiveDesign
} from '@/app/ai/pi-backend/mode-selection'
import { deriveGateState, type GateState } from '@/app/ai/pi-backend/provider-gate'
import { getActiveEditorStore } from '@/app/editor/active-store'
import { useForkConfirm, useForkPi } from '@/app/i18n/fork'
import { useNotificationMessages } from '@/app/i18n/notifications'
import { toast } from '@/app/shell/ui'
import { activeTab } from '@/app/tabs'
import AppTextButton from '@/components/ui/AppTextButton.vue'
import AppPlaceholder from '@/components/ui/feedback/AppPlaceholder.vue'
import { menuItem, useMenuUI } from '@/components/ui/menu/menu'
import Tip from '@/components/ui/overlay/Tip.vue'

import {
  ACTIVE_DESIGN_DECISION_PART_TYPE,
  CONTEXT_SWITCH_PART_TYPE,
  NEW_INTENT_PART_TYPE,
  collectDesignImageRefs,
  isDesignRootMaterialized,
  modeSizeChoices,
  parseSetActiveDesignProposed,
  postActiveDesign,
  postIntentConfirm,
  serializeNewIntentEnvelope,
  type ActiveDesignDecisionPartData,
  type ContextSwitchPartData,
  type NewIntentPartData
} from './active-design'
import ChatBriefDialog from './ChatBriefDialog.vue'
import ChatContextBar from './ChatContextBar.vue'
import PiChatInput from './PiChatInput.vue'
import PiChatMessage from './PiChatMessage.vue'
import PiProviderGateCard from './PiProviderGateCard.vue'

const IS_DEV = import.meta.env.DEV

const { ensureChat, resetChat, chatFailure, clearChatFailure } = useAIChat()
const { ai } = useI18n()
const notifications = useNotificationMessages()
const confirmText = useForkConfirm()
const piDialogs = useForkPi()

const chat = ref<Chat<UIMessage> | null>(null)
// T27：提交失败时经此把草稿回填进输入框（PiChatInput 提交即清空——见 restoreDraft）；
// 结构化类型即可，不 import 组件类型（避免 script 侧只剩类型引用触发 consistent-type-imports）
const chatInputRef = ref<{ restoreDraft: (text: string) => void; clearDraft: () => void } | null>(
  null
)

void ensureChat()
  .then((c) => {
    if (c) chat.value = markRaw(c)
    refreshSessionMeta()
    return undefined
  })
  .catch((error: unknown) => {
    toast.error(
      notifications.value.chatInitializationFailed({
        error: error instanceof Error ? error.message : String(error)
      })
    )
  })
const messagesEnd = ref<HTMLDivElement>()
// T98：PiChatInput patch 崩溃（insertBefore/__vnode null——contenteditable 非受控
// 编辑器与 Vue  vnode 树偶发失配）后，旧 vnode 带 null el 留在树里，后续每次
// 更新必再崩（级联，owner 实测 Enter/发送/停止全报同一错）。捕获该签名错误后
// 整树强制重挂自愈——代价是丢失未提交草稿，远好于输入框永久坏到刷新页面。
// nextTick 推迟到当前 flush 落定后再换 key，避免同 flush 内 unmount 半补丁树。
//
// 2026-09-11：B 方案把触发源从崩溃后提前到崩溃前——PiChatInput 的
// syncTextFromDom 检到 editorRef 子节点里没有 data-seg-root（Blink 空编辑
// 器规范化吃掉了 seg-root）就 emit('segRootLost', text)。本 handler 与 T98
// 共用同一个 chatInputRemountKey：runtime-dom 的 unmount 对游离 seg-root
// 安全（remove 有 parentNode 守卫），unmount + 整树重挂 + restoreDraft 回
// 填草稿，**保留草稿** vs T98 丢草稿。T98 onErrorCaptured 留作最后防线
//（A 拦不住且 syncTextFromDom 也漏检的真崩溃路径仍能兜住）。
const chatInputRemountKey = ref(0)
function handleSegRootLost(text: string) {
  chatInputRemountKey.value += 1
  void nextTick(() => chatInputRef.value?.restoreDraft(text))
}
onErrorCaptured((err, instance) => {
  // .type 在内部实例（instance.$）上；ComponentPublicInstance 公共类型不含该
  // 属性——旧写法 vue-tsc 报错且运行时经公共代理取不到值，guard 恒不触发
  const file = (instance?.$?.type as { __file?: string } | undefined)?.__file ?? ''
  const isChatInputSubtree = file.endsWith('PiChatInput.vue') || file.endsWith('InputGroup.vue')
  const isPatchCorruption = err instanceof TypeError && /insertBefore|__vnode/.test(err.message)
  if (!isChatInputSubtree || !isPatchCorruption) return true
  console.warn('[chat] 输入框 patch 树损坏——强制重挂自愈（未提交草稿会丢失）', err)
  void nextTick(() => {
    chatInputRemountKey.value += 1
  })
  return false
})
const debugCopied = refAutoReset(false, 1500)
// T94：用户主动停止标记——stop() 引发的 SSE 断开是预期行为，不是错误。
// 旗标在下一次 status 落 ready / error 时消费复位（stop 按钮只在 streaming /
// submitted 时出现，见 PiChatInput isStreaming 守卫，旗标不会无条件残留）
const isUserStopped = ref(false)
// T94：停止回执瞬时旗标（4s 自动复位，refAutoReset 同 debugCopied 纪律）——
// 驱动末条消息底部「已停止」小字行（PiChatMessage stopped prop）
const justStopped = refAutoReset(false, 4000)

const messages = computed(() => chat.value?.messages ?? [])

// pi-model-explicit-config（§3 落地清单 1）—— 引导门生态状态机：
// 派生四态：loading / ready / needs-setup / needs-credential。
// 派生函数是 src/app/ai/pi-backend/provider-gate.ts 的纯函数（测试可桩）。
// 派生输入只读 piDesignAssignment + piCatalog；不读 storage/window。
const gateState = computed<GateState>(() =>
  deriveGateState({
    assignment: piDesignAssignment.value,
    catalog: piCatalog.value
  })
)
const isGateReady = computed(() => gateState.value.kind === 'ready')
// 引导卡只接 needs-* 两态（prop 契约是 Extract 收窄联合）；模板 v-else 链不做类型
// 收窄，经本 computed 显式过滤——非 needs-* 时为 null，v-else-if 真值守卫顺带收窄
const gateCardState = computed(() => {
  const state = gateState.value
  return state.kind === 'needs-setup' || state.kind === 'needs-credential' ? state : null
})

/**
 * §3 落地清单 3：应用启动时拉一次 catalog。
 *
 * 落点论证：ChatPanel 是聊天面板的入口，是 catalog 第一消费者（门渲 + 后续输入条 label
 * 派生），挂在这里最合理——其他消费者（PiModelsPanel）只在自己 onMounted 时拉，
 * ChatPanel 此刻提前发起，刚好盖住「用户首开面板」与「用户首开发消息」两个最早触点。
 * 不放 app 根（main.ts）的原因：main.ts 在 vite SPA 启动期跑、无 DOM/路由上下文、
 * 与 Vue 生命周期耦合（inject 不到 i18n/pi catalog ref）；放 ChatPanel 内 onMounted
 * 是最稳的单点。
 *
 * 失败处理：refreshPiCatalog 内 try/catch 已经把错误写进 piCatalogError 并把
 * piCatalog 置 null——本处不需再 catch；门态派生会自然停在 loading（catalog 为 null）。
 * 用户后续打开设置面板（PiModelsPanel onMounted 也会再拉）有机会恢复。
 */
onMounted(() => {
  void refreshPiCatalog()
})

// T56：已作答/已跳过表单 formId 集——扫 user 消息文本首行信封标记
// （重载后已答表单置灰的唯一信号，formId 相关性降级口径见 T56-plan §1 定谳 6）
const answeredFormIds = computed(() => {
  const ids = new Set<string>()
  for (const message of messages.value) {
    if (message.role !== 'user') continue
    for (const part of message.parts) {
      if (!isTextUIPart(part)) continue
      const parsed = parseAskAnswer(part.text)
      if (parsed) ids.add(parsed.formId)
    }
  }
  return ids
})
const failureMessage = computed(() => {
  switch (chatFailure.value?.reason) {
    case 'insufficient-credit':
      return ai.value.chatInsufficientCredit
    case 'output-limit':
      return ai.value.chatOutputLimit
    case 'request-failed':
      return ai.value.chatRequestFailed
    default:
      return null
  }
})
const status = computed(() => chat.value?.status ?? 'ready')
function isStreamingMessage(message: UIMessage, index: number): boolean {
  return (
    message.role === 'assistant' &&
    index === messages.value.length - 1 &&
    (status.value === 'submitted' || status.value === 'streaming')
  )
}
const isThinking = computed(() => {
  const s = status.value
  if (s !== 'submitted' && s !== 'streaming') return false
  if (messages.value.length === 0) return true
  const last = messages.value[messages.value.length - 1]
  if (last.role !== 'assistant') return true
  const parts = last.parts
  if (parts.length === 0) return true
  const lastPart = parts[parts.length - 1] as JSONObject
  if (lastPart.type === 'step-start') return true
  // T93：reasoning 流式期间保持三圆点——否则思考过程零反馈（预研 §5.1）
  if (lastPart.type === 'reasoning') return true
  if ('toolCallId' in lastPart && lastPart.state === 'output-available') return true
  if ('toolCallId' in lastPart && lastPart.state === 'output-error') return true
  return s === 'submitted'
})

function scrollToBottom() {
  nextTick(() => {
    messagesEnd.value?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  })
}

watch(messages, scrollToBottom, { deep: true })
watch(
  () => chatFailure.value?.reason,
  (reason) => {
    if (!reason) return
    // T94：用户主动停止引发的 SSE 断开会走 onError → chatFailure——吞掉
    // （停止不是错误）；旗标复位交给下方 status watcher（error 分支）
    if (isUserStopped.value) {
      clearChatFailure()
      return
    }
    toast.error(failureMessage.value ?? ai.value.chatRequestFailed)
  }
)
// T94：停止收尾——ready = 正常停止（toast + 末条消息瞬时「已停止」行）；
// error = 停止引发的断开被 AI SDK 判负（onError 先于 setStatus 同步触发，
// chatFailure 已由上方 watcher 吞掉），此处消费旗标 + clearError 把 status
// 拉回 ready，与干净 abort 路径终态一致（ai@7 AbstractChat.makeRequest 实证：
// isAbort 命中时落 ready，竞态漏网时落 error）
watch(status, (s) => {
  if (!isUserStopped.value) return
  if (s === 'ready') {
    isUserStopped.value = false
    justStopped.value = true
    toast.info(confirmText.value.chatStopped)
  } else if (s === 'error') {
    isUserStopped.value = false
    clearChatFailure()
    chat.value?.clearError()
  }
})
watch(
  () => activeTab.value?.id,
  async () => {
    const nextChat = await ensureChat()
    chat.value = nextChat ? markRaw(nextChat) : null
    refreshSessionMeta()
  }
)
// T22：restore/打开文件在同 store 上 replaceGraph（tab id 不变，上面的 watcher
// 不触发）——图替换后 docId 才就位，重跑 ensureChat 补上历史回填
watch(
  () => activeTab.value?.store,
  (store, _prev, onCleanup) => {
    if (!store) return
    const stop = store.onEditorEvent('graph:replaced', () => {
      void ensureChat().then((nextChat) => {
        if (nextChat) chat.value = markRaw(nextChat)
        refreshSessionMeta()
        return undefined
      })
    })
    onCleanup(stop)
  },
  { immediate: true }
)

// T23：会话查看/切换（E3/E5）——下拉打开时实时拉族谱清单（不做轮询/缓存）；
// 切换即采用该 sessionId 并整体替换消息（后续发送续写被选会话）
const sessionMenuCls = useMenuUI({ content: 'min-w-56 max-w-72' })
const sessionItemCls = menuItem({ justify: 'start' })
const sessionList = ref<PiSessionSummary[]>([])
const currentSessionId = ref<string | null>(null)
const sessionMenuReady = ref(false)

function refreshSessionMeta() {
  const store = getActiveEditorStore()
  sessionMenuReady.value = hasPiDocId(store)
  currentSessionId.value = getPiCurrentSessionId(store)
}

async function handleSessionMenuOpen(open: boolean) {
  if (!open) return
  refreshSessionMeta()
  const list = await listPiSessionFamily(getActiveEditorStore())
  if (list) sessionList.value = list
}

const sessionTriggerLabel = computed(() =>
  currentSessionId.value ? sessionTimeLabel(currentSessionId.value) : 'Sessions'
)
const currentSessionMissing = computed(
  () =>
    currentSessionId.value !== null &&
    !sessionList.value.some((s) => s.sessionId === currentSessionId.value)
)

function sessionTimeLabel(sessionId: string): string {
  const match = /-(\d{8})T(\d{6})Z$/.exec(sessionId)
  if (!match) return sessionId
  const [, day, time] = match
  const date = new Date(
    `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T` +
      `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`
  )
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function handleSwitchSession(sessionId: string) {
  if (status.value === 'streaming' || status.value === 'submitted') return
  if (sessionId === currentSessionId.value) return
  const switched = await switchPiSession(getActiveEditorStore(), sessionId)
  if (!switched) {
    toast.error(ai.value.chatRequestFailed)
    return
  }
  const currentChat = chat.value ?? (await ensureChat())
  if (!currentChat) return
  currentChat.messages = switched
  chat.value = markRaw(currentChat)
  currentSessionId.value = sessionId
  sessionMenuReady.value = true
}

async function handleSubmit(text: string) {
  if (status.value === 'streaming' || status.value === 'submitted') return
  // T61：chips 未确认新建意向存在 → 发送前拦为聊天内确认卡（宿主发起非工具
  // part；共享契约 1/4）。消息留输入框，chips 暂存不清——确认/取消由卡片决断。
  const intent = piPendingNewIntent.value
  if (intent) {
    const intercepted = await interceptNewIntent(text, intent)
    if (intercepted) return
    // chat 不可用（ensureChat 失败）→ 不发送，草稿回填由 interceptNewIntent 兜底
    return
  }
  clearChatFailure()
  try {
    // 恒走 ensureChat：transport dirty（如 e2e mock 后注入）时重建会话，
    // 避免持有旧 transport 的 stale Chat
    const currentChat = await ensureChat()
    if (!currentChat) {
      toast.error(ai.value.chatRequestFailed)
      chatInputRef.value?.restoreDraft(text)
      return
    }
    chat.value = markRaw(currentChat)
    await currentChat.sendMessage({ text })
    // T27：ai SDK 的 sendMessage 内部吞错（错误走 onError + status='error'，
    // 不 reject——node_modules/ai AbstractChat.makeRequest 实证）——失败时回填草稿
    if (currentChat.status === 'error') chatInputRef.value?.restoreDraft(text)
    refreshSessionMeta()
  } catch (e) {
    console.error('Chat error:', e)
    toast.error(ai.value.chatRequestFailed)
    chatInputRef.value?.restoreDraft(text)
  }
}

async function handleStop() {
  // T94：先立旗标再 stop——stop 触发的 SSE 断开若被 SDK 判负（status='error'），
  // chatFailure watcher 凭旗标吞掉该假错误
  isUserStopped.value = true
  // T98：stop() 会同步触发 SDK 内部无人 await 的流泵 rejection——await/catch
  // 捕不到（实证），先立窗口期旗标，transports 的 unhandledrejection 守卫
  // 按「窗口期 + abort 形状 + AbstractChat.stop 栈归因」三重收窄后吞掉
  markIntentionalStop()
  try {
    // ai SDK 的 stop 是 async 函数：abort 抛错走 rejected promise 而非同步
    // throw——不 await 时 try/catch 形同虚设，rejection 逃逸成 unhandled
    // （owner 实测 console 仍见 AbortError: BodyStreamBuffer was aborted）。
    // await 后 catch 对同步/异步两轨同捕；Vue 对 async handler 的 rejection
    // 仍会走 error handling，非 abort 形状的异常可见性不丢。
    await chat.value?.stop()
  } catch (e) {
    // SDK 的 stop() 内部 reader.cancel 会把「BodyStreamBuffer was aborted」
    // 以 AbortError 回抛（用户主动停止的预期形态）——吞掉，不污染 console
    if (!isAbortShapedError(e)) throw e
  }
  finalizeInterruptedToolParts()
}

/** T98：用户停止把流掐断后，在途工具 part 永远停在 input-streaming/
 *  input-available——卡片「正在运行…」不再收终态（owner 实测停止后卡死态）。
 *  stop 完成后把末条 assistant 消息的未终结工具 part 落 SDK 终止态
 *  output-error，卡片转「错误」收尾；SDK 若已自行终结（正常完成路径）
 *  则 touched=false 零副作用。 */
function finalizeInterruptedToolParts(): void {
  const currentChat = chat.value
  if (!currentChat) return
  const messages = [...currentChat.messages]
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return
  let touched = false
  const parts = last.parts.map((part) => {
    if (!isToolUIPart(part)) return part
    if (part.state !== 'input-streaming' && part.state !== 'input-available') return part
    touched = true
    // AI SDK 类型机：output-error 变体要求 input 键存在（unknown——值可为
    // undefined）——中断时 input 可能未到齐，显式带上现有值满足不变量。
    // 不能用 satisfies typeof part：那会把返回类型钉死在收窄后的 input-*
    // 变体上，state:'output-error' 反而报错
    return {
      ...part,
      state: 'output-error' as const,
      input: part.input,
      errorText: 'Stopped by user.'
    }
  })
  if (touched) {
    messages[messages.length - 1] = { ...last, parts }
    currentChat.messages = messages
  }
}

// 2026-09-15：表单作答/跳过 → 直接 POST /api/pi/ask-answer（ask_user_question
// 硬阻断新流——execute 挂起期间 agent 物理停摆，答案通过新端点 resolve 进
// 同一工具结果；不再经聊天消息文本信封回流）。
// 不接 streaming/submitted guard：本端点独立于聊天提交路径，挂起期间
// ChatPanel 仍可交互作答（disabled 透传已被卡片摘除——见 PiChatMessage）。
/** core AskQuestionAnswer.value 可空（输入中槽位）；卡片提交时已归一但类型
 *  不表——此处收窄到端点契约 {value: string}，空值槽丢弃（卡片必填校验兜底） */
function normalizeAnswers(
  submission: Extract<AskFormSubmission, { aborted: false }>
): Record<string, { value: string; freeText?: string }> {
  const out: Record<string, { value: string; freeText?: string }> = {}
  for (const [qid, answer] of Object.entries(submission.answers)) {
    if (typeof answer.value !== 'string') continue
    out[qid] =
      typeof answer.freeText === 'string'
        ? { value: answer.value, freeText: answer.freeText }
        : { value: answer.value }
  }
  return out
}

async function handleFormSubmit(submission: AskFormSubmission) {
  try {
    if (submission.aborted) {
      await postAskAnswer({ formId: submission.formId, skip: true })
      return
    }
    await postAskAnswer({ formId: submission.formId, answers: normalizeAnswers(submission) })
  } catch (error) {
    // 失败面：后端 pending 已失效（abort/重启）或网络错误——卡片保留本地
    // submittedKind 早退锁，不重投；留 warn 供诊断（no-silent-catch 纪律）
    console.warn(
      '[ask] 表单作答提交失败：' + (error instanceof Error ? error.message : String(error))
    )
  }
}

// ── T61：新建意图确认卡（宿主发起 data part） ──────────────────────────────

/** 拦截时刻的草稿（确认发出时的正文；取消时输入框已回填同文） */
const pendingIntentDraft = ref<string | null>(null)

/** 追加宿主发起的 assistant 消息（本地，不经 transport 发送） */
async function appendHostMessage(parts: UIMessage['parts']): Promise<UIMessage | null> {
  const currentChat = await ensureChat()
  if (!currentChat) return null
  const message: UIMessage = {
    id: `host-${crypto.randomUUID()}`,
    role: 'assistant',
    parts
  }
  currentChat.messages = [...currentChat.messages, message]
  chat.value = markRaw(currentChat)
  return message
}

async function interceptNewIntent(
  text: string,
  intent: { modeId: string; profileId: string | null }
): Promise<boolean> {
  const store = getActiveEditorStore()
  const active = piActiveDesign.value
  // 共享契约 4 物化判据（core active-design.ts 单源；active-design.ts 钉扎）：Case A/B 话术分叉
  const materialized = active ? isDesignRootMaterialized(store, active.nodeId) : false
  // T65：尺寸行预设 = 选中 mode 的 manifest.sizes 投影（[{label,canvas}] 契约，
  // 防御性归一在 modeSizeChoices；数据面由 core/manifest 侧落地）
  const modeEntry = piStudioManifest.value?.modes.find((mode) => mode.id === intent.modeId) ?? null
  const data: NewIntentPartData = {
    modeId: intent.modeId,
    profileId: intent.profileId,
    caseKind: materialized ? 'B' : 'A',
    activeDesignName: active?.name ?? null,
    sizeChoices: modeSizeChoices(modeEntry),
    references: materialized && active ? collectDesignImageRefs(store, active.nodeId) : [],
    resolved: null
  }
  const message = await appendHostMessage([{ type: NEW_INTENT_PART_TYPE, data }])
  if (!message) {
    toast.error(ai.value.chatRequestFailed)
    chatInputRef.value?.restoreDraft(text)
    return false
  }
  pendingIntentDraft.value = text
  // 消息留输入框（PiChatInput 提交即清空——拦截不等于发送）
  chatInputRef.value?.restoreDraft(text)
  return true
}

/** 决断写回 part data.resolved——重载后卡片置灰的派生源（同 answeredFormIds 纪律） */
function resolveIntentPart(messageId: string, resolved: 'confirmed' | 'cancelled') {
  const currentChat = chat.value
  if (!currentChat) return
  currentChat.messages = currentChat.messages.map((message) =>
    message.id === messageId
      ? {
          ...message,
          parts: message.parts.map((part) =>
            part.type === NEW_INTENT_PART_TYPE && 'data' in part
              ? {
                  ...part,
                  data: { ...(part.data as NewIntentPartData), resolved }
                }
              : part
          )
        }
      : message
  )
  chat.value = markRaw(currentChat)
}

async function handleIntentConfirm(payload: {
  messageId: string
  referenceNodeIds: string[]
  canvas: string | null
}) {
  if (status.value === 'streaming' || status.value === 'submitted') return
  const intent = piPendingNewIntent.value
  const draft = pendingIntentDraft.value ?? ''
  resolveIntentPart(payload.messageId, 'confirmed')
  pendingIntentDraft.value = null
  clearPiPendingNewIntent()
  chatInputRef.value?.clearDraft()
  // 共享契约 1 逐字信封（全字段可缺省；T65 §2.4 扩展 canvas）+ 用户消息；
  // 宿主（T60/T65）剥离置旗标
  const envelope = serializeNewIntentEnvelope({
    modeId: intent?.modeId ?? null,
    profileId: intent?.profileId ?? null,
    canvas: payload.canvas
  })
  // 携带物：已生成图片 references（信封字段不动契约，节点 id 以正文行携带进 run）
  const referencesLine =
    payload.referenceNodeIds.length > 0
      ? `\n\n参考图片（已生成产物，作为 references 携带）：${payload.referenceNodeIds.join('、')}`
      : ''
  await handleSubmit(`${envelope}\n${draft}${referencesLine}`)
}

function handleIntentCancel(payload: { messageId: string }) {
  if (status.value === 'streaming' || status.value === 'submitted') return
  resolveIntentPart(payload.messageId, 'cancelled')
  pendingIntentDraft.value = null
  // 取消 → chips 回滚回显（清空暂存即回落 active 回显）；消息留输入框
  clearPiPendingNewIntent()
}

// ── T61：set_active_design 同意卡（共享契约 3） ─────────────────────────────

/** 已决断 toolCallId → decision（扫宿主决定记录 data part 派生，重载后保持置灰） */
const consentDecisions = computed(() => {
  const map = new Map<string, 'agreed' | 'declined'>()
  for (const message of messages.value) {
    for (const part of message.parts) {
      if (part.type !== ACTIVE_DESIGN_DECISION_PART_TYPE || !('data' in part)) continue
      const data = part.data as Partial<ActiveDesignDecisionPartData> | undefined
      if (typeof data?.toolCallId !== 'string') continue
      map.set(data.toolCallId, data.decision === 'agreed' ? 'agreed' : 'declined')
    }
  }
  return map
})

/** T91b：setup_design awaiting 信封已决断 toolCallId 集（按 toolCallId 置灰） */
const awaitingIntentDecisions = ref<Set<string>>(new Set())

/** 从工具 part output 取 proposed（{proposed:{nodeId,...}}，共享契约 3；解析单源在 active-design.ts。
 *  注意读 output 不读 input——input 是工具入参 {node_id}，proposed 在结果里（核验钉死）） */
function consentProposed(toolCallId: string): { nodeId: string | null; name: string | null } {
  for (const message of messages.value) {
    for (const part of message.parts) {
      if (!('toolCallId' in part) || part.toolCallId !== toolCallId) continue
      const output = (part as { state?: string; output?: unknown }).output
      const proposed = parseSetActiveDesignProposed(output)
      if (proposed.nodeId !== null || proposed.name !== null) return proposed
    }
  }
  return { nodeId: null, name: null }
}

async function handleConsentDecide(payload: { toolCallId: string; agree: boolean }) {
  if (status.value === 'streaming' || status.value === 'submitted') return
  if (consentDecisions.value.has(payload.toolCallId)) return
  const proposed = consentProposed(payload.toolCallId)
  const designName = proposed.name ?? proposed.nodeId ?? payload.toolCallId

  let switched = false
  let line: string | null = null
  if (payload.agree && proposed.nodeId) {
    // 同意 → 切换端点（共享契约 2，与画布状态面板「设为当前」共用）
    const result = await postActiveDesign(proposed.nodeId)
    if (result) {
      resyncPiActiveDesign()
      switched = true
    } else {
      line = confirmText.value.consentFailedLine
    }
  } else if (payload.agree) {
    line = confirmText.value.consentFailedLine
  } else {
    line = confirmText.value.consentDeclinedLine({ name: designName })
  }
  // 两侧均不伪装用户消息：决定记录 data part（置灰派生源）+ 回执。
  // T65（决策 D3）：同意成功的回执 = 对话流分割线（data-context-switch），
  // 替换原本地系统行；失败 / 拒绝仍走文本行。
  const parts: UIMessage['parts'] = [
    {
      type: ACTIVE_DESIGN_DECISION_PART_TYPE,
      data: {
        toolCallId: payload.toolCallId,
        decision: payload.agree ? 'agreed' : 'declined',
        designName
      } satisfies ActiveDesignDecisionPartData
    }
  ]
  if (switched) {
    parts.push({
      type: CONTEXT_SWITCH_PART_TYPE,
      data: { name: designName } satisfies ContextSwitchPartData
    })
  } else if (line !== null) {
    parts.push({ type: 'text', text: line })
  }
  await appendHostMessage(parts)
}

/** T65（决策 D3）：画布状态面板「设为当前」端点 200 后注入分割线回执 */
async function handleContextSwitch(payload: { name: string }) {
  await appendHostMessage([
    {
      type: CONTEXT_SWITCH_PART_TYPE,
      data: { name: payload.name } satisfies ContextSwitchPartData
    }
  ])
}

// ── T91b：setup_design awaiting_new_intent_confirmation 信封处理 ─────────────

/**
 * 用户在 ChatAwaitingIntentCard 点 Confirm →
 *   1. POST /api/pi/intent-confirm（写 document root pluginData 三键）
 *   2. abort 当前 session（停止 AI 等待循环，避免继续重放 setup_design）
 *   3. 注入 system 行回执（前端告诉用户成功/失败）
 *
 * 之后用户需自己重发 prompt 或点输入框发送按钮——abort 不会自动重放；
 * 这是显式决策点，避免 AI 在不确定的状态下继续推进。
 */
async function handleIntentAwaitingConfirm(payload: {
  toolCallId: string
  modeId: string
  profileId: string
}): Promise<void> {
  if (awaitingIntentDecisions.value.has(payload.toolCallId)) return
  awaitingIntentDecisions.value.add(payload.toolCallId)
  const result = await postIntentConfirm({
    modeId: payload.modeId,
    ...(payload.profileId !== '' ? { profileId: payload.profileId } : {})
  })
  // T91b：截停当前 SSE 流——AI 不再继续重放 setup_design。
  // 用户主动重发消息即可（pluginData 已落，下次 prepareTurn 真源命中 → core 放行）。
  try {
    chat.value?.stop()
  } catch (error) {
    console.warn('[chat] stop after intent confirm failed:', error)
  }
  if (result.ok) {
    toast.info(confirmText.value.awaitingIntentConfirmedToast ?? '已确认')
    await appendHostMessage([
      {
        type: 'text',
        text:
          confirmText.value.awaitingIntentConfirmedLine ?? '已确认新建意图——可以重发需求继续创建。'
      }
    ])
  } else {
    toast.error(result.message)
    await appendHostMessage([
      {
        type: 'text',
        text:
          confirmText.value.awaitingIntentFailedLine?.({ msg: result.message }) ??
          `确认失败：${result.message}`
      }
    ])
  }
}

/** 用户在 ChatAwaitingIntentCard 点 Cancel → 注入 system 行，置灰卡片 */
async function handleIntentAwaitingCancel(payload: {
  toolCallId: string
  modeId: string
  profileId: string
}): Promise<void> {
  if (awaitingIntentDecisions.value.has(payload.toolCallId)) return
  awaitingIntentDecisions.value.add(payload.toolCallId)
  try {
    chat.value?.stop()
  } catch (error) {
    console.warn('[chat] stop after intent cancel failed:', error)
  }
  await appendHostMessage([
    {
      type: 'text',
      text: confirmText.value.awaitingIntentCancelledLine ?? '已取消新建意图。'
    }
  ])
}

async function handleCopyDebug() {
  await copyChatLog(messages.value, chatFailure.value)
  debugCopied.value = true
}

function handleClearChat() {
  clearChatFailure()
  chat.value = null
  // T27：resetChat 现在 await 铸新会话完成（onSessionReset 返回 Promise），
  // then 里确定性刷新会话栏元信息——替代原 setTimeout(100) 魔法数等待
  void resetChat()
    .then(() => {
      refreshSessionMeta()
      return undefined
    })
    .catch((error: unknown) => {
      console.error('Chat reset error:', error)
    })
}
</script>

<template>
  <div data-test-id="chat-panel" class="flex min-w-0 flex-1 flex-col overflow-hidden select-text">
    <!-- T23 会话栏：族谱查看/切换（docId 未铸造或族为空时菜单内空态项）；
         T65：旁挂画布工作状态面板（ChatContextBar 三合一，决策 B2——trigger =
         当前设计名，无 active = 空槽引导） -->
    <div
      data-test-id="chat-session-bar"
      class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1"
    >
      <DropdownMenuRoot @update:open="handleSessionMenuOpen">
        <Tip :label="currentSessionId ?? undefined">
          <DropdownMenuTrigger as-child>
            <AppTextButton
              data-test-id="chat-session-trigger"
              :ui="{ base: 'flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover' }"
            >
              <icon-lucide-history class="size-3" />
              {{ sessionTriggerLabel }}
              <icon-lucide-chevron-down class="size-3" />
            </AppTextButton>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuPortal>
          <DropdownMenuContent
            side="bottom"
            align="start"
            :side-offset="3"
            :class="sessionMenuCls.content"
            data-test-id="chat-session-menu"
          >
            <DropdownMenuItem
              v-if="!sessionMenuReady || sessionList.length === 0"
              disabled
              :class="sessionItemCls"
            >
              <span>No sessions yet</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="currentSessionMissing"
              disabled
              :class="sessionItemCls"
              data-test-id="chat-session-current-unsent"
            >
              <icon-lucide-check :class="sessionMenuCls.icon" />
              <span>{{ sessionTriggerLabel }} · new session</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              v-for="session in sessionList"
              :key="session.sessionId"
              :class="sessionItemCls"
              :data-test-id="`chat-session-item`"
              :data-session-id="session.sessionId"
              @select="handleSwitchSession(session.sessionId)"
            >
              <icon-lucide-check
                v-if="session.sessionId === currentSessionId"
                :class="sessionMenuCls.icon"
              />
              <span v-else class="size-3 shrink-0" />
              <span class="min-w-0 truncate">
                {{ sessionTimeLabel(session.sessionId) }} · {{ session.title || '(empty)' }} ·
                {{ session.messageCount }} msgs
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <!-- T65：画布工作状态面板（三合一）；切换成功 → 分割线回执 -->
      <ChatContextBar
        :disabled="status === 'streaming' || status === 'submitted'"
        @switched="handleContextSwitch"
      />
    </div>

    <ScrollAreaRoot class="min-h-0 flex-1">
      <ScrollAreaViewport class="h-full px-3 py-3 [&>div]:h-full">
        <AppPlaceholder
          v-if="messages.length === 0"
          data-test-id="chat-empty-state"
          :label="ai.describeCreateOrChange"
          :ui="{ root: 'h-full' }"
        >
          <template #icon>
            <icon-lucide-message-circle class="size-5" />
          </template>
        </AppPlaceholder>

        <!-- Messages -->
        <div v-else data-test-id="chat-messages" class="flex flex-col gap-3">
          <PiChatMessage
            v-for="(msg, index) in messages"
            :key="msg.id"
            :message="msg"
            :streaming="isStreamingMessage(msg, index)"
            :stopped="index === messages.length - 1 && justStopped"
            :answered-form-ids="answeredFormIds"
            :consent-decisions="consentDecisions"
            @form-submit="handleFormSubmit"
            @intent-confirm="handleIntentConfirm"
            @intent-cancel="handleIntentCancel"
            @consent-decide="handleConsentDecide"
            @intent-awaiting-confirm="handleIntentAwaitingConfirm"
            @intent-awaiting-cancel="handleIntentAwaitingCancel"
          />

          <!-- Thinking indicator: shown when AI is working but no visible activity -->
          <div v-if="isThinking" data-test-id="chat-typing-indicator" class="flex gap-2">
            <div
              class="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted/20 text-[10px] font-bold text-muted"
            >
              AI
            </div>
            <div class="flex items-center gap-1 py-2">
              <span
                class="size-1.5 animate-bounce rounded-full bg-muted"
                style="animation-delay: 0ms"
              />
              <span
                class="size-1.5 animate-bounce rounded-full bg-muted"
                style="animation-delay: 150ms"
              />
              <span
                class="size-1.5 animate-bounce rounded-full bg-muted"
                style="animation-delay: 300ms"
              />
            </div>
          </div>

          <div ref="messagesEnd" />
        </div>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar orientation="vertical" class="flex w-1.5 touch-none p-px select-none">
        <ScrollAreaThumb class="relative flex-1 rounded-full bg-muted/30" />
      </ScrollAreaScrollbar>
    </ScrollAreaRoot>

    <!-- Chat toolbar -->
    <div
      v-if="messages.length > 0"
      class="flex shrink-0 items-center gap-1 border-t border-border px-3 py-1"
    >
      <AppTextButton
        v-if="IS_DEV"
        :ui="{
          base: 'flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover'
        }"
        @click="handleCopyDebug"
      >
        <icon-lucide-clipboard-copy v-if="!debugCopied" class="size-3" />
        <icon-lucide-check v-else class="size-3 text-green-400" />
        {{ debugCopied ? 'Copied' : 'Copy log' }}
      </AppTextButton>
      <AppTextButton
        :ui="{
          base: 'flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover'
        }"
        @click="handleClearChat"
      >
        <icon-lucide-trash-2 class="size-3" />
        Clear
      </AppTextButton>
    </div>

    <!-- pi-model-explicit-config（§3 落地清单 1）—— 引导门：
         ready 才渲染输入框；loading / needs-setup / needs-credential 三态由派生
         门态 gateState 决定——loading 显示骨架占位，needs-* 显示引导卡。
         输入框不渲染 = 从根上消灭未配置发送的死路（spec b）。 -->
    <PiChatInput
      v-if="isGateReady"
      :key="chatInputRemountKey"
      ref="chatInputRef"
      :status="status"
      @submit="handleSubmit"
      @stop="handleStop"
      @error="toast.error"
      @seg-root-lost="handleSegRootLost"
    />
    <div
      v-else-if="gateState.kind === 'loading'"
      data-test-id="pi-provider-gate-loading"
      class="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted"
    >
      <icon-lucide-loader-2 class="size-3 animate-spin" />
      {{ piDialogs.providerGateLoading }}
    </div>
    <PiProviderGateCard v-else-if="gateCardState" :state="gateCardState" />

    <!-- T66（决策②）：需求单大面板——ChatContextBar 列表条目点击打开；
         开关状态在 chat/active-design.ts 模块级 ref（settings/dialog.ts 先例） -->
    <ChatBriefDialog />
  </div>
</template>
