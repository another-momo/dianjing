/**
 * T54→T66：createImageGenTool 后端编排钉扎——
 * 双段执行顺序（begin 串行 / generate 并行 / commit 串行）、per-request
 * 失败隔离、无凭证结构化报错、key 不出后端进程（桥 payload + 结果零 key）。
 * T66 P4：工具参数 schema 化——execute 直接收类型化数组（JSON 字符串形态
 * 由 pi 运行时 schema 校验在 execute 前拒绝，见 tool-contract.test.ts）。
 */
import { describe, expect, test } from 'bun:test'

import { fromUint8Array } from 'js-base64'

import type { ImageGenProvider } from '@open-pencil/core/tools/fork/image-gen/requests'

import type { ImageGenCredentialStore } from '@/app/ai/pi-backend/image-gen/credentials'
import { createImageGenTool } from '@/app/ai/pi-backend/image-gen/generate'

import type { BridgeCall } from '#tests/engine/rebuild/image-gen/helpers'

const SECRET_KEY = 'sk-orchestrate-secret'

function fakeStore(apiKey: string | null): ImageGenCredentialStore {
  let credentials = apiKey
    ? {
        providerType: 'openai-compatible' as const,
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-image-1',
        apiKey
      }
    : null
  return {
    get: () => credentials,
    set: () => {
      throw new Error('fakeStore.set not used in orchestration tests')
    },
    clear: () => {
      credentials = null
    },
    status: () =>
      credentials
        ? {
            configured: true,
            providerType: credentials.providerType,
            baseUrl: credentials.baseUrl,
            model: credentials.model
          }
        : { configured: false },
    reloadForTests: () => undefined,
    exists: () => credentials !== null
  }
}

interface BridgeHandlers {
  image_gen_begin?: (args: Record<string, unknown>) => Record<string, unknown>
  image_gen_commit?: (args: Record<string, unknown>) => Record<string, unknown>
}

/** begin 带异步间隙——串行/并行可从事件序列分辨 */
function mockBridge(events: string[], handlers: BridgeHandlers = {}) {
  const calls: BridgeCall[] = []
  let beginSeq = 0
  const callBridge = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args })
    if (tool === 'image_gen_begin') {
      const seq = beginSeq++
      events.push(`begin:${seq}:start`)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5)
      })
      events.push(`begin:${seq}:end`)
      if (handlers.image_gen_begin) return handlers.image_gen_begin(args)
      return {
        id: `frame-${seq}`,
        width: (args.width as number) ?? 1024,
        height: (args.height as number) ?? 1024,
        canvasWidth: (args.width as number) ?? 1024,
        canvasHeight: (args.height as number) ?? 1024,
        replaced: false,
        images: []
      }
    }
    if (handlers.image_gen_commit) return handlers.image_gen_commit(args)
    return { id: args.id, canvasWidth: 1024, canvasHeight: 1024 }
  }
  return { calls, callBridge }
}

const GEN_BYTES = new Uint8Array([7, 7, 7])

function mockProvider(): {
  provider: ImageGenProvider
  started: string[]
  gate: { resolveAll: () => void; sawBoth: Promise<void> }
} {
  const started: string[] = []
  let resolveBoth!: () => void
  const sawBoth = new Promise<void>((resolve) => {
    resolveBoth = resolve
  })
  const pending: Array<() => void> = []
  const provider: ImageGenProvider = {
    name: 'mock-provider',
    transparentSupport: 'api',
    generate: (req) => {
      started.push(req.prompt)
      if (started.length === 2) resolveBoth()
      return new Promise((resolve) => {
        pending.push(() =>
          resolve({ bytes: GEN_BYTES, width: req.width ?? 1024, height: req.height ?? 1024 })
        )
      })
    }
  }
  return {
    provider,
    started,
    gate: {
      sawBoth,
      resolveAll: () => pending.forEach((resolve) => resolve())
    }
  }
}

const TWO_REQUESTS = [
  { prompt: 'candidate A', width: 1024, height: 1024 },
  { prompt: 'candidate B', width: 1024, height: 1024 }
]

