/**
 * T33：transparent_background local 路径端到端——seedream 走 prompt 键色注入 +
 * 本地键色抠图后处理。
 *
 * 测试策略：
 * - 用 transparent.ts 自带编码器程序化构造小型键色 PNG（避免读外部文件、禁 DOM
 *   依赖）→ mock fetch 返回它 → generate.ts 编排层跑完后端处理 → 断言下发到
 *   provider 的 prompt 含 KEY_COLOR_PROMPT_SUFFIX + 最终 commit payload 的
 *   PNG 字节四角透明、中心不透明（验证后处理出口）。
 */
import { describe, expect, test } from 'bun:test'

import { fromUint8Array, toUint8Array } from 'js-base64'

import type {
  ImageGenProvider,
  ImageGenRequest
} from '@open-pencil/core/tools/fork/image-gen/requests'

import type { ImageGenCredentialStore } from '@/app/ai/pi-backend/image-gen/credentials'
import { createImageGenTool } from '@/app/ai/pi-backend/image-gen/generate'
import { __test__, KEY_COLOR_PROMPT_SUFFIX } from '@/app/ai/pi-backend/image-gen/transparent'

import type { BridgeCall } from '#tests/engine/rebuild/image-gen/helpers'

function fakeStore(apiKey: string): ImageGenCredentialStore {
  return {
    get: () => ({
      providerType: 'seedream' as const,
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seedream-5-0-lite',
      apiKey
    }),
    set: () => undefined,
    clear: () => undefined,
    status: () => ({
      configured: true,
      providerType: 'seedream',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seedream-5-0-lite'
    }),
    reloadForTests: () => undefined,
    exists: () => true
  }
}

function mockBridge() {
  const calls: BridgeCall[] = []
  let seq = 0
  const callBridge = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args })
    if (tool === 'image_gen_begin') {
      const id = `frame-${seq++}`
      return {
        id,
        width: (args.width as number) ?? 16,
        height: (args.height as number) ?? 16,
        canvasWidth: (args.width as number) ?? 16,
        canvasHeight: (args.height as number) ?? 16,
        replaced: false,
        images: []
      }
    }
    return { id: args.id, canvasWidth: 16, canvasHeight: 16 }
  }
  return { calls, callBridge }
}

/**
 * 程序化构造 16x16 RGBA PNG——四角键色绿 (#00FF00)、中心红色块。
 * 编码直接走 transparent.ts 的 __test__.encodePNGRgba8（测试自有副本会被
 * jscpd 判克隆 / type-shapes 判形状重复——CI 34443074196 教训）。
 */
function buildKeyColorPNG(): Uint8Array {
  const width = 16
  const height = 16
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const isCenter = x >= 6 && x <= 9 && y >= 6 && y <= 9
      data[i] = isCenter ? 220 : 0
      data[i + 1] = isCenter ? 30 : 255
      data[i + 2] = isCenter ? 30 : 0
      data[i + 3] = 255
    }
  }
  return __test__.encodePNGRgba8(data, width, height)
}

