/**
 * T55（S4 W2 / T-B4）look 契约测试 + 媒体登记钉扎。
 *
 * 验收映射（T55-plan §3 / S3 §5、§10 look 行随迁）：
 * - 三档导出模式各自触发条件：original-bytes（单 IMAGE fill 直出）/
 *   isolated（自有可见填充）/ in-context（无填充容器、近白文字）。
 * - 缩放边界：长边 >1024 压缩（含 0.1 钳制）、<512 上采样 ×4 封顶、
 *   [512,1024] 区间内原样（scale=1）。
 * - renderInContext / clip 选项行为（48px 边距、钳到设计根）。
 * - 返回结构字段齐备：base64/mimeType/byteLength/channel/node/exportInfo/note。
 * - 媒体登记钉扎：MEDIA_OUTPUT_TOOLS 含 look；mapping 层对登记工具结果
 *   产出 file 媒体块 + 脱敏 tool-output-available。
 *
 * lookTool 已注册进 FORK_TOOLS（fork/index.ts，T52 集成期接线）；本文件
 * 仍直接 import 定义做细粒度行为断言，注册面钉扎见 registry 相关断言。
 */

import { describe, expect, test } from 'bun:test'

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { UIMessageChunk } from 'ai'

import type { FigmaAPI } from '@open-pencil/core'

import { createPiEventMapper } from '@/app/ai/pi-backend/mapping'
import {
  MEDIA_OUTPUT_TOOLS,
  isMediaToolOutput,
  sanitizeMediaToolOutput
} from '@/app/ai/pi-backend/media-output'

import { lookTool } from '#core/tools/fork/marketing/look'

import { expectDefined } from '#tests/helpers/assert'
import { setupToolTest } from '#tests/helpers/tools'

interface ExportCall {
  nodeIds: string[]
  options: {
    scale?: number
    format?: string
    quality?: number
    renderInContext?: boolean
    clip?: { minX: number; minY: number; maxX: number; maxY: number }
  }
}

interface LookResult {
  error?: string
  base64?: string
  mimeType?: string
  byteLength?: number
  note?: string
  channel?: 'A'
  focus?: string
  node?: { id: string; name: string; width: number; height: number }
  exportInfo?: {
    mode: 'original-bytes' | 'isolated' | 'in-context'
    scale?: number
    upscaled?: boolean
  }
}

function mockExportImage(figma: FigmaAPI, calls: ExportCall[]) {
  figma.exportImage = (nodeIds, options) => {
    calls.push({ nodeIds, options })
    return Promise.resolve(new Uint8Array([137, 80, 78, 71]))
  }
}

async function runLook(figma: FigmaAPI, args: Record<string, unknown>): Promise<LookResult> {
  return (await lookTool.execute(figma, args)) as LookResult
}

