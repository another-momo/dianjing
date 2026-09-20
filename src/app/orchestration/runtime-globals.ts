/**
 * 浏览器侧运行时全局名常量（pure string constants，无 node 依赖）。
 *
 * 与 env.ts 拆分理由：浏览器侧模块（bridge/runtime.ts、bridge/url.ts）只读
 * 字符串字面量，不应被 env.ts 的 `import process from 'node:process'` 污染
 * 打包链。本文件纯字符串 + 类型，浏览器可放心 import。
 *
 * 集中真源：window.__DIANJING_RUNTIME_* 与 vite define 烘焙的 __DIANJING_LOCAL_*
 * 在此统一登记；改名期 ①搬迁值字面量由 brand.ts 的 RUNTIME_GLOBAL_PREFIX
 * 模板派生（保字面量类型），②翻转只改 brand.ts 一个常量即可完成。
 */

import { RUNTIME_GLOBAL_PREFIX } from './brand'

// ── runtime（宿主注入 / window 属性）──

/** host.ts / Electron main 注入到 index.html 的桥 token 全局 */
export const RUNTIME_AUTOMATION_TOKEN_KEY =
  `${RUNTIME_GLOBAL_PREFIX}RUNTIME_AUTOMATION_TOKEN__` as const

/** Electron main 注入到 index.html 的桥 WS URL 全局（与 token 同源） */
export const RUNTIME_BRIDGE_URL_KEY = `${RUNTIME_GLOBAL_PREFIX}RUNTIME_BRIDGE_URL__` as const

/** Electron main 注入到 index.html 的「运行在 Electron」标志 */
export const RUNTIME_ELECTRON_KEY = `${RUNTIME_GLOBAL_PREFIX}ELECTRON__` as const

/** Electron main 注入到 index.html 的平台字符串（'darwin' | 'win32' | 'linux'） */
export const RUNTIME_PLATFORM_KEY = `${RUNTIME_GLOBAL_PREFIX}PLATFORM__` as const

// ── local（vite define 烘焙 / build-time 全局）──

/** vite define 烘焙的 dev 桥 token（dev 形态有效，build 形态为 null） */
export const LOCAL_AUTOMATION_TOKEN_KEY =
  `${RUNTIME_GLOBAL_PREFIX}LOCAL_AUTOMATION_TOKEN__` as const

/** vite define 烘焙的 dev 桥 WS URL（dev 形态有效） */
export const LOCAL_AUTOMATION_URL_KEY = `${RUNTIME_GLOBAL_PREFIX}LOCAL_AUTOMATION_URL__` as const

/** vite define 烘焙的 dev 桥 HTTP URL（runtime.ts 健康探活用） */
export const LOCAL_AUTOMATION_HTTP_URL_KEY =
  `${RUNTIME_GLOBAL_PREFIX}LOCAL_AUTOMATION_HTTP_URL__` as const

/** vite define 烘焙的应用版本号（vite.config.ts define） */
export const LOCAL_AUTOMATION_APP_VERSION_KEY = `${RUNTIME_GLOBAL_PREFIX}APP_VERSION__` as const

// ── 全集（给 env.ts re-export 与测试用）──

export const RUNTIME_GLOBALS = {
  RUNTIME_AUTOMATION_TOKEN_KEY,
  RUNTIME_BRIDGE_URL_KEY,
  RUNTIME_ELECTRON_KEY,
  RUNTIME_PLATFORM_KEY,
  LOCAL_AUTOMATION_TOKEN_KEY,
  LOCAL_AUTOMATION_URL_KEY,
  LOCAL_AUTOMATION_HTTP_URL_KEY,
  LOCAL_AUTOMATION_APP_VERSION_KEY
} as const

export type RuntimeGlobalKey = (typeof RUNTIME_GLOBALS)[keyof typeof RUNTIME_GLOBALS]

/**
 * 类型守卫：判断字符串是否是已知 runtime global 名。
 * 给 bridge/runtime.ts 的「运行时全局优先于烘焙值」链路用。
 */
export function isRuntimeGlobalKey(value: string): value is RuntimeGlobalKey {
  return (Object.values(RUNTIME_GLOBALS) as string[]).includes(value)
}
