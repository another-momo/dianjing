/**
 * 2026-09-18 本地图片工具链（仓外 docs/202609151700-load-image-tool-research.md
 * §4.1）：generate_image 透出 file_path 钉扎。
 *
 * 覆盖：
 *  - maybeRetain 命中留存 → 结果项 file_path = 落盘绝对路径（日期桶内），
 *    文件真实存在、字节一致；mimeType/byteLength 同步透出
 *  - 留存关闭（enabled()=false）→ file_path = null
 *  - retention 未注入 → file_path = null（向后兼容）
 *  - 写盘失败（只读目录）→ file_path = null 且结果其余字段不受影响
 *    （留存失败静默语义不变）
 *
 * 测试纪律：禁读真实 env；tmp fixture + 注入（retention.test.ts 同款形态）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ImageGenProvider } from '@open-pencil/core/tools/fork/image-gen/requests'

import type { ImageGenCredentialStore } from '@/app/ai/pi-backend/image-gen/credentials'
import { createImageGenTool } from '@/app/ai/pi-backend/image-gen/generate'
import { formatImageGenDateBucket } from '@/app/ai/pi-backend/paths'

import type { BridgeCall } from '#tests/engine/rebuild/image-gen/helpers'

const GEN_BYTES = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7])

function fakeStore(): ImageGenCredentialStore {
  const credentials = {
    providerType: 'openai-compatible' as const,
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-image-1',
    apiKey: 'sk-file-path'
  }
  return {
    get: () => credentials,
    set: () => {
      throw new Error('not used')
    },
    clear: () => undefined,
    status: () => ({
      configured: true,
      providerType: credentials.providerType,
      baseUrl: credentials.baseUrl,
      model: credentials.model
    }),
    reloadForTests: () => undefined,
    exists: () => true
  }
}

function fakeBridge(width: number, height: number) {
  const calls: BridgeCall[] = []
  const callBridge = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args })
    if (tool === 'image_gen_begin') {
      return {
        id: 'frame-0',
        width,
        height,
        canvasWidth: width,
        canvasHeight: height,
        replaced: false,
        images: []
      }
    }
    return { id: args.id, canvasWidth: width, canvasHeight: height }
  }
  return { calls, callBridge }
}

function fixedProvider(): ImageGenProvider {
  return {
    name: 'mock',
    transparentSupport: 'api',
    generate: async () => ({ bytes: GEN_BYTES, width: 1024, height: 768 })
  }
}

type ItemResultDetails = {
  generated: number
  results: Array<{
    id: string
    file_path?: string | null
    mimeType?: string
    byteLength?: number
    error?: string
  }>
}

describe('generate_image 透出 file_path', () => {
  let tmpRoot = ''
  let retainDir = ''

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'openpencil-gen-file-path-'))
    retainDir = join(tmpRoot, 'image-gen-output')
  })

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
    tmpRoot = ''
    retainDir = ''
  })

  async function runOnce(retention?: { enabled(): boolean; dir(): string }) {
    const { callBridge } = fakeBridge(1024, 768)
    const tool = createImageGenTool({
      credentials: fakeStore(),
      callBridge,
      createProvider: fixedProvider,
      ...(retention ? { retention } : {})
    })
    const result = await tool.execute('call-1', {
      requests: [{ prompt: 'a', width: 1024, height: 768 }]
    })
    return result.details as ItemResultDetails
  }

  test('留存命中 → file_path = 日期桶内绝对路径，文件存在且字节一致；mimeType/byteLength 透出', async () => {
    const d = await runOnce({ enabled: () => true, dir: () => retainDir })
    expect(d.generated).toBe(1)
    const item = d.results[0]
    expect(item?.error).toBeUndefined()
    const filePath = item?.file_path
    expect(typeof filePath).toBe('string')
    const bucketDir = join(retainDir, formatImageGenDateBucket(new Date()))
    expect(String(filePath).startsWith(bucketDir)).toBe(true)
    expect(existsSync(String(filePath))).toBe(true)
    expect(readFileSync(String(filePath))).toEqual(Buffer.from(GEN_BYTES))
    expect(item?.mimeType).toBe('image/png')
    expect(item?.byteLength).toBe(GEN_BYTES.byteLength)
  })

  test('留存关闭 → file_path = null', async () => {
    const d = await runOnce({ enabled: () => false, dir: () => retainDir })
    expect(d.results[0]?.file_path).toBeNull()
    expect(existsSync(retainDir)).toBe(false)
  })

  test('retention 未注入 → file_path = null（向后兼容）', async () => {
    const d = await runOnce()
    expect(d.results[0]?.file_path).toBeNull()
  })

  test('写盘失败（只读日期桶）→ file_path = null，结果其余字段不受影响（静默语义不变）', async () => {
    const bucketDir = join(retainDir, formatImageGenDateBucket(new Date()))
    mkdirSync(bucketDir, { recursive: true })
    chmodSync(bucketDir, 0o500)
    try {
      const d = await runOnce({ enabled: () => true, dir: () => retainDir })
      expect(d.generated).toBe(1)
      expect(d.results[0]?.error).toBeUndefined()
      expect(d.results[0]?.file_path).toBeNull()
      expect(d.results[0]?.mimeType).toBe('image/png')
    } finally {
      try {
        chmodSync(bucketDir, 0o700)
      } catch (error) {
        console.warn(
          '[test] chmod 恢复失败（忽略，cleanup force 兜底）：' +
            (error instanceof Error ? error.message : String(error))
        )
      }
    }
  })
})
