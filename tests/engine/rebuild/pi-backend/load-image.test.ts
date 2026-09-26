/**
 * 2026-09-18 本地图片工具链（仓外 docs/202609151700-load-image-tool-research.md
 * §3/§6）：load_image 后端工具单测。
 *
 * 覆盖（验收映射 = 方案 §3.3/§3.4 校验表）：
 *  - 路径判定（2026-09-19 A线尾单件1 翻正）：workspace 子树 allow（含相对
 *    路径按 workspace cwd 解析）/ 界外静默 allow（rootDir 一级真实文件过桥；
 *    盘外不存在路径落到 fs 层 File not found 而非 denied）/ workspace/.agents、
 *    .pi 读侧放行（写侧三根不拦读）/ 敏感名单硬拒（凭据四件、~/.ssh/**、
 *    workspace 内 .env 过挡、*.pem）
 *  - fs 三态：文件不存在 / 是目录 / 字节上限 50MB
 *  - 格式嗅探矩阵：png/jpeg/webp/gif/bmp/svg magic+扩展名双证通过；
 *    AVIF/HEIC 明确「暂不支持」；伪造魔数（.png 扩展名 + JPEG magic）拒；
 *    未知扩展名拒；.svg 内容无 <svg> 拒
 *  - 桥缝：place_image_from_bytes 调用参数（文件名/规范 MIME/base64/可选 id 透传）、
 *    桥结果 {error} 原样透传、桥抛错（连接级）→ 模型可见错误
 *
 * 测试纪律：禁读真实 env/真实 home（homeDir 注入）；tmp fixture 合成根
 * （rootDir/workspace 结构，migrate.test.ts 同款）；桥调用一律 mock。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createLoadImageTool,
  LOAD_IMAGE_MAX_BYTES,
  MIME_TO_EXT,
  sniffImageFormat
} from '@/app/ai/pi-backend/load-image'

import { bridgeStub as sharedBridgeStub, type BridgeStub } from './helpers'

// ── 真实 magic bytes 前缀（文件体其余部分随意——嗅探层只看 magic + 扩展名） ──
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 1, 2
])
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2])
const BMP_BYTES = new Uint8Array([0x42, 0x4d, 1, 2, 3])
const SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0h1v1H0z"/></svg>'

let rootDir = ''
let workspaceDir = ''

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'openpencil-load-image-'))
  workspaceDir = join(rootDir, 'workspace')
  mkdirSync(workspaceDir, { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

function ws(rel: string): string {
  return join(workspaceDir, rel)
}

function writeFixture(rel: string, bytes: Uint8Array | string): string {
  const path = ws(rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

/** 默认桥桩：记录调用 + 回成功结果；overrides 可换错误/抛错形态 */
function bridgeStub(
  overrides: Partial<{
    result: Record<string, unknown>
    throws: Error
  }> = {}
): BridgeStub {
  return sharedBridgeStub({ id: '1:2', width: 800, height: 600, imageHash: 'hash-x' }, overrides)
}

function makeTool(stub: BridgeStub) {
  return createLoadImageTool({
    rootDir,
    homeDir: join(rootDir, 'home'),
    callBridge: stub.callBridge
  })
}

async function details(
  tool: ReturnType<typeof makeTool>,
  params: Record<string, unknown>
): Promise<LoadImageDetails> {
  const result = await tool.execute('call-1', params)
  return result.details as LoadImageDetails
}

/** load_image 工具结果 details 形态（错误面 + 成功面并集，测试钉扎用） */
interface LoadImageDetails {
  error?: string
  reason?: 'denied'
  id?: string
  width?: number
  height?: number
  imageHash?: string | null
}

