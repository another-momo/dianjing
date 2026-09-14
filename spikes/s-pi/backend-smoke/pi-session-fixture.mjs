/**
 * T28（决策单 #12）：合成 pi JSONL 会话 fixture——smoke:pi 自含化，
 * 不再依赖本机 .dianjing/pi-sessions 既有文件（CI 裸机上没有）。
 *
 * 条目形状按 pi v3 格式：首行 session 头 + 逐行 JSON entry。
 * parseSessionEntries（SDK session-manager.js）逐行 JSON.parse 即收；
 * readPiHistoryFile（src/app/ai/pi-backend/history.ts）只消费 type=message
 * 条目的 message.role/content——本构造器只保证这两个消费面需要的字段，
 * 其余字段（usage/cost 等）对读取面无影响，从简不造。
 *
 * messages 元素：
 *  { role:'user', text }
 *  { role:'assistant', text, thinking? }   thinking 非空则同条加 thinking part
 *  { role:'assistant', toolCall:{ id, name, arguments } }
 *  { role:'toolResult', toolCallId, text, details?, isError? }
 */

let counter = 0
function eid() {
  counter += 1
  return `fx${String(counter).padStart(6, '0')}`
}

function buildMessage(spec) {
  const ts = 1787475640000 + counter
  if (spec.role === 'user') {
    return { role: 'user', content: [{ type: 'text', text: spec.text }], timestamp: ts }
  }
  if (spec.role === 'toolResult') {
    return {
      role: 'toolResult',
      toolCallId: spec.toolCallId,
      toolName: spec.toolName ?? 'tool',
      content: [{ type: 'text', text: spec.text }],
      details: spec.details ?? null,
      isError: spec.isError ?? false,
      timestamp: ts
    }
  }
  // assistant
  const content = []
  if (spec.thinking) content.push({ type: 'thinking', thinking: spec.thinking })
  if (spec.text) content.push({ type: 'text', text: spec.text })
  if (spec.toolCall) content.push({ type: 'toolCall', ...spec.toolCall })
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'openrouter',
    model: 'openrouter/free',
    stopReason: spec.toolCall ? 'toolUse' : 'stop',
    timestamp: ts
  }
}

export function buildSessionJsonl({ id = 'fx-session', cwd = 'C:\\fixture', messages = [] }) {
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id,
      timestamp: '2026-08-23T09:00:00.000Z',
      cwd
    })
  ]
  let parentId = null
  for (const spec of messages) {
    const entry = {
      type: 'message',
      id: eid(),
      parentId,
      timestamp: '2026-08-23T09:00:01.000Z',
      message: buildMessage(spec)
    }
    parentId = entry.id
    lines.push(JSON.stringify(entry))
  }
  return `${lines.join('\n')}\n`
}
