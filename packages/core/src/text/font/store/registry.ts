/**
 * 字体商店服务注册表（纯逻辑）。
 *
 * 形态：内置预设 + 自定义服务合并；适配器工厂按 service.kind 分派。
 *
 * 内置预设：Fontsource（preset:fontsource，baseURL=https://api.fontsource.org）。
 * 自定义服务由用户通过 UI 注册；持久化归 pi-backend/fonts/services-store.ts，
 * 本模块只做 merge（合并去重 + 顺序：内置先行、自定义后随）。
 *
 * 适配器路由：fontsource → fontsourceAdapter（单例，preset 入口）；standard →
 * createStandardAdapter(baseURL)；gf-api → createGoogleFontsAdapter(baseURL, apiKey)。
 * 适配器形态统一（StoreAdapter），调用方只关心「拉目录」语义。
 */
import { fontsourceAdapter } from './adapters/fontsource'
import { createGoogleFontsAdapter } from './adapters/gf-api'
import { createStandardAdapter } from './adapters/standard'
import type { StoreAdapter, StoreServiceDescriptor } from './types'

export const FONTSOURCE_PRESET_ID = 'preset:fontsource'

/** 内置预设清单——当前只发 Fontsource；后续可追加 */
export const BUILTIN_STORE_PRESETS: StoreServiceDescriptor[] = [
  {
    id: FONTSOURCE_PRESET_ID,
    name: 'Fontsource',
    kind: 'fontsource',
    baseURL: 'https://api.fontsource.org',
    builtin: true
  }
]

/** 合并内置 + 自定义：内置先行，自定义按原顺序续接；id 撞车以自定义覆盖内置（防呆） */
export function mergeServices(
  builtin: StoreServiceDescriptor[],
  custom: StoreServiceDescriptor[]
): StoreServiceDescriptor[] {
  const customIds = new Set(custom.map((s) => s.id))
  const out: StoreServiceDescriptor[] = []
  for (const service of builtin) {
    if (!customIds.has(service.id)) out.push(service)
  }
  out.push(...custom)
  return out
}

/**
 * 给定服务 → 适配器实例。fontsource 复用单例；standard / gf-api 每次新建
 * （轻量闭包）。kind union 闭合，三选一穷举（注册与持久化层均已白名单校验）。
 */
export function adapterForService(service: StoreServiceDescriptor): StoreAdapter {
  if (service.kind === 'fontsource') return fontsourceAdapter
  if (service.kind === 'standard') return createStandardAdapter(service.baseURL)
  return createGoogleFontsAdapter(service.baseURL, service.apiKey ?? '')
}
