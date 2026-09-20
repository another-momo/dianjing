/**
 * Copy debug log base64 elision — 2026-09-20 owner 报「base64 又进 copy debug
 * log」回归。serializeChatLog 之前对 tool part 的 `result` / `output` /
 * 兜底分支直接 JSON.stringify，look 与 export_image 通道 A 返回的
 * `{base64, mimeType}` 整段进剪贴板。本测试钉扎 6 档：
 *
 *   1. look 通道 A 输出含 base64：脱敏占位符 `[inlined as file part, N chars]` 出现，
 *      原 base64 字面值不出现；
 *   2. export_image 同上（MEDIA_OUTPUT_TOOLS 含 look + export_image，分支形态一致）；
 *   3. stats totalTextLength 按脱敏后算（与构造量相近、不被原 base64 撑爆）；
 *   4. Media payload stats 提示行仅在有媒体载荷时输出（`N images / N KB`）；
 *   5. 非媒体 part（text / errorText / reasoning）行为不变；
 *   6. file part（同日报第二波回归：owner 真实日志实锤漏脱）——mapping.ts
 *      mediaToolOutputChunks 对登记媒体工具在脱敏 tool output 之外另发
 *      `{type:'file', url:'data:<mime>;base64,<原图>'}` 媒体块（图像本体给 UI
 *      显示），url 不走 result/output 两候选，落兜底分支整段泄露。修复 =
 *      redactPart 补 `data:` url elide（`[data URL elided, N chars]`）+ stats
 *      把 file part 计入媒体载荷；非 data: url（http 等）原样保留不计媒体。
 *
 * 测试只调 serializeChatLog，禁调 copyChatLog（navigator 浏览器全局 node 测无）。
 */

import { describe, expect, test } from 'bun:test'

import { serializeChatLog } from '@/app/ai/fork/debug'

// 64 字符 base64——足够验证占位符 N chars 计数与 stats 长度估算。
const LONG_B64 = 'A'.repeat(64) + 'a'.repeat(64) // 128 字符，构造量级 ≈ 128 bytes

const lookOutput = {
  base64: LONG_B64,
  mimeType: 'image/png',
  byteLength: 96,
  channel: 'A',
  node: { id: '1:2', name: 'Card' },
  note: 'Visual inspection of "Card".'
}

const exportImageOutput = {
  base64: LONG_B64,
  mimeType: 'image/jpeg',
  byteLength: 96,
  width: 1024,
  height: 768
}

interface ToolPart {
  type: 'tool-invocation'
  toolInvocation: {
    toolName: string
    state: string
    args: Record<string, unknown>
    result: unknown
  }
}

function lookToolPart(): ToolPart {
  return {
    type: 'tool-invocation',
    toolInvocation: {
      toolName: 'look',
      state: 'output-available',
      args: { nodeId: '1:2' },
      result: { ...lookOutput }
    }
  }
}

function exportImageToolPart(): ToolPart {
  return {
    type: 'tool-invocation',
    toolInvocation: {
      toolName: 'export_image',
      state: 'output-available',
      args: { nodeId: '1:2', format: 'jpeg' },
      result: { ...exportImageOutput }
    }
  }
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  parts: unknown[]
}

function assistantMessage(parts: unknown[]): Message {
  return { id: 'm1', role: 'assistant', parts }
}

function userMessage(text: string): Message {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] }
}

// file part = mapping.ts mediaToolOutputChunks 对登记媒体工具另发的媒体块：
// `{type:'file', mediaType, url:'data:<mime>;base64,<原图>'}`（图像本体给 UI
// 显示，真实泄露路径即此）。'data:image/png;base64,' 22 字符 + LONG_B64 128
// 字符 = url 全长 150。
const FILE_PART_DATA_URL = `data:image/png;base64,${LONG_B64}`

function lookFilePart(): Record<string, unknown> {
  return { type: 'file', mediaType: 'image/png', url: FILE_PART_DATA_URL }
}

