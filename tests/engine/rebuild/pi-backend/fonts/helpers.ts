/**
 * pi-backend 字体商店测试共享 helper——三段：
 *
 * 一、node:http 桩（FakeReq/FakeRes）：路由层 handler 测试用。FakeReq = 最小
 *     listener 注册表 + 必要 IncomingMessage 字段；FakeRes 累计
 *     statusCode/headers/body，无 socket 写入——handler 经 writeHead/end
 *     触发时由本桩记录结果。
 * 二、fake 字体商店服务器（bind 0 端口，OS 分配）：catalog / install / broken /
 *     catalog-500 / huge-catalog / cn-install(-cancel/-broken-piece) 模式；
 *     片字节复用 tests/fixtures/fonts/NotoSansCJK-Test.otf（OTF 容器，内容嗅探
 *     走 OTF 分支不调转码）。
 * 三、商店路由 helper：postJSON 请求桩对 + 响应体 unknown 入口解析（谓词收窄 /
 *     字段提取抛错——shape 不符即测试失败，不靠类型断言掩盖）。
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Readable } from 'node:stream'

import { isJSONObject } from '#tests/helpers/json'
import { repoPath } from '#tests/helpers/paths'

// ── node:http 桩 ─────────────────────────────────────────────────────────

/** 桩对象 → 目标接口的单点断言出口（桩与真实接口无结构重叠，集中在此转型） */
function castStub<T>(value: unknown): T {
  return value as T
}

interface FakeReqInit {
  method?: string
  url?: string
  headers?: Record<string, string>
  chunks?: Buffer[]
}

/** 最小 listener 注册表（只实现 handler 消费到的 on/emit 两方法） */
class FakeReqEvents {
  private readonly listeners = new Map<string, Array<(arg?: unknown) => void>>()

  on(event: string, listener: (arg?: unknown) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, arg?: unknown): boolean {
    const list = this.listeners.get(event)
    if (!list) return false
    for (const listener of list) listener(arg)
    return true
  }
}

export function makeFakeReq(init: FakeReqInit = {}): IncomingMessage {
  const events = new FakeReqEvents()
  const req = castStub<IncomingMessage>(events)
  // IncomingMessage 字段
  Object.defineProperty(req, 'method', { value: init.method ?? 'GET' })
  Object.defineProperty(req, 'url', { value: init.url ?? '/' })
  Object.defineProperty(req, 'headers', {
    value: init.headers ?? {}
  })
  // 模拟 body：让 handler 直接当 chunk 一次性 push 完——push chunks 后 emit end
  const chunks = init.chunks ?? []
  queueMicrotask(() => {
    for (const chunk of chunks) events.emit('data', chunk)
    events.emit('end')
  })
  // destroyed 字段（部分 handler 会读）
  ;(req as { destroyed?: boolean }).destroyed = false
  return req
}

interface FakeResShape {
  statusCode: number | undefined
  body: string
  headers: Record<string, string | number | string[] | undefined>
  _headersSent: boolean
  _finished: boolean
  writableEnded: boolean
  on(event: string, listener: (...args: unknown[]) => void): FakeResShape
  once(event: string, listener: (...args: unknown[]) => void): FakeResShape
  emit(): boolean
  removeListener(): FakeResShape
  setHeader(name: string, value: string | number | string[]): void
  getHeader(name: string): string | number | string[] | undefined
  hasHeader(name: string): boolean
  removeHeader(name: string): void
  writeHead(statusCode: number, headers?: Record<string, string | number | string[]>): void
  write(chunk: string | Buffer | Uint8Array): boolean
  end(chunk?: string | Buffer | Uint8Array): void
  destroy(): void
  pipe<T extends Readable>(): T
}

export interface FakeRes extends ServerResponse {
  statusCode: number | undefined
  body: string
}

