<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import { isFileUIPart, isReasoningUIPart, isTextUIPart, isToolUIPart, getToolName } from 'ai'
import type { UIDataTypes, UIMessage, UIMessagePart, UITools } from 'ai'
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui'
// Batch 2a 命名分离（2026-09-05）：本组件自 ChatMessage.vue 改名 PiChatMessage.vue，
// 原名留给 deletedPaths 落账——组件已实质重写，与上游 ChatMessage 无合并语义。
import { computed } from 'vue'

import type { AskFormSubmission } from '@open-pencil/core/tools/fork/marketing/ask-user-question'
import { useI18n, vTestId } from '@open-pencil/vue'

import { useForkConfirm } from '@/app/i18n/fork'
import IconButton from '@/components/ui/button/IconButton.vue'

import {
  CONTEXT_SWITCH_PART_TYPE,
  NEW_INTENT_PART_TYPE,
  normalizeSizeChoices,
  parseSetupAwaitingIntent,
  type ContextSwitchPartData,
  type NewIntentPartData
} from './active-design'
import AskUserQuestionCard from './AskUserQuestionCard.vue'
import ChatAwaitingIntentCard from './ChatAwaitingIntentCard.vue'
import ChatMarkdown from './ChatMarkdown.vue'
import ChatNewIntentCard from './ChatNewIntentCard.vue'
import ChatSetActiveDesignCard from './ChatSetActiveDesignCard.vue'
import {
  AUTHZ_REQUEST_PART_TYPE,
  authzToolCallId,
  getAuthzResolved,
  parseAuthzRequestData,
  type AuthzDecisionView
} from './pending-decision'
import PendingDecisionCard from './PendingDecisionCard.vue'
import { displayToolOutput } from './tool-output'
import { classifyToolState } from './tool-state'

const {
  message,
  streaming = false,
  stopped = false,
  answeredFormIds,
  consentDecisions
} = defineProps<{
  message: UIMessage
  streaming?: boolean
  /** T94：用户主动停止回执——末条消息底部瞬时「已停止」小字行（ChatPanel justStopped 派生） */
  stopped?: boolean
  /** T56：已作答/已跳过表单的 formId 集（ChatPanel 扫用户消息信封派生） */
  answeredFormIds?: ReadonlySet<string>
  /** T61：set_active_design 同意决定（ChatPanel 扫 data part 记录派生，按 toolCallId） */
  consentDecisions?: ReadonlyMap<string, 'agreed' | 'declined'>
}>()
const emit = defineEmits<{
  formSubmit: [submission: AskFormSubmission]
  /** T61：新建意图确认卡决断（ChatPanel 发信封 / 回滚 chips）；T65：canvas 随确认进信封 */
  intentConfirm: [payload: { messageId: string; referenceNodeIds: string[]; canvas: string | null }]
  intentCancel: [payload: { messageId: string }]
  /** T61：set_active_design 同意卡决断（同意调端点 / 不同意本地系统行） */
  consentDecide: [payload: { toolCallId: string; agree: boolean }]
  /** T91b：setup_design awaiting_new_intent_confirmation 信封 → ChatPanel 调 intent-confirm + abort */
  intentAwaitingConfirm: [payload: { toolCallId: string; modeId: string; profileId: string }]
  intentAwaitingCancel: [payload: { toolCallId: string; modeId: string; profileId: string }]
}>()
const { ai } = useI18n()
const confirmText = useForkConfirm()
const markdownMode = computed(() => (streaming ? 'streaming' : 'static'))

// D9（2026-09-18 chat-p1）：复制响应按钮——移植上游 d7971ff03 ChatMessage.vue：
// 首个非空 text part 气泡右下角挂复制钮，复制整条 assistant 文本（全 text part
// 拼接），1.5s 对勾复位。clipboard 复用仓内 CodePanel 先例（useClipboard +
// copiedDuring 自复位），不引入上游组件。
const assistantText = computed(() =>
  message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join('')
)
const firstAssistantTextPartIndex = computed(() =>
  message.parts.findIndex((part) => isTextUIPart(part) && part.text.length > 0)
)
const { copy, copied, isSupported: clipboardSupported } = useClipboard({ copiedDuring: 1500 })

async function copyResponse(): Promise<void> {
  if (!assistantText.value || !clipboardSupported.value) return
  await copy(assistantText.value)
}

