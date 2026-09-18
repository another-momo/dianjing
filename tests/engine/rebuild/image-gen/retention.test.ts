/**
 * generate_image 本地留存挂钩钉扎（owner 拍板：写盘失败静默，不污染画布 commit）。
 *
 * 覆盖：
 *  - enabled()=true + 固定 bytes → 落盘字节一致、文件名形态不变；2026-09-18
 *    重排起按生图日期分桶 `<根>/<YYYY-MM-DD>/`（桶目录自动创建）
 *  - enabled()=false → 目录无文件
 *  - dir() 抛错 → 工具结果正常且不含留存错误信息
 *  - writeFileSync 抛错（如目录权限拒）→ 工具结果正常且不含留存错误信息
 *
 * 测试纪律：禁读真实 env；全走注入 + tmp fixture（mkdtempSync）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ImageGenProvider } from '@open-pencil/core/tools/fork/image-gen/requests'

import type { ImageGenCredentialStore } from '@/app/ai/pi-backend/image-gen/credentials'
import { createImageGenTool } from '@/app/ai/pi-backend/image-gen/generate'
import { formatImageGenDateBucket } from '@/app/ai/pi-backend/paths'

// 借 orchestration.test.ts 的 fakeStore 形态（这里重新声明以保持单测自包含）
function fakeStore(): ImageGenCredentialStore {
  const credentials = {
    providerType: 'openai-compatible' as const,
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-image-1',
    apiKey: 'sk-retention'
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

// 固定 bytes（8 bytes 全 7）——断言落盘字节一致；与 orchestration.test.ts 的 GEN_BYTES 一致
const GEN_BYTES = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7])

interface FakeBridge {
  callBridge: (
    tool: string,
    args: Record<string, unknown>,
    target?: unknown
  ) => Promise<Record<string, unknown>>
}

function fakeBridge(width: number, height: number): FakeBridge {
  let seq = 0
  return {
    async callBridge(tool, _args) {
      if (tool === 'image_gen_begin') {
        const id = `frame-${seq++}`
        return {
          id,
          width,
          height,
          canvasWidth: width,
          canvasHeight: height,
          replaced: false,
          images: []
        }
      }
      // image_gen_commit
      return { id: _args.id, canvasWidth: width, canvasHeight: height }
    }
  }
}

function fixedProvider(bytes: Uint8Array, width: number, height: number): ImageGenProvider {
  return {
    name: 'mock',
    transparentSupport: 'api',
    generate: async () => ({ bytes, width, height })
  }
}

describe('generate_image 本地留存挂钩', () => {
  let tmpRoot = ''
  let tmpDir = ''

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'openpencil-imagegen-retention-'))
    tmpDir = join(tmpRoot, 'image-gen-output')
  })

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
    tmpRoot = ''
    tmpDir = ''
  })

  /** 当天日期桶目录（2026-09-18 重排：`<留存根>/<YYYY-MM-DD>/`，本地时区） */
  function todayBucketDir(): string {
    return join(tmpDir, formatImageGenDateBucket(new Date()))
  }

  /** 读留存根下唯一日期桶内的文件清单（[桶名, 文件们]） */
  function readBucketFiles(): { bucket: string; files: string[] } {
    const buckets = readdirSync(tmpDir)
    expect(buckets).toHaveLength(1)
    const bucket = buckets[0] ?? ''
    expect(bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(bucket).toBe(formatImageGenDateBucket(new Date()))
    return { bucket, files: readdirSync(join(tmpDir, bucket)) }
  }

  test('enabled()=true → 日期桶创建 + 落盘文件字节一致 + 文件名形态不变（YYYYMMDD-HHMMSS-<idx>-<w>x<h>.png）', async () => {
    const { callBridge } = fakeBridge(1024, 768)
    const tool = createImageGenTool({
      credentials: fakeStore(),
      callBridge,
      createProvider: () => fixedProvider(GEN_BYTES, 1024, 768),
      retention: {
        enabled: () => true,
        dir: () => tmpDir
      }
    })

    await tool.execute('call-1', { requests: [{ prompt: 'a', width: 1024, height: 768 }] })

    const { bucket, files } = readBucketFiles()
    expect(files).toHaveLength(1)
    const name = files[0] ?? ''
    // 文件名形态（不变）：YYYYMMDD-HHMMSS-0-1024x768.png
    expect(name).toMatch(/^\d{8}-\d{6}-0-1024x768\.png$/)
    // 字节一致
    const written = readFileSync(join(tmpDir, bucket, name))
    expect(Array.from(written)).toEqual(Array.from(GEN_BYTES))
  })

  test('多 item 同秒：同桶内批次序号后缀区分（0/1）', async () => {
    const { callBridge } = fakeBridge(512, 512)
    const tool = createImageGenTool({
      credentials: fakeStore(),
      callBridge,
      createProvider: () => fixedProvider(GEN_BYTES, 512, 512),
      retention: {
        enabled: () => true,
        dir: () => tmpDir
      }
    })

    await tool.execute('call-1', {
      requests: [
        { prompt: 'a', width: 512, height: 512 },
        { prompt: 'b', width: 512, height: 512 }
      ]
    })

    const { files } = readBucketFiles()
    expect(files).toHaveLength(2)
    const suffixes = files.map((name) => {
      const m = name.match(/-(\d+)-512x512\.png$/)
      return m?.[1]
    })
    expect(suffixes.sort()).toEqual(['0', '1'])
  })

  test('jpeg + transparent（local provider 强制 png）：扩展名取最终生效格式 .png 而非 .jpeg', async () => {
    const { callBridge } = fakeBridge(1024, 768)
    // local provider：transparent 走 prompt 注入 + 后处理——GEN_BYTES 非真 PNG，
    // 后处理必抛错回退原 bytes（item.gen 仍在）；formatOverride 已强制 png，
    // 扩展名必须反映最终格式而非 item.req.outputFormat
    const tool = createImageGenTool({
      credentials: fakeStore(),
      callBridge,
      createProvider: () => ({
        name: 'mock-local',
        transparentSupport: 'local' as const,
        generate: async () => ({ bytes: GEN_BYTES, width: 1024, height: 768 })
      }),
      retention: {
        enabled: () => true,
        dir: () => tmpDir
      }
    })

    await tool.execute('call-1', {
      requests: [
        {
          prompt: 'a',
          width: 1024,
          height: 768,
          output_format: 'jpeg' as const,
          transparent_background: true
        }
      ]
    })

    const { files } = readBucketFiles()
    expect(files).toHaveLength(1)
    expect(files[0] ?? '').toMatch(/\.png$/)
  })

  test('enabled()=false → 目录无文件', async () => {
    const { callBridge } = fakeBridge(1024, 768)
    const tool = createImageGenTool({
      credentials: fakeStore(),
      callBridge,
      createProvider: () => fixedProvider(GEN_BYTES, 1024, 768),
      retention: {
        enabled: () => false,
        dir: () => tmpDir
      }
    })

    await tool.execute('call-1', { requests: [{ prompt: 'a', width: 1024, height: 768 }] })

    // enabled()=false 时不 mkdir（maybeRetain 早返）
    expect(existsSync(tmpDir)).toBe(false)
  })

  test('enabled() 未注入 → 不抛、目录无文件（向后兼容）', async () => {
    const { callBridge } = fakeBridge(1024, 768)
    const tool = createImageGenTool({
      credentials: fakeStore(),
      callBridge,
      createProvider: () => fixedProvider(GEN_BYTES, 1024, 768)
    })

    const result = await tool.execute('call-1', {
      requests: [{ prompt: 'a', width: 1024, height: 768 }]
    })
    const details = result.details as { generated: number; failed: number; error?: string }
    expect(details.generated).toBe(1)
    expect(details.error).toBeUndefined()
    expect(existsSync(tmpDir)).toBe(false)
  })

  test('dir() 抛错 → 工具结果正常（generated=1, failed=0, 无留存错误信息）', async () => {
    const { callBridge } = fakeBridge(1024, 768)
    const tool = createImageGenTool({
      credentials: fakeStore(),
      callBridge,
      createProvider: () => fixedProvider(GEN_BYTES, 1024, 768),
      retention: {
        enabled: () => true,
        dir: () => {
          throw new Error('dir resolution failed')
        }
      }
    })

    const result = await tool.execute('call-1', {
      requests: [{ prompt: 'a', width: 1024, height: 768 }]
    })
    const details = result.details as {
      generated: number
      failed: number
      results: Array<{ id: string; error?: string }>
      note?: string
      warning?: string
    }
    expect(details.generated).toBe(1)
    expect(details.failed).toBe(0)
    // 不含任何留存错误信息（不进 results / note / warning）
    expect(JSON.stringify(details)).not.toContain('dir resolution failed')
    expect(details.note).toBeUndefined()
    expect(details.warning).toBeUndefined()
  })

  test('writeFileSync 抛错（只读目录）→ 工具结果正常，不含留存错误信息', async () => {
    // 2026-09-18 重排：写盘落点在日期桶——预建当天桶并把桶 chmod 只读，
    // 让 mkdirSync 走通（桶已存在）而 writeFileSync 抛 EACCES
    const bucketDir = todayBucketDir()
    mkdirSync(bucketDir, { recursive: true })
    chmodSync(bucketDir, 0o500) // 只读不可写（POSIX；win 下语义不同但 chmod 不抛错，writeFileSync 仍会失败）
    try {
      const { callBridge } = fakeBridge(1024, 768)
      const tool = createImageGenTool({
        credentials: fakeStore(),
        callBridge,
        createProvider: () => fixedProvider(GEN_BYTES, 1024, 768),
        retention: {
          enabled: () => true,
          dir: () => tmpDir
        }
      })

      const result = await tool.execute('call-1', {
        requests: [{ prompt: 'a', width: 1024, height: 768 }]
      })
      const details = result.details as {
        generated: number
        failed: number
        results: Array<{ id: string; error?: string }>
        note?: string
        warning?: string
      }
      expect(details.generated).toBe(1)
      expect(details.failed).toBe(0)
      // 写盘失败透不进 toolResult / note / warning
      expect(details.note).toBeUndefined()
      expect(details.warning).toBeUndefined()
      for (const r of details.results) {
        expect(r.error).toBeUndefined()
      }
    } finally {
      // 恢复权限让 cleanup 能删
      try {
        chmodSync(bucketDir, 0o700)
      } catch (error) {
        // win 下可能不可恢复——tmpRoot cleanup force=true 一般能盖；留痕过 no-silent-catch
        console.warn(
          '[test] chmod 恢复失败（忽略，cleanup force 兜底）：' +
            (error instanceof Error ? error.message : String(error))
        )
      }
    }
  })
})