describe('路径判定（A线尾单件1：界内界外 allow + 名单硬拒）', () => {
  test('workspace 子树绝对路径 → allow（桥被调用）', async () => {
    const file = writeFixture('logo.png', PNG_BYTES)
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { file_path: file })
    expect(d.error).toBeUndefined()
    expect(d.id).toBe('1:2')
    expect(stub.calls).toHaveLength(1)
  })

  test('相对路径按 workspace cwd 解析 → allow', async () => {
    writeFixture('logo.png', PNG_BYTES)
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { file_path: 'logo.png' })
    expect(d.error).toBeUndefined()
    expect(stub.calls).toHaveLength(1)
  })

  test('workspace/.agents/** → allow（读侧翻正：写侧三根不拦读，文件照读过桥）', async () => {
    const file = writeFixture('.agents/skills/x/logo.png', PNG_BYTES)
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { file_path: file })
    expect(d.error).toBeUndefined()
    expect(stub.calls).toHaveLength(1)
  })

  test('workspace/.pi/** → allow（读侧不拦）', async () => {
    const file = writeFixture('.pi/settings.json.png', PNG_BYTES)
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { file_path: file })
    expect(d.error).toBeUndefined()
    expect(stub.calls).toHaveLength(1)
  })

  test('界外（rootDir 一级）真实 PNG → allow（界外静默放行，桥被调用）', async () => {
    const outside = join(rootDir, 'secret.png')
    writeFileSync(outside, PNG_BYTES)
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { file_path: outside })
    expect(d.error).toBeUndefined()
    expect(d.id).toBe('1:2')
    expect(stub.calls).toHaveLength(1)
  })

  test('盘外不存在路径 → 判定放行后 fs 层 File not found（非 denied）', async () => {
    const stub = bridgeStub()
    // 路径须在两平台皆不存在：/etc/hosts 在 Linux 是文件（子路径 ENOTDIR 而非
    // ENOENT，CI 63581160d 实证）——用唯一名空目录，Windows 归一到当前盘根同效
    const d = await details(makeTool(stub), { file_path: '/broker-tail-void-9f3e/logo.png' })
    expect(d.reason).toBeUndefined()
    expect(String(d.error)).toContain('File not found')
    expect(stub.calls).toHaveLength(0)
  })

  test('凭据五件（key-env / pi-backend-token / pi-agent/auth.json / image-gen.json / mcp-connections.json）→ deny（文件即使不存在也先拒）', async () => {
    const stub = bridgeStub()
    for (const target of [
      join(rootDir, 'key-env'),
      join(rootDir, 'pi-backend-token'),
      join(rootDir, 'pi-agent', 'auth.json'),
      join(rootDir, 'pi-agent', 'image-gen.json'),
      join(rootDir, 'pi-agent', 'mcp-connections.json')
    ]) {
      const d = await details(makeTool(stub), { file_path: target })
      expect(d.reason).toBe('denied')
      expect(String(d.error)).toContain('credentials/tokens')
    }
    expect(stub.calls).toHaveLength(0)
  })

  test('~/.ssh/** 与 ~/.aws/**（homeDir 注入假根）→ deny（sensitive 文案）', async () => {
    const stub = bridgeStub()
    for (const target of ['~/.ssh/id_rsa.png', '~/.aws/credentials.png']) {
      const d = await details(makeTool(stub), { file_path: target })
      expect(d.reason).toBe('denied')
      expect(String(d.error)).toContain('sensitive system or credential file')
    }
    expect(stub.calls).toHaveLength(0)
  })

  test('workspace 内 .env 与任意 *.pem → deny（fail-safe 过挡现状保留）', async () => {
    const stub = bridgeStub()
    for (const target of [ws('.env'), ws('cert.pem')]) {
      const d = await details(makeTool(stub), { file_path: target })
      expect(d.reason).toBe('denied')
      expect(String(d.error)).toContain('sensitive system or credential file')
    }
    expect(stub.calls).toHaveLength(0)
  })
})

describe('fs 三态与字节上限', () => {
  test('文件不存在 → File not found', async () => {
    const d = await details(makeTool(bridgeStub()), { file_path: ws('missing.png') })
    expect(String(d.error)).toContain('File not found')
  })

  test('是目录 → 明确文案', async () => {
    mkdirSync(ws('a-dir.png'), { recursive: true })
    const d = await details(makeTool(bridgeStub()), { file_path: ws('a-dir.png') })
    expect(String(d.error)).toContain('directory')
  })

  test('超 50MB → 字节上限拒绝（truncate 稀疏扩文件，免写真字节）', async () => {
    const file = writeFixture('big.png', PNG_BYTES)
    truncateSync(file, LOAD_IMAGE_MAX_BYTES + 1)
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { file_path: file })
    expect(String(d.error)).toContain('50MB')
    expect(stub.calls).toHaveLength(0)
  })
})

