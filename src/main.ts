import { createHead } from '@unhead/vue/client'
import { createApp } from 'vue'

import './app.css'
import { attachPiBackendTransport } from '@/app/ai/pi-backend/attach'
import { preloadFonts } from '@/app/editor/fonts'

import App from './App.vue'
import router from './router'

attachPiBackendTransport()

preloadFonts()

// 启动过渡页退场时序：CSS 动效全长 ~2.5s（眼廓 0.15→1.1s、瞳仁/涟漪 1.2s、
// slogan 末词 ~2.5s）+ 终态停留 0.6s。动效由 boot-splash--run 类闸门启动，
// 加类与计时都锚定首帧绘制（rAF）——而非导航起点：Electron show:false +
// ready-to-show 形态下窗口可见前的 bundle 加载耗时会吃掉动画前段
// （2026-09-17 安装版过渡页一闪而过实证）。dev 默认即挂即退不挡迭代，
// 需要目检时 `?splashMs=<ms>` 强行拉住（仅 dev 生效）。
const SPLASH_VISIBLE_MS = import.meta.env.PROD
  ? 3100
  : Number(new URLSearchParams(location.search).get('splashMs')) || 0

const head = createHead()
createApp(App).use(router).use(head).mount('#app')

const bootSplash = document.getElementById('boot-splash')
if (bootSplash) {
  requestAnimationFrame(() => {
    bootSplash.classList.add('boot-splash--run')
    window.setTimeout(() => {
      bootSplash.classList.add('boot-splash--exit')
      window.setTimeout(() => bootSplash.remove(), 650)
    }, SPLASH_VISIBLE_MS)
  })
}