export function makeFakeRes(): FakeRes {
  const res: FakeResShape = {
    statusCode: undefined,
    body: '',
    headers: {},
    _headersSent: false,
    _finished: false,
    writableEnded: false,
    on(event, listener) {
      if (event === 'finish' || event === 'error' || event === 'close') {
        // 兜底：finish/error 事件挂空 listener 即可
        void listener
      }
      return this
    },
    once(event, listener) {
      return this.on(event, listener)
    },
    emit() {
      return true
    },
    removeListener() {
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    getHeader(name) {
      return this.headers[name]
    },
    hasHeader(name) {
      return name in this.headers
    },
    removeHeader(name) {
      Reflect.deleteProperty(this.headers, name)
    },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this._headersSent = true
      if (headers) Object.assign(this.headers, headers)
    },
    write(chunk) {
      this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    },
    end(chunk) {
      if (chunk !== undefined) {
        this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      }
      this._finished = true
      this.writableEnded = true
    },
    destroy() {
      this._finished = true
    },
    pipe<T extends Readable>(): T {
      return castStub<T>(this)
    }
  }
  return castStub<FakeRes>(res)
}

// ── fake 字体商店服务器 ──────────────────────────────────────────────────

export type FakeFontServerMode =
  | 'catalog'
  | 'install'
  | 'broken'
  | 'catalog-500'
  | 'huge-catalog'
  | 'cn-install'
  | 'cn-install-cancel'
  | 'cn-install-broken-piece'

export interface FakeFontServer {
  baseURL: string
  close(): Promise<void>
}

interface StartOpts {
  mode: FakeFontServerMode
  /** install 模式：单族每个 style 拉取前先 sleep（用于 cancel 测试） */
  delayMs?: number
  /** cn-install 模式：单片拉取前先 sleep（用于 cancel 测试） */
  pieceDelayMs?: number
}

const CATALOG_TEMPLATE = {
  families: [
    {
      family: 'Noto Sans CJK Test',
      displayName: 'Noto Sans CJK Test',
      license: 'OFL-1.1',
      version: '1.0',
      styles: [
        {
          style: 'Regular',
          weight: 400,
          italic: false,
          fileURL: '/fonts/NotoSansCJK-Test.otf',
          format: 'otf' as const
        }
      ]
    },
    {
      family: 'Secondary Family',
      styles: [
        {
          style: 'Regular',
          weight: 400,
          italic: false,
          fileURL: '/fonts/NotoSansCJK-Test.otf',
          format: 'otf' as const
        }
      ]
    }
  ]
}

const BROKEN_CATALOG_TEMPLATE = {
  families: [
    {
      family: 'Garbage Font',
      styles: [
        {
          style: 'Regular',
          weight: 400,
          italic: false,
          fileURL: '/fonts/garbage.bin',
          format: 'otf' as const
        }
      ]
    }
  ]
}

/** 给定 baseURL，把模板里的相对 fileURL 拼成绝对 URL（拷贝，不改原模板） */
function buildCatalog(template: typeof CATALOG_TEMPLATE, baseURL: string): typeof CATALOG_TEMPLATE {
  return {
    families: template.families.map((family) => ({
      ...family,
      styles: family.styles.map((style) => ({
        ...style,
        fileURL: `${baseURL}${style.fileURL}`
      }))
    }))
  }
}

const FIXTURE_PATH = repoPath('tests/fixtures/fonts/NotoSansCJK-Test.otf')

/** cn-install 模式：使用 registry 内真实存在的非 VF 族（LXGW WenKai），
 *  package='@chinese-fonts/lxgwwenkai'，weights=['Light','Regular','Medium']。
 * 测试选 Regular 一条 style 装入；fake 路径前缀 '/<pkg>@<ver>/' 与 cn-fonts
 * 安装管线 baseURL='' 拼出的路径完全一致。 */
const CN_PACKAGE = '@chinese-fonts/lxgwwenkai'
const CN_VERSION = 'latest'
const CN_DIR = 'LXGWWenKai-Regular'
const CN_PIECE_HASHES = ['aaaa1111aaaa1111aaaa1111aaaa1111', 'bbbb2222bbbb2222bbbb2222bbbb2222']