describe('serializeChatLog: copy debug log base64 elision (2026-09-20 regression)', () => {
  test('look 工具输出含 base64 → 脱敏占位符 + 原 base64 不出现', () => {
    const text = serializeChatLog([assistantMessage([lookToolPart()])])

    expect(text).not.toContain(LONG_B64)
    expect(text).toContain('[inlined as file part, 128 chars]')
    expect(text).toContain('note')
    expect(text).toContain('Visual inspection of')
    expect(text).toContain('mimeType')
    expect(text).toContain('image/png')
  })

  test('export_image 工具输出含 base64 → 脱敏占位符 + 原 base64 不出现', () => {
    const text = serializeChatLog([assistantMessage([exportImageToolPart()])])

    expect(text).not.toContain(LONG_B64)
    expect(text).toContain('[inlined as file part, 128 chars]')
    expect(text).toContain('mimeType')
  })

  test('tool-* 非 tool-invocation 分支（part.output 顶层）→ 同款脱敏', () => {
    const part = {
      type: 'tool-look',
      state: 'output-available',
      input: { nodeId: '1:2' },
      output: { ...lookOutput }
    }
    const text = serializeChatLog([assistantMessage([part])])

    expect(text).not.toContain(LONG_B64)
    expect(text).toContain('[inlined as file part, 128 chars]')
  })

  test('stats totalTextLength 按脱敏后算（不被原 base64 撑爆）', () => {
    const text = serializeChatLog([userMessage('hi'), assistantMessage([lookToolPart()])])

    // 抓 stats 段：定位 "=== MESSAGE STATS ===" 之后下一空行之前。
    const statsStart = text.indexOf('=== MESSAGE STATS ===')
    const statsEnd = text.indexOf('=== CONVERSATION ===')
    const statsSection = text.slice(statsStart, statsEnd)
    const kbMatch = statsSection.match(/Total text content: ([\d.]+) KB/)
    if (!kbMatch) throw new Error('stats 段缺 Total text content 行（fixture 假设破裂）')

    const reportedKb = Number(kbMatch[1])
    // 脱敏后 part ≈ {type,toolInvocation:{toolName,state,args,result:{...rest,base64:'[inlined as file part, 128 chars]'}}}
    // 数量级应远小于原 128 字符 base64 撑出的 ~128 bytes 单 part；且绝对不可能 ≥ 1 KB（纯文本 + 一个脱敏 part）。
    expect(reportedKb).toBeLessThan(1)
  })

  test('Media payload stats 行：有媒体载荷时输出 + 图像数与 KB', () => {
    const text = serializeChatLog([assistantMessage([lookToolPart(), exportImageToolPart()])])

    const statsStart = text.indexOf('=== MESSAGE STATS ===')
    const statsEnd = text.indexOf('=== CONVERSATION ===')
    const statsSection = text.slice(statsStart, statsEnd)

    expect(statsSection).toMatch(/Media payload \(excluded after elision\): 2 images \/ [\d.]+ KB/)
  })

  test('Media payload stats 行：单 base64 payload 报 1 images / 对应 KB', () => {
    const text = serializeChatLog([assistantMessage([lookToolPart()])])

    const statsStart = text.indexOf('=== MESSAGE STATS ===')
    const statsEnd = text.indexOf('=== CONVERSATION ===')
    const statsSection = text.slice(statsStart, statsEnd)

    // 128 chars base64 = 128/1024 KB ≈ 0.1 KB
    expect(statsSection).toMatch(/Media payload \(excluded after elision\): 1 images \/ 0\.1 KB/)
  })

  test('Media payload stats 行：无媒体载荷时不输出该行', () => {
    const text = serializeChatLog([userMessage('plain text only')])

    expect(text).not.toContain('Media payload (excluded after elision)')
  })

  test('非媒体 part 行为不变：纯文本 + errorText + reasoning', () => {
    const errorPart = {
      type: 'tool-fail',
      state: 'output-error',
      input: { id: '1:2' },
      errorText: 'node not found',
      output: { error: 'Node not found' }
    }
    const reasoningPart = { type: 'reasoning', text: 'thinking aloud' }

    const text = serializeChatLog([
      assistantMessage([{ type: 'text', text: 'short answer' }, reasoningPart, errorPart])
    ])

    expect(text).toContain('short answer')
    expect(text).toContain('[reasoning] thinking aloud')
    expect(text).toContain('node not found')
    expect(text).not.toContain('Media payload (excluded after elision)')
  })

  test('非媒体 tool-invocation 输出（不含 base64）保持原样', () => {
    const part = {
      type: 'tool-invocation',
      toolInvocation: {
        toolName: 'list_nodes',
        state: 'output-available',
        args: { pageId: 'p1' },
        result: { nodes: [{ id: '1:2' }, { id: '1:3' }] }
      }
    }
    const text = serializeChatLog([assistantMessage([part])])

    expect(text).toContain('list_nodes')
    expect(text).toContain('1:2')
    expect(text).toContain('1:3')
    expect(text).not.toContain('inlined as file part')
    expect(text).not.toContain('Media payload (excluded after elision)')
  })

  test('file part（data URL 图像本体）→ url elide 占位符 + 原 base64 不出现 + mediaType 保留', () => {
    // 复刻 owner 真实日志形状：脱敏 tool output 兄弟节点带完整 data URL 的 file part
    const text = serializeChatLog([assistantMessage([lookToolPart(), lookFilePart()])])

    expect(text).not.toContain(LONG_B64)
    expect(text).not.toContain(FILE_PART_DATA_URL)
    expect(text).toContain('[file]')
    expect(text).toContain('[data URL elided, 150 chars]')
    expect(text).toContain('image/png')
  })

  test('file part 计入 Media payload stats（tool result + file part = 2 images）', () => {
    const text = serializeChatLog([assistantMessage([lookToolPart(), lookFilePart()])])

    const statsStart = text.indexOf('=== MESSAGE STATS ===')
    const statsEnd = text.indexOf('=== CONVERSATION ===')
    const statsSection = text.slice(statsStart, statsEnd)

    // tool result 128 chars + file url 150 chars = 278 chars ≈ 0.3 KB
    expect(statsSection).toMatch(/Media payload \(excluded after elision\): 2 images \/ 0\.3 KB/)
  })

  test('file part 的 url 非 data:（http 外链）→ 原样保留且不计媒体载荷', () => {
    const part = { type: 'file', mediaType: 'image/png', url: 'https://example.com/x.png' }
    const text = serializeChatLog([assistantMessage([part])])

    expect(text).toContain('https://example.com/x.png')
    expect(text).not.toContain('data URL elided')
    expect(text).not.toContain('Media payload (excluded after elision)')
  })
})