describe('格式嗅探矩阵', () => {
  test('五光栅 + SVG 双证通过（桥收到规范 MIME）', async () => {
    const cases: Array<{ name: string; bytes: Uint8Array | string; mime: string }> = [
      { name: 'a.png', bytes: PNG_BYTES, mime: 'image/png' },
      { name: 'b.jpg', bytes: JPEG_BYTES, mime: 'image/jpeg' },
      { name: 'c.jpeg', bytes: JPEG_BYTES, mime: 'image/jpeg' },
      { name: 'd.webp', bytes: WEBP_BYTES, mime: 'image/webp' },
      { name: 'e.gif', bytes: GIF_BYTES, mime: 'image/gif' },
      { name: 'f.bmp', bytes: BMP_BYTES, mime: 'image/bmp' },
      { name: 'g.svg', bytes: SVG_TEXT, mime: 'image/svg+xml' }
    ]
    for (const c of cases) {
      const file = writeFixture(c.name, c.bytes)
      const stub = bridgeStub()
      const d = await details(makeTool(stub), { file_path: file })
      expect(d.error).toBeUndefined()
      expect(stub.calls[0]?.args.mime).toBe(c.mime)
      expect(stub.calls[0]?.args.name).toBe(c.name)
    }
  })

  test('AVIF/HEIC 扩展名 → 「暂不支持」明确文案', async () => {
    const avif = writeFixture('photo.avif', PNG_BYTES)
    const d1 = await details(makeTool(bridgeStub()), { file_path: avif })
    expect(String(d1.error)).toContain('Unsupported format (avif)')
    expect(String(d1.error)).toContain('PNG/JPEG/WEBP')

    const heic = writeFixture('photo.heic', PNG_BYTES)
    const d2 = await details(makeTool(bridgeStub()), { file_path: heic })
    expect(String(d2.error)).toContain('Unsupported format (heic)')
  })

  test('伪造魔数（.png 扩展名 + JPEG magic）→ 损坏/无效文案，不过桥', async () => {
    const file = writeFixture('fake.png', JPEG_BYTES)
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { file_path: file })
    expect(String(d.error)).toContain('corrupted or not a valid image')
    expect(stub.calls).toHaveLength(0)
  })

  test('未知扩展名 → 不支持（unknown/扩展名入文案）', async () => {
    const file = writeFixture('note.txt', PNG_BYTES)
    const d = await details(makeTool(bridgeStub()), { file_path: file })
    expect(String(d.error)).toContain('Unsupported format (txt)')
  })

  test('.svg 扩展名但内容无 <svg> → 损坏/无效', async () => {
    const file = writeFixture('bad.svg', 'not an svg at all')
    const d = await details(makeTool(bridgeStub()), { file_path: file })
    expect(String(d.error)).toContain('corrupted or not a valid image')
  })

  test('SVG 带 prolog/DOCTYPE/注释前缀仍可嗅探通过', () => {
    const text = '<?xml version="1.0"?>\n<!DOCTYPE svg>\n<!-- c -->\n' + SVG_TEXT
    const sniffed = sniffImageFormat(new TextEncoder().encode(text), 'icon.svg')
    expect(sniffed.ok).toBe(true)
  })
})

describe('桥缝', () => {
  test('调用参数：文件名 + 规范 MIME + base64 字节 + 可选 id/坐标透传', async () => {
    const file = writeFixture('logo.png', PNG_BYTES)
    const stub = bridgeStub()
    await details(makeTool(stub), {
      file_path: file,
      replace_id: '9:1',
      parent_id: '9:2',
      x: 10,
      y: 20
    })
    expect(stub.calls[0]?.tool).toBe('place_image_from_bytes')
    const args = stub.calls[0]?.args ?? {}
    expect(args.name).toBe('logo.png')
    expect(args.mime).toBe('image/png')
    expect(args.replace_id).toBe('9:1')
    expect(args.parent_id).toBe('9:2')
    expect(args.x).toBe(10)
    expect(args.y).toBe(20)
    // base64 解码回原字节（字节面正确性）
    expect(Buffer.from(String(args.image_data), 'base64')).toEqual(Buffer.from(PNG_BYTES))
  })

  test('桥结果 {error}（如像素超限）原样透传', async () => {
    const file = writeFixture('logo.png', PNG_BYTES)
    const stub = bridgeStub({
      result: { error: 'Image too large (9000x8000). Downscale below 64MP first.' }
    })
    const d = await details(makeTool(stub), { file_path: file })
    expect(String(d.error)).toContain('64MP')
  })

  test('桥抛错（连接级）→ 模型可见错误文案（bridge-errors 分类后消息）', async () => {
    const file = writeFixture('logo.png', PNG_BYTES)
    const stub = bridgeStub({
      throws: new Error('Editor is not reachable — make sure the Dianjing Studio app is open')
    })
    const d = await details(makeTool(stub), { file_path: file })
    expect(String(d.error)).toContain('Editor is not reachable')
  })

  test('成功结果（id/width/height/imageHash）原样透传', async () => {
    const file = writeFixture('logo.png', PNG_BYTES)
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { file_path: file })
    expect(d).toMatchObject({ id: '1:2', width: 800, height: 600, imageHash: 'hash-x' })
  })
})