type ToolPart = Extract<UIMessagePart<UIDataTypes, UITools>, { toolCallId: string }>

/** T56：awaiting 信封 details（骑 mapping 到 part.output）里的 formId */
function askFormId(part: ToolPart): string | null {
  if (part.state !== 'output-available') return null
  const output = part.output
  if (typeof output === 'object' && output !== null && 'formId' in output) {
    const id = (output as { formId?: unknown }).formId
    return typeof id === 'string' ? id : null
  }
  return null
}

function isAskFormAnswered(part: ToolPart): boolean {
  const id = askFormId(part)
  return id !== null && (answeredFormIds?.has(id) ?? false)
}

/** 2026-09-18 broker P1：ask 未决（流式中 + 工具 input-* 挂起态 + 未答）由输入区
 *  pinned 卡承接——本组件内联渲染抑制，避免同一表单双份交互面；已决/历史表单
 *  （output-available / output-error / answered）不受影响，照常内联渲染归档 */
function isAskPinned(part: ToolPart): boolean {
  if (!streaming) return false
  if (part.state !== 'input-streaming' && part.state !== 'input-available') return false
  return !isAskFormAnswered(part)
}

// ── 2026-09-18 broker P1：authz 授权请求 data part（已决/失效归档渲染） ────────

function isAuthzRequestPart(part: UIMessagePart<UIDataTypes, UITools>): boolean {
  return part.type === AUTHZ_REQUEST_PART_TYPE && 'data' in part
}

/** 内联归档视图派生：已决（会话 resolved map 全量细节）→ 流式中未决由 pinned
 *  dock 承接（返回 null 不内联渲染）→ 未决但轮次已结束 = expired 弱化归档 */
function authzInlineDecision(part: UIMessagePart<UIDataTypes, UITools>): AuthzDecisionView | null {
  const request = parseAuthzRequestData('data' in part ? part.data : null)
  if (!request) return null
  const record = getAuthzResolved(request.formId)
  if (record) return { kind: 'authz', request, mode: 'resolved', record }
  if (streaming) return null
  return {
    kind: 'authz',
    request,
    mode: 'expired',
    expiredHint: deriveAuthzOutcome(request.formId)
  }
}

/** 重载降级推导：formId（'authz-'+toolCallId）反查同消息 bash 工具 part 终态——
 *  output-available = 已放行执行；output-error = 被拒绝/轮次中断（细节不可考） */
function deriveAuthzOutcome(formId: string): 'executed' | 'blocked' | null {
  const toolCallId = authzToolCallId(formId)
  if (!toolCallId) return null
  for (const part of message.parts) {
    if (!isToolUIPart(part) || part.toolCallId !== toolCallId) continue
    if (part.state === 'output-available') return 'executed'
    if (part.state === 'output-error') return 'blocked'
  }
  return null
}

/** T61：宿主发起的新建意图确认卡 data part 判定 + 载荷防御性归一 */
function isNewIntentPart(part: UIMessagePart<UIDataTypes, UITools>): boolean {
  return part.type === NEW_INTENT_PART_TYPE && 'data' in part
}

function newIntentData(part: UIMessagePart<UIDataTypes, UITools>): NewIntentPartData {
  const raw = ('data' in part ? part.data : null) as Partial<NewIntentPartData> | null
  return {
    modeId: typeof raw?.modeId === 'string' ? raw.modeId : null,
    profileId: typeof raw?.profileId === 'string' ? raw.profileId : null,
    activeDesignName: typeof raw?.activeDesignName === 'string' ? raw.activeDesignName : null,
    sizeChoices: normalizeSizeChoices(raw?.sizeChoices),
    resolved: raw?.resolved === 'confirmed' || raw?.resolved === 'cancelled' ? raw.resolved : null
  }
}

/** T65（决策 D3）：上下文切换分割线 data part 判定 + 载荷防御性归一 */
function isContextSwitchPart(part: UIMessagePart<UIDataTypes, UITools>): boolean {
  return part.type === CONTEXT_SWITCH_PART_TYPE && 'data' in part
}

function contextSwitchName(part: UIMessagePart<UIDataTypes, UITools>): string {
  const raw = ('data' in part ? part.data : null) as Partial<ContextSwitchPartData> | null
  return typeof raw?.name === 'string' && raw.name !== '' ? raw.name : '—'
}