describe('look tool', () => {
  test('is a pure read — mutates is false', () => {
    expect(lookTool.mutates).toBe(false)
  })

  test('errors when exportImage is unavailable', async () => {
    const { graph, figma } = setupToolTest()
    const pageId = graph.getPages()[0].id
    const frame = graph.createNode('FRAME', pageId, { name: 'Detail', width: 100, height: 100 })
    const result = await runLook(figma, { id: frame.id })
    expect(result.error).toContain('not available')
  })

  test('errors without an id — the id is always required', async () => {
    const { figma } = setupToolTest()
    mockExportImage(figma, [])
    // PR697：必填 id 缺失由 input schema（defineTool 的 v.parse）在 execute 体前拒绝
    await expect(runLook(figma, {})).rejects.toThrow()
    // 空串过 schema，仍走工具自身的友好信封
    const result = await runLook(figma, { id: '' })
    expect(result.error).toContain('Pass an explicit node id')
  })

  test('errors for an unknown node id', async () => {
    const { figma } = setupToolTest()
    mockExportImage(figma, [])
    const result = await runLook(figma, { id: '999:999' })
    expect(result.error).toContain('not found')
  })

  test('scales long edge to 1024 and exports JPEG at quality 80', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const frame = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 4000 })

    const result = await runLook(figma, { id: frame.id })

    expect(result.error).toBeUndefined()
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.base64).toBeTruthy()
    const call = expectDefined(calls[0])
    expect(call.nodeIds).toEqual([frame.id])
    expect(call.options.scale).toBeCloseTo(1024 / 4000, 5)
    expect(call.options.format).toBe('JPG')
    expect(call.options.quality).toBe(80)
    expect(result.note).toContain('exported at 26%')
  })

  test('clamps scale at 0.1 for extremely tall nodes', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const frame = graph.createNode('FRAME', pageId, { name: 'Tall', width: 750, height: 20000 })

    const result = await runLook(figma, { id: frame.id })

    expect(expectDefined(calls[0]).options.scale).toBe(0.1)
    expect(result.note).toContain('Aspect ratio distorted')
  })

  test('nodes within the 512–1024 window export at native scale (no resampling)', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const frame = graph.createNode('FRAME', pageId, { name: 'Card', width: 800, height: 600 })

    const result = await runLook(figma, { id: frame.id })

    expect(expectDefined(calls[0]).options.scale).toBe(1)
    expect(result.note).toContain('exported at 100%')
    expect(result.note).not.toContain('Upscaled')
    expect(result.exportInfo?.upscaled).toBeUndefined()
    expect(result.exportInfo?.mode).toBe('isolated')
  })

  test('small nodes are upscaled to the 512px minimum legible edge', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const frame = graph.createNode('FRAME', pageId, { name: 'Card', width: 300, height: 250 })

    const result = await runLook(figma, { id: frame.id })

    expect(expectDefined(calls[0]).options.scale).toBeCloseTo(512 / 300, 5)
    expect(result.note).toContain('Upscaled')
    expect(result.note).not.toContain('Aspect ratio distorted')
    expect(result.exportInfo?.mode).toBe('isolated')
    expect(result.exportInfo?.upscaled).toBe(true)
  })

  test('upscale is capped at ×4 for very small nodes', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const root = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 2000 })
    const badge = graph.createNode('FRAME', root.id, {
      name: 'Badge',
      width: 100,
      height: 100,
      fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.3, a: 1 }, opacity: 1, visible: true }]
    })

    const result = await runLook(figma, { id: badge.id })

    expect(expectDefined(calls[0]).options.scale).toBe(4)
    expect(result.note).toContain('capped at ×4')
  })

  test('transparent flow frames export composited in context with a clamped margin clip', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const root = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 2000 })
    // No fills — like HeroContent, the frame's content floats on whatever the
    // design paints beneath it; an isolated export would be white-on-white.
    const hero = graph.createNode('FRAME', root.id, {
      name: 'HeroContent',
      width: 750,
      height: 750,
      y: 100
    })

    const result = await runLook(figma, { id: hero.id })

    const call = expectDefined(calls[0])
    expect(call.options.renderInContext).toBe(true)
    // Visual bounds (0,100)-(750,850) + 48px margin, clamped to the root's
    // (0,0)-(750,2000) so the export never shows bare page canvas.
    expect(call.options.clip).toEqual({ minX: 0, minY: 52, maxX: 750, maxY: 898 })
    expect(result.exportInfo?.mode).toBe('in-context')
    expect(result.note).toContain('design context')
  })

  test('near-white text exports in context — it is invisible on a blank export', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const root = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 2000 })
    const title = graph.createNode('TEXT', root.id, { name: 'Title', text: '端午', fontSize: 96 })
    graph.updateNode(title.id, {
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }]
    })

    const result = await runLook(figma, { id: title.id })

    expect(expectDefined(calls[0]).options.renderInContext).toBe(true)
    expect(result.exportInfo?.mode).toBe('in-context')
  })

  test('faint low-opacity gray text counts as near-white (opacity folds into luminance)', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const root = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 2000 })
    // lum(0.85) = 0.85 at opacity 0.4 → effective over white = 1−0.4×0.15 =
    // 0.94 ≥ 0.92 → in-context. The raw fill color alone (0.85 < 0.92) would
    // NOT have triggered before the opacity fold.
    const faint = graph.createNode('TEXT', root.id, { name: 'Ghost', text: '淡', fontSize: 40 })
    graph.updateNode(faint.id, {
      fills: [
        { type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 }, opacity: 0.4, visible: true }
      ]
    })
    // Same color at full opacity → 0.85 < 0.92 → stays isolated.
    const solidGray = graph.createNode('TEXT', root.id, {
      name: 'SolidGray',
      text: '实',
      fontSize: 40,
      y: 100
    })
    graph.updateNode(solidGray.id, {
      fills: [
        { type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 }, opacity: 1, visible: true }
      ]
    })

    const faintResult = await runLook(figma, { id: faint.id })
    const solidResult = await runLook(figma, { id: solidGray.id })

    expect(faintResult.exportInfo?.mode).toBe('in-context')
    expect(solidResult.exportInfo?.mode).toBe('isolated')
  })

  test('frames with their own visible fill keep the isolated export', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const root = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 2000 })
    const card = graph.createNode('FRAME', root.id, {
      name: 'Card',
      width: 600,
      height: 400,
      fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.3, a: 1 }, opacity: 1, visible: true }]
    })

    const result = await runLook(figma, { id: card.id })

    expect(expectDefined(calls[0]).options.renderInContext).toBeUndefined()
    expect(result.exportInfo?.mode).toBe('isolated')
    expect(result.note).not.toContain('design context')
  })

  test('the design root itself stays isolated even without its own fill', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    // No fills — but the root's "context" is the bare page, so no in-context clip.
    const root = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 2000 })

    const result = await runLook(figma, { id: root.id })

    expect(expectDefined(calls[0]).options.renderInContext).toBeUndefined()
    expect(expectDefined(calls[0]).options.clip).toBeUndefined()
    expect(result.exportInfo?.mode).toBe('isolated')
  })

  test('upscaling can clear the small-text legibility warning', async () => {
    const { graph, figma } = setupToolTest()
    mockExportImage(figma, [])
    const pageId = graph.getPages()[0].id
    const root = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 2000 })
    const card = graph.createNode('FRAME', root.id, {
      name: 'Card',
      width: 300,
      height: 100,
      fills: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, opacity: 1, visible: true }]
    })
    graph.createNode('TEXT', card.id, { name: 'Body', text: 'x', fontSize: 8 })

    const result = await runLook(figma, { id: card.id })

    // scale = 512/300 ≈ 1.71 → the 8px text renders at ~14px, above the 12px floor.
    expect(result.note).toContain('Upscaled')
    expect(result.note).not.toContain('too small to read')
  })

  test('image-bearing nodes bypass rendering and return the original bytes', async () => {
    const { graph, figma } = setupToolTest()
    // No exportImage mock on purpose — the original-bytes path must not need it
    const pageId = graph.getPages()[0].id
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const { hash } = figma.createImage(pngBytes)
    const rect = graph.createNode('RECTANGLE', pageId, { name: 'Photo', width: 143, height: 143 })
    graph.updateNode(rect.id, {
      fills: [
        {
          type: 'IMAGE',
          imageHash: hash,
          color: { r: 0, g: 0, b: 0, a: 0 },
          opacity: 1,
          visible: true
        }
      ]
    })

    const result = await runLook(figma, { id: rect.id, focus: 'what does this image show' })

    expect(result.error).toBeUndefined()
    expect(result.channel).toBe('A')
    expect(result.mimeType).toBe('image/png')
    expect(result.byteLength).toBe(pngBytes.length)
    expect(result.exportInfo?.mode).toBe('original-bytes')
    expect(result.exportInfo?.scale).toBeUndefined()
    expect(result.note).toContain('Original image bytes')
    expect(result.note).toContain('possibly cropped')
  })

  test('nodes with mixed fills still render via exportImage', async () => {
    const { graph, figma } = setupToolTest()
    const calls: ExportCall[] = []
    mockExportImage(figma, calls)
    const pageId = graph.getPages()[0].id
    const { hash } = figma.createImage(new Uint8Array([0xff, 0xd8, 1, 2]))
    const rect = graph.createNode('RECTANGLE', pageId, { name: 'Mix', width: 100, height: 100 })
    graph.updateNode(rect.id, {
      fills: [
        { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true },
        {
          type: 'IMAGE',
          imageHash: hash,
          color: { r: 0, g: 0, b: 0, a: 0 },
          opacity: 1,
          visible: true
        }
      ]
    })

    const result = await runLook(figma, { id: rect.id })

    expect(expectDefined(calls[0]).nodeIds).toEqual([rect.id])
    expect(result.mimeType).toBe('image/jpeg')
  })

  test('declares illegible text and lists drill-in child nodes on long designs', async () => {
    const { graph, figma } = setupToolTest()
    mockExportImage(figma, [])
    const pageId = graph.getPages()[0].id
    const root = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 4000 })
    const section = graph.createNode('FRAME', root.id, { name: 'Hero', width: 750, height: 1000 })
    const headline = graph.createNode('TEXT', section.id, {
      name: 'Headline',
      text: 'Hi',
      fontSize: 24
    })

    const result = await runLook(figma, { id: root.id })

    expect(result.note).toContain('too small to read')
    expect(result.note).toContain('look at these text nodes individually')
    expect(result.note).toContain(`${headline.id} (Headline)`)
    expect(result.note).not.toContain('Focus:')
  })

  test('drill targets are count-limited and names are trimmed', async () => {
    const { graph, figma } = setupToolTest()
    mockExportImage(figma, [])
    const pageId = graph.getPages()[0].id
    const root = graph.createNode('FRAME', pageId, { name: 'Detail', width: 750, height: 4000 })
    graph.createNode('TEXT', root.id, {
      name: 'A very long text node name that exceeds the drill-target label limit',
      text: 'x',
      fontSize: 24
    })
    for (let i = 0; i < 6; i++) {
      graph.createNode('TEXT', root.id, { name: `  Line ${i}  `, text: 'x', fontSize: 24 })
    }

    const result = await runLook(figma, { id: root.id })

    expect(result.note).toContain('and 2 more, look specific ids')
    expect(result.note).toContain('that exceeds …')
    expect(result.note).toContain('(Line 0)')
    expect(result.note).not.toContain('(  Line 0  )')
  })

  test('no legibility warning when text stays readable at export scale', async () => {
    const { graph, figma } = setupToolTest()
    mockExportImage(figma, [])
    const pageId = graph.getPages()[0].id
    const frame = graph.createNode('FRAME', pageId, { name: 'Card', width: 300, height: 250 })
    graph.createNode('TEXT', frame.id, { name: 'Body', text: 'Hi', fontSize: 24 })

    const result = await runLook(figma, { id: frame.id })

    expect(result.note).not.toContain('too small to read')
  })

  test('merges focus into the note so it reaches the model with the image', async () => {
    const { graph, figma } = setupToolTest()
    mockExportImage(figma, [])
    const pageId = graph.getPages()[0].id
    const frame = graph.createNode('FRAME', pageId, { name: 'Card', width: 300, height: 250 })

    const result = await runLook(figma, { id: frame.id, focus: 'text readability' })

    expect(result.note).toContain('Focus: text readability.')
    expect(result.channel).toBe('A')
  })

  test('returns the full fielded structure: image data + node metadata + export info', async () => {
    const { graph, figma } = setupToolTest()
    mockExportImage(figma, [])
    const pageId = graph.getPages()[0].id
    const frame = graph.createNode('FRAME', pageId, { name: 'Card', width: 800, height: 600 })

    const result = await runLook(figma, { id: frame.id, focus: 'layout proportions' })

    expect(result.error).toBeUndefined()
    // 图像数据（通道 A 载体）
    expect(typeof result.base64).toBe('string')
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.byteLength).toBe(4)
    // 节点元数据（分区钻取验收的承载字段）
    expect(result.node).toEqual({ id: frame.id, name: 'Card', width: 800, height: 600 })
    // 导出模式 + 缩放比
    expect(result.exportInfo).toEqual({ mode: 'isolated', scale: 1 })
    expect(result.channel).toBe('A')
    expect(result.focus).toBe('layout proportions')
    expect(typeof result.note).toBe('string')
  })
})

