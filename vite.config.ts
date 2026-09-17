import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import IconsResolver from 'unplugin-icons/resolver'
import Icons from 'unplugin-icons/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'

import { ensureBrandAssets } from '@open-pencil/brand-tools'

import packageJson from './package.json'
import { piBackendPlugin } from './src/app/ai/pi-backend/vite-plugin'
import { devAutomationRoute } from './src/app/bridge/portless-route'
import { readTauriDevHost } from './src/app/orchestration/env'
import {
  LOCAL_AUTOMATION_HTTP_URL_KEY,
  LOCAL_AUTOMATION_TOKEN_KEY,
  LOCAL_AUTOMATION_URL_KEY,
  LOCAL_AUTOMATION_APP_VERSION_KEY
} from './src/app/orchestration/runtime-globals'
import { createOpenPencilAliases } from './vite/aliases'
import {
  localAutomationRoute,
  localAutomationToken,
  openPencilAutomationPlugin
} from './vite/automation'
import { copyCanvasKitAssetsPlugin } from './vite/canvaskit-assets'
import { rawMarkdownPlugin } from './vite/raw-markdown'
import { createDevServerOptions } from './vite/server'

const host = readTauriDevHost() ?? undefined
const automationRoute = localAutomationRoute(host)

export default defineConfig(async ({ command }) => ({
  resolve: {
    alias: createOpenPencilAliases(__dirname)
  },
  define: {
    // 键名以计算键引用 runtime-globals.ts 常量——config 加载期求值出与
    // 原字面量相同的字符串键，vite 字符串替换语义不变；Phase 2 改名只动
    // src/app/orchestration/runtime-globals.ts。
    [LOCAL_AUTOMATION_APP_VERSION_KEY]: JSON.stringify(packageJson.version),
    [LOCAL_AUTOMATION_TOKEN_KEY]: JSON.stringify(localAutomationToken(command)),
    [LOCAL_AUTOMATION_URL_KEY]: JSON.stringify(automationRoute.browserURL),
    [LOCAL_AUTOMATION_HTTP_URL_KEY]: JSON.stringify(
      automationRoute.browserURL.replace(/^ws/, 'http')
    )
  },
  plugins: [
    rawMarkdownPlugin(),
    copyCanvasKitAssetsPlugin(),
    tailwindcss(),
    Icons({ compiler: 'vue3' }),
    Components({ resolvers: [IconsResolver({ prefix: 'icon' })] }),
    openPencilAutomationPlugin(command, host),
    // T38：bridgeRuntimeId 与 automation 桥插件单源（同一 automationRoute），
    // 让 pi 后端能定位被上游 0f981ff2 隔离到 tmpdir 的桥 discovery 文件
    ...(command === 'serve'
      ? [piBackendPlugin({ bridgeRuntimeId: automationRoute.runtimeId })]
      : []),
    vue()
  ],
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 2500
  },
  server: createDevServerOptions(host)
}))
