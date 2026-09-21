// Batch 2a 路径分离（2026-09-05）：本文件自 src/app/ai/debug/index.ts 迁入
// owned 路径 src/app/ai/fork/debug/，原上游路径留给 deletedPaths 落账——T27
// 起本模块已裁为纯 fork 派生面（无上游对应实现可跟随）。
import type { UIMessage } from 'ai'

import type { JSONObject } from '@open-pencil/scene-graph/primitives'

import { isMediaToolOutput, sanitizeMediaToolOutput } from '@/app/ai/pi-backend/media-output'

import type { AIChatFailure } from '../failure'

// T27：旧浏览器内 ToolLoop 的客户端工具日志/step 计数面已随 src/app/ai/tools/
// 删除（pi 路径工具在后端进程执行，浏览器侧恒空）——TOKEN USAGE / DIAGNOSTICS /
// TOOL EXECUTION LOG 三节随之裁掉，本模块只保留从 messages/failure 派生的活内容。

const MAX_FAILURE_DETAIL_LENGTH = 240
const SENSITIVE_DETAIL_PATTERN =
  /(api[-_ ]?key|authorization|token|secret|password)(\s*[:=]\s*|\s+)([^\s,;]+)/gi

export function safeFailureDetail(detail: string): string {
  const redacted = detail.replace(SENSITIVE_DETAIL_PATTERN, '$1$2[redacted]')
  return redacted.length <= MAX_FAILURE_DETAIL_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_FAILURE_DETAIL_LENGTH)}…`
}

// Media payloads carry raw base64 that must not land in the debug log; swap the
// value for the UI placeholder the rest of the app already uses.
function redactMedia(value: unknown): unknown {
  return isMediaToolOutput(value) ? sanitizeMediaToolOutput(value) : value
}

// Tool-shaped parts may carry media either inside toolInvocation.result or as a
// top-level output field; file parts carry the image body as a `data:` URL in
// `url` (mapping.ts mediaToolOutputChunks emits the file chunk alongside the
// sanitized tool output). Clone, redact all three candidates, and tally what we
// elided so message stats can report the excluded payload size.
function redactPart(part: JSONObject): {
  sanitized: JSONObject
  mediaChars: number
  mediaImages: number
} {
  let mediaChars = 0
  let mediaImages = 0
  const out: Record<string, unknown> = { ...part }
  if (part.toolInvocation) {
    const inv = part.toolInvocation as JSONObject
    const invCopy: Record<string, unknown> = { ...inv }
    if (isMediaToolOutput(invCopy.result)) {
      mediaChars += invCopy.result.base64.length
      mediaImages += 1
      invCopy.result = sanitizeMediaToolOutput(invCopy.result)
    }
    out.toolInvocation = invCopy
  }
  if (isMediaToolOutput(part.output)) {
    mediaChars += part.output.base64.length
    mediaImages += 1
    out.output = sanitizeMediaToolOutput(part.output)
  }
  const url = part.url
  if (typeof url === 'string' && url.startsWith('data:')) {
    mediaChars += url.length
    mediaImages += 1
    out.url = `[data URL elided, ${url.length} chars]`
  }
  return { sanitized: out as JSONObject, mediaChars, mediaImages }
}

function formatToolPart(part: Record<string, unknown>): string {
  const inv = part.toolInvocation as JSONObject | undefined
  if (inv) {
    const lines = [`  [tool] ${String(inv.toolName)} (${String(inv.state)})`]
    if (inv.args) lines.push(`    args: ${JSON.stringify(inv.args)}`)
    if (inv.result !== undefined)
      lines.push(`    result: ${JSON.stringify(redactMedia(inv.result))}`)
    return lines.join('\n')
  }

  const name = (typeof part.type === 'string' ? part.type : 'unknown').replace(/^tool-/, '')
  const state = typeof part.state === 'string' ? part.state : '?'
  const lines = [`  [tool] ${name} (${state})`]
  if (part.input) lines.push(`    input: ${JSON.stringify(part.input)}`)
  if (part.output !== undefined)
    lines.push(`    output: ${JSON.stringify(redactMedia(part.output))}`)
  if (part.errorText) lines.push(`    error: ${part.errorText as string}`)
  return lines.join('\n')
}

function formatMessageStats(messages: UIMessage[]): string {
  let userMessages = 0
  let assistantMessages = 0
  let toolCalls = 0
  let totalTextLength = 0
  let mediaImages = 0
  let mediaChars = 0

  for (const msg of messages) {
    if (msg.role === 'user') userMessages++
    else if (msg.role === 'assistant') assistantMessages++
    for (const part of msg.parts) {
      const p = part as JSONObject
      if (p.type === 'text') {
        totalTextLength += typeof p.text === 'string' ? p.text.length : 0
      } else if (p.type === 'file') {
        // file part（媒体本体 data URL）：计入总长与媒体载荷统计，不算工具调用
        const { sanitized, mediaChars: partChars, mediaImages: partImages } = redactPart(p)
        totalTextLength += JSON.stringify(sanitized).length
        mediaImages += partImages
        mediaChars += partChars
      } else if (
        p.type === 'tool-invocation' ||
        p.type === 'dynamic-tool' ||
        p.toolInvocation ||
        (typeof p.type === 'string' && p.type.startsWith('tool-'))
      ) {
        toolCalls++
        const { sanitized, mediaChars: partChars, mediaImages: partImages } = redactPart(p)
        totalTextLength += JSON.stringify(sanitized).length
        mediaImages += partImages
        mediaChars += partChars
      }
    }
  }

  const lines = [
    `Messages: ${messages.length} (${userMessages} user, ${assistantMessages} assistant)`,
    `Tool invocations in messages: ${toolCalls}`,
    `Total text content: ${(totalTextLength / 1024).toFixed(1)} KB (~${Math.ceil(totalTextLength / 4)} tokens approx)`
  ]
  if (mediaImages > 0) {
    lines.push(
      `Media payload (excluded after elision): ${mediaImages} images / ${(mediaChars / 1024).toFixed(1)} KB`
    )
  }
  return lines.join('\n')
}

export function serializeChatLog(messages: UIMessage[], failure?: AIChatFailure | null): string {
  const sections: string[] = []

  sections.push('╔══════════════════════════════════════╗')
  sections.push('║     AI DEBUG LOG                       ║')
  sections.push(`║     ${new Date().toISOString()}   ║`)
  sections.push('╚══════════════════════════════════════╝')
  sections.push('')

  sections.push('=== ERRORS ===')
  if (failure) {
    const detail = failure.detail ? `: ${safeFailureDetail(failure.detail)}` : ''
    sections.push(`  ${failure.reason}${detail}`)
  } else {
    sections.push('  (none recorded)')
  }
  sections.push('')

  sections.push('=== MESSAGE STATS ===')
  sections.push(formatMessageStats(messages))
  sections.push('')

  sections.push('=== CONVERSATION ===')
  for (const msg of messages) {
    const header = `--- ${msg.role.toUpperCase()} (${msg.id}) ---`
    const parts: string[] = []

    for (const part of msg.parts) {
      const p = part as JSONObject
      if (p.type === 'text') {
        parts.push(`  ${p.text as string}`)
      } else if (p.type === 'reasoning') {
        let reasoning = ''
        if (typeof p.text === 'string') reasoning = p.text
        else if (typeof p.content === 'string') reasoning = p.content
        parts.push(`  [reasoning] ${reasoning}`)
      } else if (
        p.type === 'tool-invocation' ||
        p.toolInvocation ||
        (typeof p.type === 'string' && p.type.startsWith('tool-'))
      ) {
        parts.push(formatToolPart(p))
      } else {
        const { sanitized } = redactPart(p)
        parts.push(
          `  [${typeof p.type === 'string' ? p.type : 'unknown'}] ${JSON.stringify(sanitized)}`
        )
      }
    }

    sections.push(`${header}\n${parts.join('\n')}`)
  }

  return sections.join('\n\n')
}

export function copyChatLog(messages: UIMessage[], failure?: AIChatFailure | null): Promise<void> {
  const text = serializeChatLog(messages, failure)
  return navigator.clipboard.writeText(text)
}
