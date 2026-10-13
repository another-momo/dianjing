/**
 * 字体商店 HTTP 路由（pi-backend 侧）。
 *
 * 端点组：
 *  - GET    /api/pi/fonts/store/services          → 内置 + 自定义合并清单
 *  - POST   /api/pi/fonts/store/services         body { name, baseURL, kind, apiKey? }
 *  - POST   /api/pi/fonts/store/services/delete  body { id }   （内置 id → 400）
 *  - GET    /api/pi/fonts/store/catalog?service= → server-side fetch + 适配器分派
 *  - POST   /api/pi/fonts/store/install          body { service, family, styles?: string[] }
 *  - GET    /api/pi/fonts/store/tasks            → 任务列表
 *  - POST   /api/pi/fonts/store/tasks/cancel     body { taskId }
 *
 * 出网政策（owner 已拍板）：不强制 https、不封内网段；安全兜底 = 大小上限 +
 * 超时 + 完整校验链（魔数 + 大小 + opentype parse + VF 嗅探 + name 表）。
 *
 * 分片集合形态（cn-fonts）：单 style 内多片并发 4；任务 total = style 数；
 * 任一 style 任一片失败 → 该 style 整条进 failures；manifest 写入仅在全部
 * style 收口后。
 * 取消信号贯穿 fetch/transcode/validate；已落盘片无 manifest 登记即不可见。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'

import type { StyleEntry } from '@open-pencil/core/text/font/installed/manifest'
import { validateFontBytes } from '@open-pencil/core/text/font/installed/validate'
import { transcodeWoff2ToSfnt } from '@open-pencil/core/text/font/installed/woff2'
import {
  adapterForService,
  BUILTIN_STORE_PRESETS,
  FONTSOURCE_PRESET_ID,
  mergeServices
} from '@open-pencil/core/text/font/store/registry'
import type {
  FetchLike,
  StoreCatalogFamily,
  StoreServiceDescriptor
} from '@open-pencil/core/text/font/store/types'

import { scheduleSubsetInstall } from './cn-install'
import { mapRejectionToText, readJSONBody, sendJSON } from './http-helpers'
import {
  createCustomServicesStore,
  normalizeRegisterInput,
  slugifyServiceName,
  type CustomServicesStore
} from './services-store'
import { type FontsStore } from './store'
import type { StoreTaskRegistry } from './store-tasks'
import { composeSignals, fetchStyleBytes, isAborted } from './stream-helpers'

const SERVICES_LIST_PATH = '/api/pi/fonts/store/services'
const SERVICES_REGISTER_PATH = '/api/pi/fonts/store/services'
const SERVICES_DELETE_PATH = '/api/pi/fonts/store/services/delete'
const CATALOG_PATH = '/api/pi/fonts/store/catalog'
const INSTALL_PATH = '/api/pi/fonts/store/install'
const TASKS_LIST_PATH = '/api/pi/fonts/store/tasks'
const TASKS_CANCEL_PATH = '/api/pi/fonts/store/tasks/cancel'

/** 目录拉取单次上限（防止适配器把响应流无限读入） */
const CATALOG_MAX_BYTES = 8 * 1024 * 1024
/** 单 style 字节拉取上限——超 60MB 直接拒（与 install 端点保持一致） */
const STYLE_FETCH_MAX_BYTES = 60 * 1024 * 1024
/** 目录拉取整体超时 */
const CATALOG_TIMEOUT_MS = 60_000
/** 单 style 拉取超时 */
const STYLE_FETCH_TIMEOUT_MS = 30_000

const STORE_PATH_PREFIXES = [
  SERVICES_LIST_PATH,
  SERVICES_REGISTER_PATH,
  SERVICES_DELETE_PATH,
  CATALOG_PATH,
  INSTALL_PATH,
  TASKS_LIST_PATH,
  TASKS_CANCEL_PATH
]

export interface StoreRouteDeps {
  store: FontsStore
  rootDir: string
  /** 任务表——内存态，必须由调用方持有跨请求共享（server.ts 服务器级单例） */
  tasks: StoreTaskRegistry
  /** 服务持久化——可注入便于单测隔离 */
  customServices?: CustomServicesStore
}

