// shell-polish A1/A2：Electron 壳运行时检测。
//
// main.ts 起回环服务时经 index.html 注入 window.__DIANJING_ELECTRON__=true；
// 浏览器形态（vite dev / 直接访问 dist/）不注入——window 上的同名属性是 undefined。
// 读 globalThis 兜底：SSR / Node 测试环境没有 window，原样走 undefined 分支，
// 与 IS_BROWSER 守卫模式同款语义（详见 packages/core/src/constants.ts）。
//
// 单一暴露 isElectron()——shell-polish 收口后 A1 顶部通栏预留 + A2 标题栏主题
// 切换都用它判定；future shell polish 也复用此单点（不在调用点撒 typeof 散弹）。

declare const __DIANJING_ELECTRON__: boolean | undefined
declare const __DIANJING_PLATFORM__: 'darwin' | 'win32' | 'linux' | undefined

export type ElectronPlatform = 'darwin' | 'win32' | 'linux'

export function isElectron(): boolean {
  // 仅当 main 进程注入时为 true——浏览器形态 + dev 形态均为 undefined（falsy）。
  if (typeof globalThis !== 'undefined') {
    const flag = (globalThis as { __DIANJING_ELECTRON__?: boolean }).__DIANJING_ELECTRON__
    if (flag !== undefined) return flag
  }
  return false
}

// electron-desktop mac 三键避让（2026-09-20）：main 侧把 process.platform
// 注入 window.__DIANJING_PLATFORM__；前端按平台给 editor-root 留左侧 padding
// 避让 macOS traffic-light（Windows 走右侧 --window-controls-width，二者共存
// 不冲突——padding 方向独立）。非 Electron 形态返 'other' 走默认布局（不留
// 任何 padding）。getter 而非常量：便于测试 stub
export function getElectronPlatform(): ElectronPlatform | 'other' {
  if (typeof globalThis === 'undefined') return 'other'
  const platform = (globalThis as { __DIANJING_PLATFORM__?: string }).__DIANJING_PLATFORM__
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform
  return 'other'
}
