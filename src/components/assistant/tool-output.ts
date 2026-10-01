/**
 * T92：工具卡片展开输出文本（ChatMessage.vue 折叠卡 <pre> 内容单源）。
 *
 * 对齐老分支 displayOutput 语义：media 输出（base64 + mimeType 字段，look /
 * export_image 通道 A 结果）序列化展示时把 base64 替换为 `[omitted N chars]`
 * 占位——工具卡片给人类看，完整 base64 只是噪音（图像本体已由 file chunk
 * 直渲）。模型通道裁剪见 pi-backend/media-output.ts（sanitize 双函数）。
 *
 * 从 ChatMessage.vue 抽出以便单测（tool-state.ts 同模式先例）。
 *
 * 展开态输出上界：JSON 序列化后超 200 行按行边界截断，尾注标注截去的字符
 * 量——折叠态本就零 DOM（unmountOnHide 默认 true），此上界只封展开瞬态的长
 * 输出（大文件 read / 长 JSON 结果整段灌进 <pre>）。errorText / error 字段
 * 透传路径不裁：错误文本非 JSON 序列化产物，且需完整可读。
 */

import { isMediaToolOutput } from '@/app/ai/pi-backend/media-output'

export type ToolOutputDisplayInput = {
  state: string
  errorText?: string
  output?: unknown
}

/** 展开态正文行数上界 */
const MAX_DISPLAY_LINES = 200

function hasErrorOutput(output: unknown): output is { error: string } {
  return typeof output === 'object' && output !== null && 'error' in output
}

/** 行数上界截断：保前 MAX_DISPLAY_LINES 行，尾注标注截去的字符量 */
function capDisplayLines(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= MAX_DISPLAY_LINES) return text
  const kept = lines.slice(0, MAX_DISPLAY_LINES).join('\n')
  // 尾注英文与相邻 [omitted N chars] 占位符同口径（聊天 UI 文案统一英文）；
  // 截去量 = 全文 − 保留 − 分界换行符 1 字符
  return `${kept}\n[truncated ${text.length - kept.length - 1} chars]`
}

export function displayToolOutput(part: ToolOutputDisplayInput): string {
  if (part.state === 'output-error' && part.errorText) return part.errorText
  if (part.state === 'output-available' && hasErrorOutput(part.output)) return part.output.error
  const output = part.output
  if (isMediaToolOutput(output)) {
    const { base64, ...rest } = output
    return capDisplayLines(
      JSON.stringify({ ...rest, base64: `[omitted ${base64.length} chars]` }, null, 2)
    )
  }
  return capDisplayLines(JSON.stringify(output, null, 2))
}