export async function handleFontsStoreRequest(
  deps: StoreRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!STORE_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}?`))) {
    return false
  }
  try {
    if (pathname === SERVICES_LIST_PATH && req.method === 'GET') {
      return await handleListServices(deps, res)
    }
    if (pathname === SERVICES_REGISTER_PATH && req.method === 'POST') {
      return await handleRegisterService(deps, req, res)
    }
    if (pathname === SERVICES_DELETE_PATH && req.method === 'POST') {
      return await handleDeleteService(deps, req, res)
    }
    if (pathname === CATALOG_PATH && req.method === 'GET') {
      return await handleCatalog(deps, req, res)
    }
    if (pathname === INSTALL_PATH && req.method === 'POST') {
      return await handleInstall(deps, req, res)
    }
    if (pathname === TASKS_LIST_PATH && req.method === 'GET') {
      return await handleListTasks(deps, res)
    }
    if (pathname === TASKS_CANCEL_PATH && req.method === 'POST') {
      return await handleCancelTask(deps, req, res)
    }
    sendJSON(res, 405, { error: 'method not allowed' })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJSON(res, 500, { error: message })
    return true
  }
}

// ── 共享 helper ──────────────────────────────────────────────────────

function getCustomServices(deps: StoreRouteDeps): CustomServicesStore {
  return deps.customServices ?? createCustomServicesStore({ rootDir: deps.rootDir })
}

function buildMergedList(custom: StoreServiceDescriptor[]): StoreServiceDescriptor[] {
  return mergeServices(BUILTIN_STORE_PRESETS, custom)
}

function findService(deps: StoreRouteDeps, serviceId: string): StoreServiceDescriptor | null {
  const all = buildMergedList(getCustomServices(deps).read())
  return all.find((s) => s.id === serviceId) ?? null
}

/** composeSignals/isAborted/fetchStyleBytes 来自 ./stream-helpers（owner：单文件 ≤ 600 行） */

// ── 端点实现 ─────────────────────────────────────────────────────────

async function handleListServices(deps: StoreRouteDeps, res: ServerResponse): Promise<boolean> {
  const services = buildMergedList(getCustomServices(deps).read())
  sendJSON(res, 200, { services })
  return true
}

async function handleRegisterService(
  deps: StoreRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const parsed = await readJSONBody(req)
  if (!parsed.ok) {
    sendJSON(res, 400, { error: parsed.error })
    return true
  }
  const input = normalizeRegisterInput(parsed.body)
  if (!input) {
    sendJSON(res, 400, {
      error: 'invalid service input: name, baseURL (http/https), kind (standard|gf-api) required',
      code: 'bad-input'
    })
    return true
  }
  const custom = getCustomServices(deps)
  let id = slugifyServiceName(input.name)
  // 撞车加 -2 后缀——保持稳定 id 派生规则
  const existingIds = new Set(custom.read().map((s) => s.id))
  if (existingIds.has(id)) id = `${id}-2`
  const service: StoreServiceDescriptor = {
    id,
    name: input.name,
    kind: input.kind,
    baseURL: input.baseURL,
    builtin: false
  }
  if (input.apiKey) service.apiKey = input.apiKey
  custom.add(service)
  sendJSON(res, 200, { ok: true, service })
  return true
}

async function handleDeleteService(
  deps: StoreRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const parsed = await readJSONBody(req)
  if (!parsed.ok) {
    sendJSON(res, 400, { error: parsed.error })
    return true
  }
  const r = parsed.body as { id?: unknown }
  if (typeof r.id !== 'string' || r.id.length === 0) {
    sendJSON(res, 400, { error: 'id required', code: 'missing-id' })
    return true
  }
  if (r.id.startsWith('preset:') || r.id === FONTSOURCE_PRESET_ID) {
    sendJSON(res, 400, { error: 'built-in services cannot be deleted', code: 'builtin' })
    return true
  }
  const custom = getCustomServices(deps)
  const before = custom.read()
  if (!before.some((s) => s.id === r.id)) {
    sendJSON(res, 404, { error: `service not found: ${r.id}`, code: 'not-found' })
    return true
  }
  custom.remove(r.id)
  // 服务已删，其名下 running 安装任务继续跑会落成「幽灵来源」字体——主动取消
  for (const task of deps.tasks.list()) {
    if (task.serviceId === r.id && task.status === 'running') deps.tasks.cancel(task.id)
  }
  sendJSON(res, 200, { ok: true, id: r.id })
  return true
}

async function handleCatalog(
  deps: StoreRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const serviceId = url.searchParams.get('service')
  if (!serviceId) {
    sendJSON(res, 400, { error: 'service query param required', code: 'missing-service' })
    return true
  }
  const service = findService(deps, serviceId)
  if (!service) {
    sendJSON(res, 404, { error: `service not found: ${serviceId}`, code: 'not-found' })
    return true
  }
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('catalog fetch timeout')),
    CATALOG_TIMEOUT_MS
  )
  try {
    const fetchImpl = makeBoundedFetchLike(controller.signal, CATALOG_MAX_BYTES)
    const adapter = adapterForService(service)
    const families = await adapter.fetchCatalog(fetchImpl)
    sendJSON(res, 200, { families, serviceId })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJSON(res, 502, { error: message, code: 'catalog-fetch-failed' })
    return true
  } finally {
    clearTimeout(timer)
  }
}

async function handleInstall(
  deps: StoreRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const parsed = await readJSONBody(req)
  if (!parsed.ok) {
    sendJSON(res, 400, { error: parsed.error })
    return true
  }
  const r = parsed.body as {
    service?: unknown
    family?: unknown
    styles?: unknown
    piecesBaseURL?: unknown
  }
  if (typeof r.service !== 'string' || r.service.length === 0) {
    sendJSON(res, 400, { error: 'service required', code: 'missing-service' })
    return true
  }
  if (typeof r.family !== 'string' || r.family.length === 0) {
    sendJSON(res, 400, { error: 'family required', code: 'missing-family' })
    return true
  }
  const service = findService(deps, r.service)
  if (!service) {
    sendJSON(res, 404, { error: `service not found: ${r.service}`, code: 'not-found' })
    return true
  }
  // 测试用 baseURL 覆盖（piecesRef descriptor 缺 baseURL 时拼出 //pkg@ver 非法 URL；
  // 真实端点用 service 内置的 baseURL 派生，测试 / 自定义场景可由本字段覆盖）
  let piecesBaseURL: string | null | undefined
  if (r.piecesBaseURL !== undefined) {
    piecesBaseURL = extractPiecesBaseURL(r)
    if (piecesBaseURL === null) {
      sendJSON(res, 400, {
        error: 'piecesBaseURL is not a valid http(s) URL',
        code: 'bad-base-url'
      })
      return true
    }
  }
  const stylesFilter = Array.isArray(r.styles)
    ? r.styles.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : null

  // 拉目录（任务启动前先验 family 存在）—— 单次上限 + 超时
  const catalogController = new AbortController()
  const catalogTimer = setTimeout(
    () => catalogController.abort(new Error('catalog fetch timeout')),
    CATALOG_TIMEOUT_MS
  )
  let families: StoreCatalogFamily[]
  try {
    const fetchImpl = makeBoundedFetchLike(catalogController.signal, CATALOG_MAX_BYTES)
    families = await adapterForService(service).fetchCatalog(fetchImpl)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJSON(res, 502, { error: message, code: 'catalog-fetch-failed' })
    return true
  } finally {
    clearTimeout(catalogTimer)
  }
  const catalogFamily = families.find((f) => f.family === r.family)
  if (!catalogFamily) {
    sendJSON(res, 404, { error: `family not found: ${r.family}`, code: 'family-not-found' })
    return true
  }
  const selectedStyles =
    stylesFilter === null
      ? catalogFamily.styles
      : catalogFamily.styles.filter((s) => stylesFilter.includes(s.style))
  if (selectedStyles.length === 0) {
    sendJSON(res, 400, { error: 'no matching styles', code: 'no-styles' })
    return true
  }

  // 分片集合形态（cn-fonts）：单 style 是一条 (weight, italic) 集合，整体装
  // 由 installSubsetFamily 串行管；任务 total = 全部 style 合计片数
  if (selectedStyles.every((s) => s.piecesRef !== undefined)) {
    // 测试 / 自定义场景可由 piecesBaseURL 覆盖（避免空 baseURL 拼出 // 非法 URL）
    const stylesWithBase = piecesBaseURL
      ? selectedStyles.map((s) => ({
          ...s,
          piecesRef: s.piecesRef ? { ...s.piecesRef, baseURL: piecesBaseURL } : s.piecesRef
        }))
      : selectedStyles
    return scheduleSubsetInstall(deps, res, service, catalogFamily, stylesWithBase)
  }
  if (selectedStyles.some((s) => s.piecesRef !== undefined)) {
    // 混态不该出现——适配器层保证 kind 决定整族形态；硬拒
    sendJSON(res, 400, {
      error: 'mixed piece/file styles in the same family are not supported',
      code: 'mixed-artifact'
    })
    return true
  }

  const tasks = deps.tasks
  // 并发上限：同刻最多 8 个安装任务（单任务占内存随族样式数线性，防滥用塞爆）
  if (tasks.countRunning() >= 8) {
    sendJSON(res, 429, { error: 'too many running install tasks', code: 'busy' })
    return true
  }
  const { task, shortCircuited } = tasks.start({
    serviceId: service.id,
    family: catalogFamily.family,
    total: selectedStyles.length,
    worker: async (signal, taskRef) => {
      // 跨请求混态守卫：上轮若以分片集合形态装过同族（manifest 该族含
      // subset-collection 项），本轮 full 写入会与旧片/旧 index.json 混杂。
      // 在首个 style 落盘前 deleteFamily 清旧族——一次请求只清一次。
      const priorManifest = deps.store.readManifest()
      const priorFamily = priorManifest.families.find((f) => f.family === catalogFamily.family)
      if (priorFamily?.styles.some((s) => s.artifact === 'subset-collection')) {
        deps.store.deleteFamily(catalogFamily.family)
      }
      for (const style of selectedStyles) {
        if (signal.aborted) return
        try {
          await installOneStyle(deps, catalogFamily, style, signal)
        } catch (error) {
          if (isAborted(signal)) return
          taskRef.failures.push({
            style: style.style,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
        taskRef.done++
      }
    }
  })
  sendJSON(res, 200, { ok: true, taskId: task.id, shortCircuited })
  return true
}

/**
 * scheduleSubsetInstall 来自 ./cn-install（owner 指令：单文件 ≤ 600 行）
 */

async function installOneStyle(
  deps: StoreRouteDeps,
  family: StoreCatalogFamily,
  style: (typeof family.styles)[number],
  signal: AbortSignal
): Promise<void> {
  // 单 style 拉取：超时 + 大小上限（流式读，> 60MB 即拒）
  const rawBytes = await fetchStyleBytes(
    style.fileURL,
    signal,
    STYLE_FETCH_MAX_BYTES,
    STYLE_FETCH_TIMEOUT_MS
  )
  if (!rawBytes.ok) {
    throw new Error(rawBytes.error)
  }
  let sfntBytes = rawBytes.bytes
  if (style.format === 'woff2') {
    sfntBytes = await transcodeWoff2ToSfnt(sfntBytes)
  }
  const validation = validateFontBytes(sfntBytes)
  if (!validation.ok) {
    // detail 含校验器内部偏移等细节，只进服务端日志；任务 failures 走固定文案
    console.warn(`[fonts-store] style rejected: ${validation.reason}: ${validation.detail}`)
    throw new Error(mapRejectionToText(validation.reason, validation.detail))
  }
  if (validation.container !== 'ttf' && validation.container !== 'otf') {
    throw new Error(`expected sfnt container, got ${validation.container}`)
  }
  const ext: 'ttf' | 'otf' = validation.container
  const styleKey =
    validation.style || `${validation.weight}${validation.italic ? ' Italic' : ''}` || style.style
  const hash = deps.store.hashBytes(sfntBytes)
  const styleEntry: StyleEntry = {
    key: styleKey,
    weight: validation.weight,
    italic: validation.italic,
    variable: validation.variable,
    hash,
    ext,
    size: sfntBytes.byteLength,
    artifact: 'full',
    source: 'store',
    installedAt: Date.now()
  }
  if (validation.wghtRange) styleEntry.wghtRange = validation.wghtRange
  const finalFamily = validation.family || family.family
  deps.store.installBytes({
    bytes: sfntBytes,
    ext,
    style: styleEntry,
    family: finalFamily,
    artifact: 'full'
  })
}

async function handleListTasks(deps: StoreRouteDeps, res: ServerResponse): Promise<boolean> {
  const tasks = deps.tasks
  sendJSON(res, 200, { tasks: tasks.list() })
  return true
}

async function handleCancelTask(
  deps: StoreRouteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const parsed = await readJSONBody(req)
  if (!parsed.ok) {
    sendJSON(res, 400, { error: parsed.error })
    return true
  }
  const r = parsed.body as { taskId?: unknown }
  if (typeof r.taskId !== 'string' || r.taskId.length === 0) {
    sendJSON(res, 400, { error: 'taskId required', code: 'missing-task-id' })
    return true
  }
  const tasks = deps.tasks
  const ok = tasks.cancel(r.taskId)
  if (!ok) {
    sendJSON(res, 404, { error: `task not found or not running: ${r.taskId}`, code: 'not-found' })
    return true
  }
  sendJSON(res, 200, { ok: true, taskId: r.taskId })
  return true
}

// ── 流式 fetch helper（按上限读；abort 即拒） ────────────────────────

/**
 * 从请求体提取 piecesBaseURL：缺省 / 非字符串 / 非 http(s) URL → null（调用方 400）。
 * 抽出独立函数只为压 handleInstall 的 complexity。
 */
function extractPiecesBaseURL(r: { piecesBaseURL?: unknown }): string | null {
  if (typeof r.piecesBaseURL !== 'string' || r.piecesBaseURL.length === 0) return null
  try {
    const parsed = new URL(r.piecesBaseURL)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? r.piecesBaseURL : null
  } catch {
    return null
  }
}

/**
 * fetch Response.body → node:stream/web ReadableStream。两侧类型声明不同源
 * （undici/fetch 全局 vs node:stream/web），运行时是同一对象，单 cast 桥接。
 */
function toNodeWebStream(body: unknown): NodeWebReadableStream {
  return body as NodeWebReadableStream
}

/**
 * 读 AbortSignal.aborted 的活值。跨 await 后 TS 会把循环开头 if 检查过的
 * signal.aborted 窄化成 false——abort 恰恰发生在 await 期间，函数边界打断窄化。
 * （isAborted 来自 ./stream-helpers）
 */

/**
 * 受限 fetch（适配器用）：text()/json() 流式读按 maxBytes 截断——目录响应
 * 无界读会把任意大小的响应拉进内存。超时由调用方持有 signal 侧 controller。
 */
function makeBoundedFetchLike(signal: AbortSignal, maxBytes: number): FetchLike {
  return async (url, init) => {
    const composed = composeSignals(signal, init?.signal)
    const response = await fetch(url, { ...init, signal: composed })
    return wrapBoundedResponse(response, maxBytes)
  }
}

function wrapBoundedResponse(
  response: Response,
  maxBytes: number
): {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
} {
  return {
    ok: response.ok,
    status: response.status,
    async json() {
      const text = await this.text()
      return JSON.parse(text)
    },
    async text() {
      if (!response.body) return ''
      const chunks: Buffer[] = []
      let total = 0
      const nodeStream = Readable.fromWeb(toNodeWebStream(response.body))
      for await (const chunk of nodeStream) {
        const buf = chunk as Buffer
        total += buf.length
        if (total > maxBytes) {
          nodeStream.destroy()
          throw new Error(`body exceeds ${maxBytes} bytes`)
        }
        chunks.push(buf)
      }
      return Buffer.concat(chunks).toString('utf8')
    }
  }
}