function toolDisplayName(part: ToolPart): string {
  return getToolName(part)
    .replace(/^mcp__[^_]+__/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function toolState(part: ToolPart): 'pending' | 'done' | 'error' {
  // 委托上游 classifyToolState（b65b1bd4：MCP output-available+isError:true 不再误判 done）
  return classifyToolState({
    toolName: getToolName(part),
    state: part.state,
    output: part.output
  })
}

function partKey(part: UIMessagePart<UIDataTypes, UITools>, index: number): string {
  if ('toolCallId' in part) return part.toolCallId
  return `part-${index}`
}

/** T81 P-01：AI SDK `file` chunk（media-output.ts:48-70 产 base64 data URL）的展示。
 * 图像直渲；非图像（视频/音频/...）保守回落文件名占位（不再吞）。 */
type FilePart = Extract<UIMessagePart<UIDataTypes, UITools>, { type: 'file' }>

function filePartAlt(part: FilePart): string {
  const tail = part.url.split('/').pop() ?? ''
  const isImage = part.mediaType.startsWith('image/')
  return isImage ? `AI attachment (${part.mediaType})` : `AI attachment: ${tail || part.mediaType}`
}

function filePartFilename(part: FilePart): string {
  return part.url.split('/').pop() || part.mediaType
}
</script>

<template>
  <div
    v-test-id="`chat-message-${message.role}`"
    :class="message.role === 'user' ? 'flex justify-end' : ''"
  >
    <div
      class="min-w-0 space-y-2 select-text"
      :class="message.role === 'user' ? 'max-w-[85%]' : ''"
    >
      <template v-if="message.role === 'assistant'">
        <template v-for="(part, i) in message.parts" :key="partKey(part, i)">
          <!-- T56→2026-09-15：ask_user_question → 聊天内表单卡片（先于通用折叠工具卡）
               摘除 :disabled="streaming"——挂起期卡片必须可交互（聊天处于 streaming
               是 ask_user_question 工具执行中，是设计预期而非锁定态）；常规锁定
               由 answered/resolved/submittedKind 兜住。
               2026-09-18 broker P1：未决（isAskPinned）由输入区 pinned 卡承接，
               内联抑制；已决/历史表单照常内联（已决归档面） -->
          <AskUserQuestionCard
            v-if="
              isToolUIPart(part) && getToolName(part) === 'ask_user_question' && !isAskPinned(part)
            "
            :part="part"
            :part-state="part.state"
            :answered="isAskFormAnswered(part)"
            @submit="emit('formSubmit', $event)"
          />
          <!-- T61：set_active_design → 同意卡（同意/不同意均不伪装用户消息） -->
          <ChatSetActiveDesignCard
            v-else-if="isToolUIPart(part) && getToolName(part) === 'set_active_design'"
            :part="part"
            :resolved="consentDecisions?.get(part.toolCallId) ?? null"
            :disabled="streaming"
            @decide="emit('consentDecide', { toolCallId: part.toolCallId, agree: $event })"
          />
          <!-- T61：宿主发起的新建意图确认卡（data part，非工具 part） -->
          <ChatNewIntentCard
            v-else-if="isNewIntentPart(part)"
            :data="newIntentData(part)"
            :disabled="streaming"
            @confirm="
              emit('intentConfirm', {
                messageId: message.id,
                referenceNodeIds: $event.referenceNodeIds,
                canvas: $event.canvas
              })
            "
            @cancel="emit('intentCancel', { messageId: message.id })"
          />
          <!-- T91b：setup_design awaiting_new_intent_confirmation 信封 → ChatAwaitingIntentCard。
            先于通用折叠工具卡——core 返的 awaiting 信封不是 error，不能落进 error 视觉。 -->
          <ChatAwaitingIntentCard
            v-else-if="
              isToolUIPart(part) &&
              getToolName(part) === 'setup_design' &&
              part.state === 'output-available' &&
              parseSetupAwaitingIntent(part.output) !== null
            "
            :payload="parseSetupAwaitingIntent(part.output)!"
            :disabled="streaming"
            @confirm="
              emit('intentAwaitingConfirm', {
                toolCallId: part.toolCallId,
                modeId: parseSetupAwaitingIntent(part.output)!.modeId,
                profileId: parseSetupAwaitingIntent(part.output)!.profileId
              })
            "
            @cancel="
              emit('intentAwaitingCancel', {
                toolCallId: part.toolCallId,
                modeId: parseSetupAwaitingIntent(part.output)!.modeId,
                profileId: parseSetupAwaitingIntent(part.output)!.profileId
              })
            "
          />
          <!-- 2026-09-18 broker P1：authz 授权请求 data part——未决且流式中由
               输入区 pinned 卡承接（authzInlineDecision 返 null 不渲染）；已决/失效
               落消息流内卡（历史回看 + 审计轨迹，§6 已决归档合一） -->
          <PendingDecisionCard
            v-else-if="isAuthzRequestPart(part) && authzInlineDecision(part)"
            :decision="authzInlineDecision(part)!"
          />
          <!-- T65（决策 D3）：上下文切换回执 → 对话流分割线（非气泡） -->
          <div
            v-else-if="isContextSwitchPart(part)"
            data-test-id="chat-context-switch"
            class="flex items-center gap-2 py-0.5"
          >
            <div class="h-px flex-1 bg-border" />
            <span class="shrink-0 text-[11px] text-muted">{{
              confirmText.contextSwitchLine({ name: contextSwitchName(part) })
            }}</span>
            <div class="h-px flex-1 bg-border" />
          </div>
          <!-- Tool call -->
          <div v-else-if="isToolUIPart(part)" class="rounded-lg border border-border bg-canvas p-2">
            <CollapsibleRoot>
              <CollapsibleTrigger
                class="flex w-full items-center gap-2 rounded px-1 py-0.5 hover:bg-hover"
              >
                <div
                  class="flex size-4 items-center justify-center rounded-full"
                  :class="{
                    'bg-accent/20 text-accent': toolState(part) === 'pending',
                    'bg-green-500/20 text-green-400': toolState(part) === 'done',
                    'bg-red-500/20 text-red-400': toolState(part) === 'error'
                  }"
                >
                  <icon-lucide-loader-circle
                    v-if="toolState(part) === 'pending'"
                    class="size-3 animate-spin"
                  />
                  <icon-lucide-check v-else-if="toolState(part) === 'done'" class="size-3" />
                  <icon-lucide-triangle-alert v-else class="size-3" />
                </div>
                <span class="text-[11px] text-surface">
                  {{ toolDisplayName(part) }}
                </span>
                <span class="text-[10px] text-muted">
                  {{
                    toolState(part) === 'pending'
                      ? ai.toolRunning
                      : toolState(part) === 'done'
                        ? ai.toolFinished
                        : ai.toolError
                  }}
                </span>
                <icon-lucide-chevron-down
                  v-if="toolState(part) !== 'pending'"
                  class="ml-auto size-3 text-muted transition-transform [[data-state=open]>&]:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent
                v-if="toolState(part) !== 'pending'"
                class="data-[state=closed]:collapsible-up data-[state=open]:collapsible-down overflow-hidden text-[10px]"
              >
                <!-- T92：displayToolOutput 统一出口——media 输出 base64 裁成
                  [omitted N chars]（对齐老分支 displayOutput 语义） -->
                <pre class="mt-1 overflow-x-auto rounded bg-input p-2 text-muted">{{
                  displayToolOutput(part)
                }}</pre>
              </CollapsibleContent>
            </CollapsibleRoot>
          </div>

          <!-- T93：reasoning part 折叠渲染（预研 §5.2 方案 A）。
            T96（owner 改）：默认折叠（不绑 :open）——流式中、结束后都靠用户手点；
            标题走 part 级 state 分叉（2026-09-18 P0 修：原绑消息级 streaming，
            整流恒 true 致推理结束后仍挂「思考中」）：流入期「思考中…」+ 呼吸点动画
            （纯 CSS keyframes，零 JS 定时器）；reasoning-end 后「思考过程」。
            每条独立默认折叠，新消息不继承。 -->
          <details
            v-else-if="isReasoningUIPart(part)"
            data-test-id="chat-reasoning"
            class="rounded-lg border border-border bg-canvas px-2 py-1"
          >
            <summary
              data-slot="chat-reasoning-trigger"
              class="flex cursor-pointer items-center gap-1 text-[11px] text-muted select-none"
            >
              <icon-lucide-brain class="size-3" />
              <!-- part 级 state：reasoning-end 即翻「思考过程」，不等整条消息流结束
                   （消息级 streaming 在正文续流/调工具期间恒 true，多 reasoning 块会齐挂「思考中」） -->
              <span v-if="part.state === 'streaming'" data-test-id="chat-reasoning-streaming-title">
                {{ confirmText.reasoningStreamingTitle }}
                <span class="chat-reasoning-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
              <span v-else data-test-id="chat-reasoning-title">
                {{ confirmText.reasoningTitle }}
              </span>
            </summary>
            <div
              class="mt-1 border-l-2 border-muted pl-2 text-[11px] whitespace-pre-wrap text-muted"
            >
              {{ part.text }}
            </div>
          </details>

          <!-- Text -->
          <div
            v-else-if="isTextUIPart(part) && part.text"
            data-test-id="chat-text-bubble"
            class="group/response relative rounded-xl rounded-tl-md bg-hover px-3 py-2 text-xs leading-relaxed text-surface"
          >
            <ChatMarkdown :content="part.text" :mode="markdownMode" />
            <!-- D9：复制响应——首个非空 text part 挂钮，hover/聚焦显现 -->
            <IconButton
              v-if="i === firstAssistantTextPartIndex && assistantText && clipboardSupported"
              :label="copied ? ai.responseCopied : ai.copyResponse"
              size="xs"
              data-slot="chat-copy-response"
              data-test-id="chat-copy-response"
              class="absolute right-1 bottom-1 opacity-0 focus-visible:opacity-100 group-hover/response:opacity-100"
              @click="copyResponse"
            >
              <icon-lucide-check v-if="copied" class="size-3 text-green-400" />
              <icon-lucide-copy v-else class="size-3" />
            </IconButton>
          </div>
          <!-- T81 P-01：AI SDK `file` chunk（media-output.ts:48-70）补位渲染。
            图像直渲 data URL；非图像（视频/音频）回落文件名占位，不吞。 -->
          <div
            v-else-if="isFileUIPart(part)"
            data-test-id="chat-file-attachment"
            class="rounded-lg border border-border bg-canvas p-2"
          >
            <img
              v-if="part.mediaType.startsWith('image/')"
              :src="part.url"
              :alt="filePartAlt(part)"
              class="mt-1 max-h-48 rounded border border-border"
            />
            <div
              v-else
              class="flex items-center gap-2 rounded bg-input px-2 py-1 text-[11px] text-muted"
            >
              <icon-lucide-paperclip class="size-3" />
              <span class="truncate">{{ filePartFilename(part) }}</span>
              <span class="shrink-0 text-[10px]">{{ part.mediaType }}</span>
            </div>
          </div>
        </template>
      </template>

      <!-- User message -->
      <template v-else-if="message.role === 'user'">
        <div
          data-test-id="chat-text-bubble"
          class="rounded-xl rounded-br-md bg-accent px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-white"
        >
          {{
            message.parts
              .filter(isTextUIPart)
              .map((p) => p.text)
              .join('')
          }}
        </div>
      </template>

      <!-- T94：用户主动停止回执——末条消息底部瞬时小字行（ChatPanel justStopped
        4s 自动复位）；停止是预期操作，不走 error 视觉 -->
      <div
        v-if="stopped"
        data-test-id="chat-stopped-hint"
        class="flex items-center gap-1.5 text-[11px] text-muted"
      >
        <icon-lucide-circle-stop class="size-3" />
        <span>{{ confirmText.chatStopped }}</span>
      </div>
    </div>
  </div>
</template>

<!-- T96：reasoning 流式三圆点——纯 CSS @keyframes（避免 JS 定时器/repaint 开销），
  三个圆点交错透明度，1.4s 周期模拟省略号动画，prefers-reduced-motion 静默 -->
<style scoped>
@keyframes chat-reasoning-pulse {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}
.chat-reasoning-dots {
  display: inline-flex;
  gap: 0.18em;
  margin-left: 0.2em;
  vertical-align: middle;
}
.chat-reasoning-dots > span {
  width: 0.32em;
  height: 0.32em;
  border-radius: 9999px;
  background-color: currentColor;
  animation: chat-reasoning-pulse 1.4s ease-in-out infinite;
}
.chat-reasoning-dots > span:nth-child(2) {
  animation-delay: 0.2s;
}
.chat-reasoning-dots > span:nth-child(3) {
  animation-delay: 0.4s;
}
@media (prefers-reduced-motion: reduce) {
  .chat-reasoning-dots > span {
    animation: none;
    opacity: 0.6;
  }
}
</style>
