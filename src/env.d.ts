/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/vue" />

declare const __DIANJING_APP_VERSION__: string
declare const __DIANJING_LOCAL_AUTOMATION_TOKEN__: string | null
declare const __DIANJING_LOCAL_AUTOMATION_URL__: string
declare const __DIANJING_LOCAL_AUTOMATION_HTTP_URL__: string
// shell-polish A1/A2：Electron 壳运行时标记——main.ts 起回环服务时经 index.html
// 注入；浏览器形态（含 vite dev）不注入故为 undefined。Electron 端读 window，
// SSR / 测试环境读 globalThis 兜底（_dev 端访问 globalThis 不会抛）。
declare const __DIANJING_ELECTRON__: boolean | undefined

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
