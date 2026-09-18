/**
 * 2026-09-18 本地图片工具链（仓外 docs/202609151700-load-image-tool-research.md
 * §4，Phase 3）：export_image_to_file 后端包装层单测。
 *
 * 覆盖：
 *  - 桥调 core export_image 参数透传（ids/format/scale/maxEdge）+ 结果
 *    {error} 透传 + 无 base64 报错 + 桥抛错透传
 *  - 默认落点：workspace/image-gen-output/<YYYY-MM-DD>/（resolveImageGenDatedDir）
 *    + 文件名对齐 maybeRetain 约定 `YYYYMMDD-hhmmss-0-<宽>x<高>.<ext>`
 *  - 显式 output_path：workspace 内 allow（写盘字节一致）；workspace/.agents/**
 *    与出界 deny（不落盘）；父目录自动创建
 *  - 返回值：file_path/mimeType/width/height/byteLength
 *
 * 测试纪律：禁读真实 env/真实 home；tmp fixture 合成根；桥调用一律 mock。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createExportImageToFileTool } from '@/app/ai/pi-backend/export-image-to-file'
import { formatImageGenDateBucket } from '@/app/ai/pi-backend/paths'

import { bridgeStub, type BridgeStub } from './helpers'

const EXPORT_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9])

let rootDir = ''
let workspaceDir = ''

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'openpencil-export-image-'))
  workspaceDir = join(rootDir, 'workspace')
  mkdirSync(workspaceDir, { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

function exportBridge(
  overrides: Partial<{ result: Record<string, unknown>; throws: Error }> = {}
): BridgeStub {
  return bridgeStub(
    {
      base64: Buffer.from(EXPORT_BYTES).toString('base64'),
      mimeType: 'image/png',
      byteLength: EXPORT_BYTES.byteLength,
      width: 640,
      height: 480,
      scale: 1
    },
    overrides
  )
}

function makeTool(stub: BridgeStub) {
  return createExportImageToFileTool({
    rootDir,
    homeDir: join(rootDir, 'home'),
    callBridge: stub.callBridge
  })
}

/** export_image_to_file 工具结果 details 形态（错误面 + 成功面并集，测试钉扎用） */
interface ExportToFileDetails {
  error?: string
  reason?: 'denied'
  file_path?: string
  mimeType?: string
  width?: number
  height?: number
  byteLength?: number
}

async function details(
  tool: ReturnType<typeof makeTool>,
  params: Record<string, unknown>
): Promise<ExportToFileDetails> {
  const result = await tool.execute('call-1', params)
  return result.details as ExportToFileDetails
}

describe('默认落点与命名', () => {
  test('省略 output_path → workspace/image-gen-output/<YYYY-MM-DD>/ + maybeRetain 命名约定', async () => {
    const stub = exportBridge()
    const d = await details(makeTool(stub), {})
    const filePath = String(d.file_path)
    const bucket = formatImageGenDateBucket(new Date())
    const expectedDir = join(workspaceDir, 'image-gen-output', bucket)
    expect(filePath.startsWith(expectedDir)).toBe(true)
    const name = filePath.slice(expectedDir.length + 1)
    // 命名对齐 maybeRetain：YYYYMMDD-hhmmss-<序号>-<宽>x<高>.<ext>（单文件序号 0）
    expect(name).toMatch(/^\d{8}-\d{6}-0-640x480\.png$/)
    // 字节一致
    expect(readFileSync(filePath)).toEqual(Buffer.from(EXPORT_BYTES))
    // 返回值字段
    expect(d.mimeType).toBe('image/png')
    expect(d.width).toBe(640)
    expect(d.height).toBe(480)
    expect(d.byteLength).toBe(EXPORT_BYTES.byteLength)
  })

  test('format=JPG → 桥参数透传 + 默认文件名 .jpg', async () => {
    const stub = exportBridge({
      result: {
        base64: Buffer.from(EXPORT_BYTES).toString('base64'),
        mimeType: 'image/jpeg',
        width: 100,
        height: 50
      }
    })
    const d = await details(makeTool(stub), { format: 'JPG', scale: 2, maxEdge: 2048 })
    expect(stub.calls[0]?.tool).toBe('export_image')
    expect(stub.calls[0]?.args).toMatchObject({ format: 'JPG', scale: 2, maxEdge: 2048 })
    expect(String(d.file_path)).toMatch(/\.jpg$/)
  })
})

describe('显式 output_path 三态裁决（写侧）', () => {
  test('workspace 内 → allow，写盘字节一致，父目录自动创建', async () => {
    const target = join(workspaceDir, 'exports', 'hero.png')
    const d = await details(makeTool(exportBridge()), { output_path: target })
    expect(d.error).toBeUndefined()
    expect(String(d.file_path).replaceAll('\\', '/')).toBe(target.replaceAll('\\', '/'))
    expect(readFileSync(String(d.file_path))).toEqual(Buffer.from(EXPORT_BYTES))
  })

  test('workspace/.agents/** → deny（不落盘）', async () => {
    const target = join(workspaceDir, '.agents', 'skills', 'x', 'hero.png')
    const d = await details(makeTool(exportBridge()), { output_path: target })
    expect(d.reason).toBe('denied')
    expect(existsSync(target)).toBe(false)
  })

  test('出界（rootDir 一级）→ deny（不落盘）', async () => {
    const target = join(rootDir, 'hero.png')
    const d = await details(makeTool(exportBridge()), { output_path: target })
    expect(d.reason).toBe('denied')
    expect(String(d.error)).toContain('outside workspace')
    expect(existsSync(target)).toBe(false)
  })
})

describe('桥缝错误面', () => {
  test('桥结果 {error} → 原样透传（不写盘）', async () => {
    const stub = exportBridge({ result: { error: 'No visible nodes to export' } })
    const d = await details(makeTool(stub), {})
    expect(d.error).toBe('No visible nodes to export')
    expect(d.file_path).toBeUndefined()
  })

  test('桥结果缺 base64 → Export failed', async () => {
    const stub = exportBridge({ result: { mimeType: 'image/png' } })
    const d = await details(makeTool(stub), {})
    expect(String(d.error)).toContain('Export failed')
  })

  test('桥抛错（连接级）→ 模型可见错误文案', async () => {
    const stub = exportBridge({
      throws: new Error('Editor is not reachable — make sure the Dianjing Studio app is open')
    })
    const d = await details(makeTool(stub), {})
    expect(String(d.error)).toContain('Editor is not reachable')
  })

  test('ids 透传到桥参数', async () => {
    const stub = exportBridge()
    await details(makeTool(stub), { ids: ['1:2', '1:3'] })
    expect(stub.calls[0]?.args.ids).toEqual(['1:2', '1:3'])
  })
})