function cnResultCSS(dir: string, weight: number, hashes: string[]): string {
  // 每片一条 @font-face，unicode-range 覆盖 U+4E00-4FFF（基本汉字 A 区）。
  // selectCnFontPieces 对"中"字（U+4E2D）命中——0x4E2D ∈ [0x4E00, 0x4FFF]。
  return `@font-face {
  font-family: '${dir}';
  font-weight: ${weight};
  font-style: normal;
  src: url('./${hashes[0]}.woff2') format('woff2');
  unicode-range: U+4E00-4E7F;
}
@font-face {
  font-family: '${dir}';
  font-weight: ${weight};
  font-style: normal;
  src: url('./${hashes[1]}.woff2') format('woff2');
  unicode-range: U+4E80-4FFF;
}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isCnMode(mode: FakeFontServerMode): boolean {
  return mode === 'cn-install' || mode === 'cn-install-cancel' || mode === 'cn-install-broken-piece'
}

/** GET /catalog.json 分支 */
function handleCatalog(opts: StartOpts, baseURL: string, res: ServerResponse): void {
  if (opts.mode === 'catalog-500') {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'upstream boom' }))
    return
  }
  if (opts.mode === 'huge-catalog') {
    // 9MB JSON——触发端点侧 8MB 上限（流式截断）
    const pad = 'x'.repeat(9 * 1024 * 1024)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(`{"families":[],"pad":"${pad}"}`)
    return
  }
  const template = opts.mode === 'broken' ? BROKEN_CATALOG_TEMPLATE : CATALOG_TEMPLATE
  const payload = buildCatalog(template, baseURL)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** GET /fonts/* 分支 */
async function handleFontFile(
  opts: StartOpts,
  loadFixture: () => Buffer,
  res: ServerResponse
): Promise<void> {
  if (opts.delayMs && opts.delayMs > 0) {
    await sleep(opts.delayMs)
  }
  if (opts.mode === 'broken') {
    // 垃圾字节：4 字节非字体魔数 → validateFontBytes 应拒
    res.writeHead(200, { 'content-type': 'font/otf' })
    res.end(Buffer.from([0xde, 0xad, 0xbe, 0xef]))
    return
  }
  try {
    const bytes = loadFixture()
    res.writeHead(200, {
      'content-type': 'font/otf',
      'content-length': String(bytes.byteLength)
    })
    res.end(bytes)
  } catch (error) {
    res.writeHead(500).end((error as Error).message)
  }
}

/** cn 包路径分支：片文件请求（/dist/{dir}/{hash}.woff2） */
async function handleCnPiece(
  opts: StartOpts,
  loadFixture: () => Buffer,
  res: ServerResponse
): Promise<void> {
  if (opts.pieceDelayMs && opts.pieceDelayMs > 0) {
    await sleep(opts.pieceDelayMs)
  }
  if (opts.mode === 'cn-install-broken-piece') {
    // 故意返回 4 字节非字体魔数（仅首个片触发即可）
    res.writeHead(200, { 'content-type': 'font/woff2' })
    res.end(Buffer.from([0xde, 0xad, 0xbe, 0xef]))
    return
  }
  // 复用 OTF fixture——内容嗅探 detectContainer 走 OTF 分支不调转码
  const bytes = loadFixture()
  res.writeHead(200, {
    'content-type': 'font/woff2',
    'content-length': String(bytes.byteLength)
  })
  res.end(bytes)
}

/** cn 包路径分支整体。命中处理返 true；未命中返 false（调用方兜 404） */
async function handleCnPackage(
  opts: StartOpts,
  loadFixture: () => Buffer,
  url: string,
  res: ServerResponse
): Promise<boolean> {
  // 路径形如 /<pkg>@<ver>/dist/index.json（baseURL=''）
  // 或 /npm/<pkg>@<ver>/dist/index.json（baseURL='/npm'）
  const cnPrefixes = [`/npm/${CN_PACKAGE}@${CN_VERSION}/`, `/${CN_PACKAGE}@${CN_VERSION}/`]
  for (const cnPrefix of cnPrefixes) {
    if (!url.startsWith(cnPrefix)) continue
    const sub = url.slice(cnPrefix.length)
    if (sub === 'dist/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([`${CN_DIR}-Regular`, `${CN_DIR}-Bold`]))
      return true
    }
    if (sub === `dist/${CN_DIR}-Regular/result.css`) {
      res.writeHead(200, { 'content-type': 'text/css' })
      res.end(cnResultCSS(`${CN_DIR}-Regular`, 400, CN_PIECE_HASHES))
      return true
    }
    if (sub === `dist/${CN_DIR}-Bold/result.css`) {
      res.writeHead(200, { 'content-type': 'text/css' })
      res.end(cnResultCSS(`${CN_DIR}-Bold`, 700, CN_PIECE_HASHES))
      return true
    }
    const pieceMatch = sub.match(/^dist\/.+\/([0-9a-f]{32})\.woff2$/)
    if (pieceMatch) {
      await handleCnPiece(opts, loadFixture, res)
      return true
    }
    res.writeHead(404).end('not found in cn package')
    return true
  }
  return false
}

export async function startFakeFontServer(opts: StartOpts): Promise<FakeFontServer> {
  let resolvedBaseURL = ''
  let fixtureBytes: Buffer | null = null
  function loadFixture(): Buffer {
    if (fixtureBytes === null) {
      fixtureBytes = readFileSync(FIXTURE_PATH)
    }
    return fixtureBytes
  }
  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'
    if (url === '/catalog.json') {
      handleCatalog(opts, resolvedBaseURL, res)
      return
    }
    if (url.startsWith('/fonts/')) {
      await handleFontFile(opts, loadFixture, res)
      return
    }
    // cn-install 模式：模拟 npm 包路径（cn-fonts 安装管线
    // baseURL='' 时拼 /<pkg>@<ver>/dist/...；测试用 baseURL='http://host/npm'
    // 拼 /npm/<pkg>@<ver>/dist/...。两种都用 cnPrefix 兼容）
    if (isCnMode(opts.mode) && (await handleCnPackage(opts, loadFixture, url, res))) {
      return
    }
    res.writeHead(404).end('not found')
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  resolvedBaseURL = `http://127.0.0.1:${address.port}`
  return {
    baseURL: resolvedBaseURL,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
  }
}

