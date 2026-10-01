/**
 * T92：工具卡片展开输出 base64 裁剪（预研 202609010000-look-tool-review.md §2 UI 遗漏）。
 *
 * 验收映射：
 * - displayToolOutput（ChatMessage.vue 折叠卡 <pre> 单源）对 media 输出把
 *   base64 裁成 `[omitted N chars]`（对齐老分支 displayOutput 语义），其余
 *   元数据原样保留；非 media 输出 / errorText / error 输出路径不回归。
 * - sanitizeMediaToolOutputForModel（tools.ts content[1].text 模型通道）完全
 *   omit base64 键——模型已从 content[0].image 拿到真图，占位符是纯噪音；
 *   UI 通道 sanitizeMediaToolOutput 保留占位符的既有语义不回归（look.test.ts
 *   钉扎不动）。
 * - 展开态行数上界：JSON 序列化后超 200 行按行边界截断 + 尾注标注截去字符
 *   量（折叠态零 DOM，上界只封展开瞬态）；errorText 透传路径不裁。
 */

import { describe, expect, test } from 'bun:test'

import { sanitizeMediaToolOutputForModel } from '@/app/ai/pi-backend/media-output'
import { displayToolOutput } from '@/components/assistant/tool-output'

const lookOutput = {
  base64: 'aGk=', // "hi" — 4 chars
  mimeType: 'image/png',
  byteLength: 2,
  channel: 'A',
  node: { id: '1:2', name: 'Card', width: 800, height: 600 },
  note: 'Visual inspection of "Card".'
}

interface ParsedDisplay {
  base64?: unknown
  mimeType?: unknown
  node?: unknown
  note?: unknown
}

describe('T92 displayToolOutput (tool card expansion)', () => {
  test('media output: base64 裁成 [omitted N chars]，其余字段原样', () => {
    const text = displayToolOutput({ state: 'output-available', output: lookOutput })
    const parsed = JSON.parse(text) as ParsedDisplay

    expect(parsed.base64).toBe('[omitted 4 chars]')
    expect(text).not.toContain('aGk=')
    expect(parsed.mimeType).toBe('image/png')
    expect(parsed.node).toEqual(lookOutput.node)
    expect(parsed.note).toBe(lookOutput.note)
  })

  test('non-media output: 原样 JSON.stringify，不误裁', () => {
    const output = { id: '1:2', name: 'Card', base64LikeButNotMedia: 'aGk=' }
    const text = displayToolOutput({ state: 'output-available', output })

    expect(text).toBe(JSON.stringify(output, null, 2))
  })

  test('output-error with errorText: 透传错误文本', () => {
    const text = displayToolOutput({ state: 'output-error', errorText: 'boom', output: undefined })
    expect(text).toBe('boom')
  })

  test('output-available with error field: 透传 error 字段（不走 JSON）', () => {
    const text = displayToolOutput({
      state: 'output-available',
      output: { error: 'Node not found' }
    })
    expect(text).toBe('Node not found')
  })
})

describe('T92 displayToolOutput 展开态行数上界', () => {
  test('超 200 行截断：保前 200 行，尾注标注截去字符量', () => {
    const output = { lines: Array.from({ length: 300 }, (_, i) => `line-${i}`) }
    const fullText = JSON.stringify(output, null, 2)
    const kept = fullText.split('\n').slice(0, 200).join('\n')
    const text = displayToolOutput({ state: 'output-available', output })

    expect(text).toBe(`${kept}\n[truncated ${fullText.length - kept.length - 1} chars]`)
    expect(text.split('\n')).toHaveLength(201)
    expect(text).toContain('line-197')
    expect(text).not.toContain('line-198')
  })

  test('恰好 200 行不截断（上界含边界）', () => {
    const output = Array.from({ length: 198 }, (_, i) => `item-${i}`)
    const text = displayToolOutput({ state: 'output-available', output })

    expect(text).toBe(JSON.stringify(output, null, 2))
    expect(text.split('\n')).toHaveLength(200)
  })

  test('media 输出行数未超上界：base64 占位语义不变（不二次截断）', () => {
    const output = { base64: 'aGk=', mimeType: 'image/png', note: 'ok' }
    const text = displayToolOutput({ state: 'output-available', output })

    expect(text).toContain('[omitted 4 chars]')
    expect(text).not.toContain('[truncated')
  })

  test('media 输出超上界同样截断（先裁 base64 再施行数上界）', () => {
    const output = {
      base64: 'aGk=',
      mimeType: 'image/png',
      lines: Array.from({ length: 300 }, (_, i) => `line-${i}`)
    }
    const text = displayToolOutput({ state: 'output-available', output })

    expect(text.split('\n')).toHaveLength(201)
    expect(text).toContain('[truncated ')
    expect(text).toContain('"image/png"')
  })

  test('errorText 透传路径不施行数上界（错误文本需完整可读）', () => {
    const errorText = 'boom '.repeat(2000)
    const text = displayToolOutput({ state: 'output-error', errorText, output: undefined })

    expect(text).toBe(errorText)
  })
})

describe('T92 sanitizeMediaToolOutputForModel (model channel)', () => {
  test('完全 omit base64 键（无占位符），其余字段原样', () => {
    const sanitized = sanitizeMediaToolOutputForModel(lookOutput)

    expect('base64' in sanitized).toBe(false)
    expect(JSON.stringify(sanitized)).not.toContain('inlined as file part')
    expect(JSON.stringify(sanitized)).not.toContain('aGk=')
    expect(sanitized.mimeType).toBe('image/png')
    expect(sanitized.node).toEqual(lookOutput.node)
    expect(sanitized.note).toBe(lookOutput.note)
  })
})
