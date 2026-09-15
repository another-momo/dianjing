/**
 * AgentSessionEvent → UIMessageChunk 映射（T19 文本回路 + T20 工具链路）。
 *
 * 映射表来源：docs/archive/rebuild-campaign/tasks/T11-self-check.md §2.5（S-pi-4 离线面实测），
 * 惰性开帧状态机照搬上游 harness transport mapEvent 的 pending 模式（T25 已随旧面删除，此处留存其设计先例）。
 *
 * T20 激活工具映射（照上游 harness transport 先例 providerExecuted: true（T25 已删），
 * 前端不做客户端再执行；上游不发 tool-input-start，卡片自 tool-input-available
 * 起即为 pending 态）：
 *  - message_update 的 toolcall_end → tool-input-available（全量 arguments）
 *  - session 级 tool_execution_end → tool-output-available / tool-output-error
 *  - toolcall_start/delta 不转发；tool_execution_start/update 不出 chunk
 *
 * finish 只在 agent_end 且 willRetry=false 时发出（pi 自动重试序列中
 * agent_end 会中途出现，agent-session.d.ts:40-44 事件形状实证）。
 *
 * T55 媒体输出：登记工具（media-output.ts MEDIA_OUTPUT_TOOLS，含 look）的
 * 桥结果带 base64 图像时，转 file 媒体块 + 脱敏 tool-output-available。
 *
 * 本文件被 Node 端 service.ts 使用，只允许相对导入（vite.config esbuild 打包，
 * 不解析 tsconfig paths）。
 */

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { UIMessageChunk } from 'ai'

import { MEDIA_OUTPUT_TOOLS, mediaToolOutputChunks } from './media-output'

type AssistantSubEvent = Extract<
  AgentSessionEvent,
  { type: 'message_update' }
>['assistantMessageEvent']

export function createPiEventMapper(
  messageId: string
): (event: AgentSessionEvent) => UIMessageChunk[] {
  let started = false
  let textId: string | null = null
  let reasoningId: string | null = null
  let textSeq = 0
  let reasoningSeq = 0

  function mapAssistant(sub: AssistantSubEvent, chunks: UIMessageChunk[]): void {
    switch (sub.type) {
      case 'text_start':
        textId = `text-${++textSeq}`
        chunks.push({ type: 'text-start', id: textId })
        break
      case 'text_delta':
        if (!textId) {
          textId = `text-${++textSeq}`
          chunks.push({ type: 'text-start', id: textId })
        }
        chunks.push({ type: 'text-delta', id: textId, delta: sub.delta })
        break
      case 'text_end':
        if (textId) {
          chunks.push({ type: 'text-end', id: textId })
          textId = null
        }
        break
      case 'thinking_start':
        reasoningId = `reasoning-${++reasoningSeq}`
        chunks.push({ type: 'reasoning-start', id: reasoningId })
        break
      case 'thinking_delta':
        if (!reasoningId) {
          reasoningId = `reasoning-${++reasoningSeq}`
          chunks.push({ type: 'reasoning-start', id: reasoningId })
        }
        chunks.push({ type: 'reasoning-delta', id: reasoningId, delta: sub.delta })
        break
      case 'thinking_end':
        if (reasoningId) {
          chunks.push({ type: 'reasoning-end', id: reasoningId })
          reasoningId = null
        }
        break
      case 'error':
        chunks.push({
          type: 'error',
          errorText: sub.error.errorMessage ?? `model stream error (${sub.reason})`
        })
        break
      case 'toolcall_end':
        chunks.push({
          type: 'tool-input-available',
          toolCallId: sub.toolCall.id,
          toolName: sub.toolCall.name,
          input: sub.toolCall.arguments,
          providerExecuted: true
        })
        break
      default:
        // start / done / toolcall_start / toolcall_delta：不产生 chunk。
        // 上游先例不发 tool-input-start（transport.ts:44-57），卡片自
        // tool-input-available 起即 pending 态（ChatMessage toolState 对无输出
        // part 判 pending）；且 toolcall_start 不带 id/toolName（pi-ai
        // types.d.ts:422-425 实证），反查防御成本大于收益。
        break
    }
  }

  function mapToolExecutionEnd(
    event: Extract<AgentSessionEvent, { type: 'tool_execution_end' }>,
    chunks: UIMessageChunk[]
  ): void {
    const result = event.result as
      | { content?: Array<{ type: string; text?: string }>; details?: unknown }
      | undefined
    const contentText = (result?.content ?? [])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
      .join('')
    if (event.isError) {
      chunks.push({
        type: 'tool-output-error',
        toolCallId: event.toolCallId,
        errorText: contentText || '工具执行失败',
        providerExecuted: true
      })
    } else {
      const output = result?.details !== undefined ? result.details : contentText || null
      // T55：登记媒体工具（look 等）的 base64 图像转 file 媒体块，details 脱敏
      const mediaChunks = MEDIA_OUTPUT_TOOLS.has(event.toolName)
        ? mediaToolOutputChunks(event.toolCallId, output)
        : null
      if (mediaChunks) {
        chunks.push(...mediaChunks)
      } else {
        chunks.push({
          type: 'tool-output-available',
          toolCallId: event.toolCallId,
          output,
          providerExecuted: true
        })
      }
    }
  }

  function mapAgentEnd(chunks: UIMessageChunk[]): void {
    if (textId) {
      chunks.push({ type: 'text-end', id: textId })
      textId = null
    }
    if (reasoningId) {
      chunks.push({ type: 'reasoning-end', id: reasoningId })
      reasoningId = null
    }
    chunks.push({ type: 'finish', finishReason: 'stop' })
  }

  return (event) => {
    const chunks: UIMessageChunk[] = []
    if (!started) {
      started = true
      chunks.push({ type: 'start', messageId })
    }

    if (event.type === 'message_update') mapAssistant(event.assistantMessageEvent, chunks)
    if (event.type === 'tool_execution_end') mapToolExecutionEnd(event, chunks)
    if (event.type === 'agent_end') {
      // pi 自动重试时 agent_end 带 willRetry=true（T20 实测：空消息触发
      // auto_retry_start → 重跑整轮 → 再次 agent_end）——此时回合未终结，
      // 发 finish 会让前端 Chat 提前关流、丢弃后续工具 chunk
      if (!event.willRetry) mapAgentEnd(chunks)
    }

    return chunks
  }
}