// ── URL 分支（file_path / url 互斥 + fetch 路径） ──
//
// 2026-09-26 load_image 增 URL 支持（fetch-image-url.ts）：globalThis.fetch
// 走真实网络不可控，URL 分支测试用假主机 *.example.test + 注入桩模拟
// 响应。还原钩子写在本测试文件自身（bun 模块缓存令共享 helpers 的模块
// 级 afterEach 只在首个 import 者生效——2026-09-17 app shard 40 红实证，
// 本文件自管最稳）。

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('URL 分支', () => {
  /** 一字节 PNG 响应（带 Content-Type），生产路径走 globalThis.fetch */
  function pngResponse(): Response {
    return new Response(Buffer.from(PNG_BYTES), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })
  }

  test('url 参数接线：globalThis.fetch 桩返回 PNG → 桥收到正确 base64/mime/name', async () => {
    let fetchCalls = 0
    globalThis.fetch = (async (input: unknown) => {
      fetchCalls++
      // fetch 接 string/URL/Request 三种入参——抽字符串 URL
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : String((input as Request).url ?? input)
      expect(url).toBe('https://cdn.example.test/photo.png')
      return pngResponse()
    }) as typeof fetch

    const stub = bridgeStub()
    const d = await details(makeTool(stub), { url: 'https://cdn.example.test/photo.png' })
    expect(d.error).toBeUndefined()
    expect(fetchCalls).toBe(1)
    expect(stub.calls).toHaveLength(1)
    expect(stub.calls[0]?.args.name).toBe('photo.png')
    expect(stub.calls[0]?.args.mime).toBe('image/png')
    expect(Buffer.from(String(stub.calls[0]?.args.image_data), 'base64')).toEqual(
      Buffer.from(PNG_BYTES)
    )
  })

  test('file_path 与 url 双给 → 互斥拒绝', async () => {
    const file = writeFixture('logo.png', PNG_BYTES)
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { file_path: file, url: 'https://x.test/y.png' })
    expect(String(d.error)).toContain('Provide exactly one')
    expect(stub.calls).toHaveLength(0)
  })

  test('file_path 与 url 双缺 → 互斥拒绝', async () => {
    const stub = bridgeStub()
    const d = await details(makeTool(stub), {})
    expect(String(d.error)).toContain('Provide exactly one')
    expect(stub.calls).toHaveLength(0)
  })

  test('无扩展名 URL + Content-Type 声称 → 桥收到正确 mime（MIME_TO_EXT 命中）', async () => {
    globalThis.fetch = (async () => pngResponse()) as typeof fetch
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { url: 'https://cdn.example.test/photo' })
    expect(d.error).toBeUndefined()
    expect(stub.calls[0]?.args.name).toBe('photo')
    expect(stub.calls[0]?.args.mime).toBe('image/png')
  })

  test('Content-Type 非标（MIME_TO_EXT 未命中）→ 退 fileName 扩展名 sniff', async () => {
    // server 返回非标 MIME（如 image/x-foo），但 URL 路径有 .png 扩展名——fall back
    globalThis.fetch = (async () =>
      new Response(Buffer.from(PNG_BYTES), {
        status: 200,
        headers: { 'content-type': 'image/x-foo' }
      })) as typeof fetch
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { url: 'https://cdn.example.test/icon.png' })
    expect(d.error).toBeUndefined()
    expect(stub.calls[0]?.args.mime).toBe('image/png')
  })

  test('SSRF URL（localhost）→ error 且 fetch 未被调用', async () => {
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return pngResponse()
    }) as typeof fetch
    const stub = bridgeStub()
    const d = await details(makeTool(stub), { url: 'http://localhost/x.png' })
    expect(String(d.error)).toContain('loopback, link-local or private network')
    expect(fetchCalls).toBe(0)
    expect(stub.calls).toHaveLength(0)
  })
})