describe('createImageGenTool 编排', () => {
  test('begin 串行 / generate 并行 / commit 携带生成字节', async () => {
    const events: string[] = []
    const { calls, callBridge } = mockBridge(events)
    const { provider, started, gate } = mockProvider()
    const tool = createImageGenTool({
      credentials: fakeStore(SECRET_KEY),
      callBridge,
      createProvider: () => provider
    })

    const run = tool.execute('call-1', { requests: TWO_REQUESTS })
    // 两个 generate 都启动（并行）后才放行
    await gate.sawBoth
    expect(started).toEqual(['candidate A', 'candidate B'])
    gate.resolveAll()
    const result = await run

    // begin 串行：begin:0 完整结束后 begin:1 才开始（00 #10 竞态修复）
    expect(events).toEqual(['begin:0:start', 'begin:0:end', 'begin:1:start', 'begin:1:end'])

    // commit 携带 base64 图像字节
    const commits = calls.filter((call) => call.tool === 'image_gen_commit')
    expect(commits).toHaveLength(2)
    expect(commits[0].args.image_data).toBe(fromUint8Array(GEN_BYTES))

    const details = result.details as {
      generated: number
      failed: number
      provider: string
      results: Array<{ id: string }>
    }
    expect(details.generated).toBe(2)
    expect(details.failed).toBe(0)
    expect(details.provider).toBe('mock-provider')
    expect(details.results.map((entry) => entry.id)).toEqual(['frame-0', 'frame-1'])
  })

  test('key 不出后端进程：桥 payload 与工具结果零 key', async () => {
    const events: string[] = []
    const { calls, callBridge } = mockBridge(events)
    const { provider, gate } = mockProvider()
    const tool = createImageGenTool({
      credentials: fakeStore(SECRET_KEY),
      callBridge,
      createProvider: () => provider
    })
    const run = tool.execute('call-1', { requests: TWO_REQUESTS })
    await gate.sawBoth
    gate.resolveAll()
    const result = await run

    const bridgePayload = JSON.stringify(calls)
    expect(bridgePayload).not.toContain(SECRET_KEY)
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY)
    // 桥参数只允许画布数据（无凭证字段）
    for (const call of calls) {
      expect(Object.keys(call.args)).not.toContain('apiKey')
      expect(Object.keys(call.args)).not.toContain('key')
    }
  })

  test('无凭证 → 结构化错误引导配置，零桥调用零 provider 调用', async () => {
    const events: string[] = []
    const { calls, callBridge } = mockBridge(events)
    const { provider } = mockProvider()
    const tool = createImageGenTool({
      credentials: fakeStore(null),
      callBridge,
      createProvider: () => provider
    })
    const result = await tool.execute('call-1', { requests: TWO_REQUESTS })
    const details = result.details as { error?: string }
    expect(details.error).toContain('No image-gen provider configured')
    expect(calls).toHaveLength(0)
  })

  test('requests 空数组 → {error}，零桥调用', async () => {
    const events: string[] = []
    const { calls, callBridge } = mockBridge(events)
    const tool = createImageGenTool({
      credentials: fakeStore(SECRET_KEY),
      callBridge,
      createProvider: () => mockProvider().provider
    })
    const result = await tool.execute('call-1', { requests: [] })
    expect((result.details as { error?: string }).error).toContain('Empty requests array')
    expect(calls).toHaveLength(0)
  })

  test('per-request 失败隔离：单条 begin 失败不影响他条', async () => {
    const events: string[] = []
    const { callBridge } = mockBridge(events, {
      image_gen_begin: (args) => {
        if (args.prompt === 'candidate A') return { error: 'reference node missing' }
        return {
          id: 'frame-ok',
          width: 1024,
          height: 1024,
          canvasWidth: 1024,
          canvasHeight: 1024,
          replaced: false,
          images: []
        }
      }
    })
    const provider: ImageGenProvider = {
      name: 'mock-provider',
      transparentSupport: 'api',
      generate: async (req) => ({
        bytes: GEN_BYTES,
        width: req.width ?? 1024,
        height: req.height ?? 1024
      })
    }
    const tool = createImageGenTool({
      credentials: fakeStore(SECRET_KEY),
      callBridge,
      createProvider: () => provider
    })
    const result = await tool.execute('call-1', { requests: TWO_REQUESTS })
    const details = result.details as {
      generated: number
      failed: number
      results: Array<{ id: string; error?: string }>
    }
    expect(details.generated).toBe(1)
    expect(details.failed).toBe(1)
    expect(details.results[0].error).toBe('reference node missing')
    expect(details.results[1].id).toBe('frame-ok')
  })

  test('references 序列化进 begin（节点 id / composite 形态）', async () => {
    const events: string[] = []
    const { calls, callBridge } = mockBridge(events)
    const provider: ImageGenProvider = {
      name: 'mock-provider',
      transparentSupport: 'api',
      generate: async () => ({ bytes: GEN_BYTES, width: 1024, height: 1024 })
    }
    const tool = createImageGenTool({
      credentials: fakeStore(SECRET_KEY),
      callBridge,
      createProvider: () => provider
    })
    await tool.execute('call-1', {
      requests: [
        {
          prompt: 'edit',
          replace_id: '0:7',
          references: [{ id: '0:7' }, { id: '0:9', composite: true }]
        }
      ]
    })
    const begin = calls.find((call) => call.tool === 'image_gen_begin')
    expect(begin?.args.replace_id).toBe('0:7')
    expect(JSON.parse(String(begin?.args.references))).toEqual([
      { id: '0:7' },
      { id: '0:9', composite: true }
    ])
  })
})