describe('transparent_background local 路径（seedream = transparentSupport=local）', () => {
  test('透明=true → 下发 prompt 含 KEY_COLOR_PROMPT_SUFFIX；commit 携带去键色 RGBA PNG', async () => {
    const keyPNG = buildKeyColorPNG()
    const seenPrompts: string[] = []
    const provider: ImageGenProvider = {
      name: 'mock-seedream',
      transparentSupport: 'local',
      generate: async (req: ImageGenRequest) => {
        seenPrompts.push(req.prompt)
        return { bytes: keyPNG, width: req.width ?? 16, height: req.height ?? 16 }
      }
    }
    const { calls, callBridge } = mockBridge()
    const tool = createImageGenTool({
      credentials: fakeStore('sk-test'),
      callBridge,
      createProvider: () => provider
    })
    const result = await tool.execute('call-1', {
      requests: [{ prompt: 'icon', width: 16, height: 16, transparent_background: true }]
    })

    // 1) 下发到 provider 的 prompt 含 KEY_COLOR_PROMPT_SUFFIX
    expect(seenPrompts).toHaveLength(1)
    expect(seenPrompts[0]).toContain('icon')
    expect(seenPrompts[0]).toContain(KEY_COLOR_PROMPT_SUFFIX)

    // 2) begin 段 prompt 仍为原 prompt（注入只在 generate 段）
    const beginCall = calls.find((c) => c.tool === 'image_gen_begin')
    if (!beginCall) throw new Error('expected image_gen_begin call')
    expect((beginCall.args as { prompt: string }).prompt).toBe('icon')

    // 3) commit 阶段 image_data 是去键色后的 PNG——四角 alpha<128、中心 alpha>128
    const commitCall = calls.find((c) => c.tool === 'image_gen_commit')
    if (!commitCall) throw new Error('expected image_gen_commit call')
    const imageB64 = String((commitCall.args as { image_data: string }).image_data)
    const decoded = __test__.decodePNGRgba8(toUint8Array(imageB64))
    expect(decoded.colorType).toBe(6) // RGBA
    expect(decoded.width).toBe(16)
    expect(decoded.height).toBe(16)
    const corner = decoded.data[3] ?? 255 // top-left
    expect(corner).toBeLessThan(128)
    const centerIndex = (7 * 16 + 7) * 4
    const centerAlpha = decoded.data[centerIndex + 3] ?? 0
    expect(centerAlpha).toBeGreaterThanOrEqual(128)

    // 4) 结果项 transparent=true（post-process 成功）
    const details = result.details as {
      results: Array<{ transparent?: boolean | 'failed' }>
    }
    expect(details.results[0]?.transparent).toBe(true)
  })

  test('透明=false / 未传 → prompt 不含 KEY_COLOR_PROMPT_SUFFIX；commit 用原 bytes', async () => {
    const keyPNG = buildKeyColorPNG()
    const seenPrompts: string[] = []
    const provider: ImageGenProvider = {
      name: 'mock-seedream',
      transparentSupport: 'local',
      generate: async (req: ImageGenRequest) => {
        seenPrompts.push(req.prompt)
        return { bytes: keyPNG, width: req.width ?? 16, height: req.height ?? 16 }
      }
    }
    const { calls, callBridge } = mockBridge()
    const tool = createImageGenTool({
      credentials: fakeStore('sk-test'),
      callBridge,
      createProvider: () => provider
    })
    await tool.execute('call-1', {
      requests: [
        { prompt: 'opaque', width: 16, height: 16, transparent_background: false },
        { prompt: 'normal', width: 16, height: 16 }
      ]
    })

    expect(seenPrompts[0]).toBe('opaque')
    expect(seenPrompts[1]).toBe('normal')
    expect(seenPrompts[0]).not.toContain('[背景指令]')
    expect(seenPrompts[1]).not.toContain('[背景指令]')

    const commitBodies = calls
      .filter((c) => c.tool === 'image_gen_commit')
      .map((c) => (c.args as { image_data: string }).image_data)
    // 两条 commit 携带的 bytes 都与原 keyPNG 字节一致（不经后处理）
    expect(commitBodies[0]).toBe(commitBodies[1])
  })

  test('api provider（transparentSupport=api）下发 prompt 不注入键色规则', async () => {
    const keyPNG = buildKeyColorPNG()
    const seenPrompts: string[] = []
    const provider: ImageGenProvider = {
      name: 'mock-openai',
      transparentSupport: 'api',
      generate: async (req: ImageGenRequest) => {
        seenPrompts.push(req.prompt)
        return { bytes: keyPNG, width: req.width ?? 16, height: req.height ?? 16 }
      }
    }
    const { callBridge } = mockBridge()
    const tool = createImageGenTool({
      credentials: fakeStore('sk-test'),
      callBridge,
      createProvider: () => provider
    })
    await tool.execute('call-1', {
      requests: [{ prompt: 'cutout', width: 16, height: 16, transparent_background: true }]
    })
    expect(seenPrompts[0]).toBe('cutout') // api 路径不下发键色规则
    expect(seenPrompts[0]).not.toContain('[背景指令]')
  })

  test('local 路径后处理抛错 → 结果项 transparent="failed" + commit 仍用原 bytes（回退）', async () => {
    const badBytes = new Uint8Array([1, 2, 3]) // 非法 PNG → transparent.ts 抛错
    const provider: ImageGenProvider = {
      name: 'mock-seedream',
      transparentSupport: 'local',
      generate: async (req: ImageGenRequest) => ({
        bytes: badBytes,
        width: req.width ?? 16,
        height: req.height ?? 16
      })
    }
    const { calls, callBridge } = mockBridge()
    const tool = createImageGenTool({
      credentials: fakeStore('sk-test'),
      callBridge,
      createProvider: () => provider
    })
    const result = await tool.execute('call-1', {
      requests: [{ prompt: 'cutout', width: 16, height: 16, transparent_background: true }]
    })

    const commitCall = calls.find((c) => c.tool === 'image_gen_commit')
    expect(commitCall).toBeDefined()
    if (!commitCall) throw new Error('expected image_gen_commit call')
    const imageB64 = String((commitCall.args as { image_data: string }).image_data)
    // 原 bytes 回退——base64 后内容应该和 badBytes 一致
    expect(imageB64).toBe(fromUint8Array(badBytes))

    const details = result.details as {
      results: Array<{ transparent?: boolean | 'failed' }>
    }
    expect(details.results[0]?.transparent).toBe('failed')
  })
})