// 公开 cn 包元信息——测试断言用
export const CN_FAKE_PACKAGE = CN_PACKAGE
export const CN_FAKE_VERSION = CN_VERSION
export const CN_FAKE_DIR = CN_DIR
export const CN_FAKE_PIECE_HASHES = CN_PIECE_HASHES

// ── 商店路由 helper ──────────────────────────────────────────────────────

/** POST JSON 请求桩对（body 序列化进 chunks） */
export function postJSON(path: string, body: unknown): { req: IncomingMessage; res: FakeRes } {
  const req = makeFakeReq({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json' },
    chunks: [Buffer.from(JSON.stringify(body))]
  })
  const res = makeFakeRes()
  return { req, res }
}

/** 解析 FakeRes 累计 body 为 unknown——收窄归调用方 */
export function parseFakeBody(res: FakeRes): unknown {
  const parsed: unknown = JSON.parse(res.body)
  return parsed
}

/** install 响应体 → taskId 字符串 */
export function bodyTaskId(body: unknown): string {
  if (!isJSONObject(body) || typeof body.taskId !== 'string') {
    throw new Error('install response missing taskId')
  }
  return body.taskId
}

/** 注册服务响应体 → service.id 字符串 */
export function bodyServiceId(body: unknown): string {
  if (!isJSONObject(body) || !isJSONObject(body.service) || typeof body.service.id !== 'string') {
    throw new Error('register response missing service.id')
  }
  return body.service.id
}

/** 列表响应体 → services 数组（非对象元素滤除——后续断言兜住缺失） */
export function bodyServices(body: unknown): Array<Record<string, unknown>> {
  if (!isJSONObject(body) || !Array.isArray(body.services)) {
    throw new Error('list response missing services array')
  }
  return body.services.filter(isJSONObject)
}
