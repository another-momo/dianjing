import process from 'node:process'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import IconsResolver from 'unplugin-icons/resolver'
import Icons from 'unplugin-icons/vite'
import Components from 'unplugin-vue-components/vite'
import { defineConfig } from 'vite'

import packageJson from './package.json'
import { AUTOMATION_HTTP_PORT } from './packages/core/src/constants'
import { piBackendPlugin } from './src/app/ai/pi-backend/vite-plugin'
import { devAutomationRoute } from './src/app/bridge/portless-route'
import { createOpenPencilAliases } from './vite/aliases'
import {
  localAutomationRoute,
  localAutomationToken,
  openPencilAutomationPlugin
} from './vite/automation'
import { copyCanvasKitAssetsPlugin } from './vite/canvaskit-assets'
import { rawMarkdownPlugin } from './vite/raw-markdown'
import { createDevServerOptions } from './vite/server'

const host = process.env.TAURI_DEV_HOST
const automationRoute = localAutomationRoute(host)

export default defineConfig(async ({ command }) => ({
  resolve: {
    alias: createOpenPencilAliases(__dirname)
  },
  define: {
    __OPENPENCIL_APP_VERSION__: JSON.stringify(packageJson.version),
    __OPENPENCIL_LOCAL_AUTOMATION_TOKEN__: JSON.stringify(localAutomationToken(command)),
    __OPENPENCIL_LOCAL_AUTOMATION_URL__: JSON.stringify(automationRoute.browserURL),
    __OPENPENCIL_LOCAL_AUTOMATION_HTTP_URL__: JSON.stringify(
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
    // T38：mcpRuntimeId 与 automation 桥插件单源（同一 automationRoute），
    // 让 pi 后端能定位被上游 0f981ff2 隔离到 tmpdir 的桥 discovery 文件
    ...(command === 'serve' ? [piBackendPlugin({ mcpRuntimeId: automationRoute.runtimeId })] : []),
    vue()
  ],
  clearScreen: false,
  build: {
    chunkSizeWarningLimit: 2500
  },
  server: createDevServerOptions(host)
}))