describe('media output registration (T55 channel A)', () => {
  const lookOutput = {
    base64: 'aGk=', // "hi"
    mimeType: 'image/png',
    byteLength: 2,
    channel: 'A',
    node: { id: '1:2', name: 'Card', width: 800, height: 600 },
    exportInfo: { mode: 'isolated', scale: 1 },
    note: 'Visual inspection of "Card".'
  }

  function toolEndEvent(toolName: string, details: unknown): AgentSessionEvent {
    return {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName,
      result: { content: [{ type: 'text', text: JSON.stringify(details) }], details },
      isError: false
    } as AgentSessionEvent
  }

  test('MEDIA_OUTPUT_TOOLS contains look', () => {
    expect(MEDIA_OUTPUT_TOOLS.has('look')).toBe(true)
  })

  test('isMediaToolOutput recognizes the look result shape and rejects others', () => {
    expect(isMediaToolOutput(lookOutput)).toBe(true)
    expect(isMediaToolOutput({ error: 'Node not found' })).toBe(false)
    expect(isMediaToolOutput('plain text')).toBe(false)
    expect(isMediaToolOutput(null)).toBe(false)
  })

  test('mapping converts a registered tool result into a file media chunk + sanitized output', () => {
    const mapper = createPiEventMapper('msg-1')
    const chunks = mapper(toolEndEvent('look', lookOutput))

    const file = chunks.find((c) => c.type === 'file')
    expect(file).toBeDefined()
    expect((file as { url: string }).url).toBe(`data:image/png;base64,${lookOutput.base64}`)
    expect((file as { mediaType: string }).mediaType).toBe('image/png')

    const output = chunks.find((c) => c.type === 'tool-output-available') as
      | { output: Record<string, unknown> }
      | undefined
    expect(output).toBeDefined()
    // base64 载荷不进 tool-output-available（图像本体走 file chunk）
    expect(output?.output.base64).not.toBe(lookOutput.base64)
    expect(String(output?.output.base64)).toContain('inlined as file part')
    expect(output?.output.note).toBe(lookOutput.note)
    expect(output?.output.node).toEqual(lookOutput.node)
    expect(output?.output.exportInfo).toEqual(lookOutput.exportInfo)
  })

  test('mapping leaves non-registered tool results untouched (no media chunk)', () => {
    const mapper = createPiEventMapper('msg-1')
    const details = { id: '1:2', name: 'Card' }
    const chunks = mapper(toolEndEvent('create_frame', details))

    expect(chunks.some((c) => c.type === 'file')).toBe(false)
    const output = chunks.find((c) => c.type === 'tool-output-available') as
      | { output: unknown }
      | undefined
    expect(output?.output).toEqual(details)
  })

  test('mapping falls back to plain output when a registered tool result carries no image', () => {
    const mapper = createPiEventMapper('msg-1')
    const details = { error: 'Node "9:9" not found' }
    const chunks = mapper(toolEndEvent('look', details))

    expect(chunks.some((c) => c.type === 'file')).toBe(false)
    const output = chunks.find((c) => c.type === 'tool-output-available') as
      | { output: unknown }
      | undefined
    expect(output?.output).toEqual(details)
  })

  test('mapping reports tool errors as tool-output-error, never as media', () => {
    const mapper = createPiEventMapper('msg-1')
    const event = {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'look',
      result: { content: [{ type: 'text', text: 'Editor is not reachable' }] },
      isError: true
    } as AgentSessionEvent
    const chunks = mapper(event)

    expect(chunks.some((c) => c.type === 'file')).toBe(false)
    expect(chunks.some((c) => c.type === 'tool-output-error')).toBe(true)
  })

  test('sanitizeMediaToolOutput strips only the base64 payload', () => {
    const sanitized = sanitizeMediaToolOutput(lookOutput)
    expect(sanitized.mimeType).toBe('image/png')
    expect(sanitized.byteLength).toBe(2)
    expect(String(sanitized.base64)).toBe('[inlined as file part, 4 chars]')
    expect('channel' in sanitized).toBe(true)
  })

  test('a real look result round-trips through the mapping media path', async () => {
    const { graph, figma } = setupToolTest()
    mockExportImage(figma, [])
    const pageId = graph.getPages()[0].id
    const frame = graph.createNode('FRAME', pageId, { name: 'Card', width: 800, height: 600 })

    const result = await runLook(figma, { id: frame.id })
    expect(result.error).toBeUndefined()
    expect(isMediaToolOutput(result)).toBe(true)

    const mapper = createPiEventMapper('msg-2')
    const chunks: UIMessageChunk[] = mapper(toolEndEvent('look', result))
    const file = chunks.find((c) => c.type === 'file') as { url: string } | undefined
    expect(file?.url.startsWith('data:image/jpeg;base64,')).toBe(true)
  })
})
