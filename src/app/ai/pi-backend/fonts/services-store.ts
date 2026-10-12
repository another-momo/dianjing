/**
 * 自定义字体服务持久化（pi-backend 侧）。
 *
 * 落点：<rootDir>/fonts/services.json——与 manifest.json 同根目录、单独文件。
 * 形态：自定义服务列表（kind=standard|gf-api，fontsource 是预设不持久化）。
 *
 * 设计要点：
 *  - 读容错：坏 JSON 按空数组兜 + console.warn，不阻断服务清单视图
 *  - 写盘 tmp+rename（与 store.ts writeManifest 同款姿势）
 *  - id 撞车在 route 层处理（-2 后缀），本层不参与
 *  - 不与 Fontsource 预设共存（预设 id 始终 'preset:fontsource'，不在持久化文件里）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { slugifyFamilyName } from '@open-pencil/core/text/font/installed/layout'
import type {
  StoreServiceDescriptor,
  StoreServiceKind
} from '@open-pencil/core/text/font/store/types'

const SERVICES_FILENAME = 'services.json'
const ALLOWED_KINDS: ReadonlySet<StoreServiceKind> = new Set(['standard', 'gf-api'])

interface PersistedFile {
  version: 1
  services: StoreServiceDescriptor[]
}

export interface CustomServicesStore {
  path: string
  read(): StoreServiceDescriptor[]
  write(services: StoreServiceDescriptor[]): void
  add(service: StoreServiceDescriptor): StoreServiceDescriptor[]
  remove(id: string): StoreServiceDescriptor[]
}

export function createCustomServicesStore({ rootDir }: { rootDir: string }): CustomServicesStore {
  const path = join(rootDir, 'fonts', SERVICES_FILENAME)
  let cache: StoreServiceDescriptor[] | undefined

  function ensureParent(): void {
    const parent = dirname(path)
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true })
    }
  }

  function read(): StoreServiceDescriptor[] {
    if (cache) return cache
    if (!existsSync(path)) {
      cache = []
      return cache
    }
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      console.warn(`[fonts-services] read failed: ${(error as Error).message}`)
      cache = []
      return cache
    }
    const parsed = parseFile(raw)
    if (!parsed.ok) {
      console.warn(`[fonts-services] services.json corrupt: ${parsed.detail}`)
      cache = []
      return cache
    }
    cache = parsed.services
    return cache
  }

  function write(services: StoreServiceDescriptor[]): void {
    cache = services
    const doc = JSON.stringify({ version: 1, services } satisfies PersistedFile)
    ensureParent()
    const tmp = `${path}.tmp`
    writeFileSync(tmp, doc, { mode: 0o600 })
    renameSync(tmp, path)
  }

  function add(service: StoreServiceDescriptor): StoreServiceDescriptor[] {
    const next = [...read(), service]
    write(next)
    return next
  }

  function remove(id: string): StoreServiceDescriptor[] {
    const next = read().filter((s) => s.id !== id)
    write(next)
    return next
  }

  return { path, read, write, add, remove }
}

/**
 * 服务名 → 自定义服务 id。复用 slugifyFamilyName（同套编码规则：CJK 等
 * 非 ASCII 字符 ~xNN 编码，大小写折叠，连字符折叠）——自定义服务 id 与族名
 * slug 走同一编码器以保证一致性。
 */
export function slugifyServiceName(name: string): string {
  const slug = slugifyFamilyName(name)
  return `custom:${slug.length > 0 ? slug : 'service'}`
}

/** 注册请求体的未校验入线形态（字段逐一 typeof 校验后才采信） */
interface RegisterInputShape {
  name?: unknown
  baseURL?: unknown
  kind?: unknown
  apiKey?: unknown
}

/** 校验并归一化注册入参——返回 null 即入参非法 */
export function normalizeRegisterInput(input: unknown): {
  name: string
  baseURL: string
  kind: StoreServiceKind
  apiKey?: string
} | null {
  if (!input || typeof input !== 'object') return null
  const r = input as RegisterInputShape
  if (typeof r.name !== 'string' || r.name.trim().length === 0) return null
  if (typeof r.baseURL !== 'string' || r.baseURL.trim().length === 0) return null
  if (!isHTTPURL(r.baseURL)) return null
  if (typeof r.kind !== 'string' || !ALLOWED_KINDS.has(r.kind as StoreServiceKind)) return null
  const out: {
    name: string
    baseURL: string
    kind: StoreServiceKind
    apiKey?: string
  } = {
    name: r.name.trim(),
    baseURL: r.baseURL.trim().replace(/\/+$/, ''),
    kind: r.kind as StoreServiceKind
  }
  if (typeof r.apiKey === 'string' && r.apiKey.length > 0) {
    out.apiKey = r.apiKey
  }
  return out
}

function isHTTPURL(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** services.json 未校验入线形态 */
interface PersistedFileShape {
  version?: unknown
  services?: unknown
}

/** 持久化单服务未校验入线形态 */
interface PersistedServiceShape {
  id?: unknown
  name?: unknown
  baseURL?: unknown
  kind?: unknown
  apiKey?: unknown
  builtin?: unknown
}

interface ParseOk {
  ok: true
  services: StoreServiceDescriptor[]
}
interface ParseFail {
  ok: false
  detail: string
}

function parseFile(raw: string): ParseOk | ParseFail {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, detail: 'not an object' }
  const r = parsed as PersistedFileShape
  if (r.version !== 1) return { ok: false, detail: `unsupported version: ${String(r.version)}` }
  if (!Array.isArray(r.services)) return { ok: false, detail: 'services must be an array' }
  const services: StoreServiceDescriptor[] = []
  for (const item of r.services) {
    const service = normalizePersistedService(item)
    if (service) services.push(service)
  }
  return { ok: true, services }
}

function normalizePersistedService(raw: unknown): StoreServiceDescriptor | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as PersistedServiceShape
  if (typeof r.id !== 'string' || !r.id.startsWith('custom:')) return null
  if (typeof r.name !== 'string' || r.name.length === 0) return null
  if (typeof r.baseURL !== 'string' || r.baseURL.length === 0) return null
  if (r.kind !== 'standard' && r.kind !== 'gf-api') return null
  if (r.builtin === true) return null
  const out: StoreServiceDescriptor = {
    id: r.id,
    name: r.name,
    kind: r.kind,
    baseURL: r.baseURL,
    builtin: false
  }
  if (typeof r.apiKey === 'string' && r.apiKey.length > 0) out.apiKey = r.apiKey
  return out
}
