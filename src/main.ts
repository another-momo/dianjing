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
// slogan 末词 ~2.5s）——PROD 保底播完一轮再淡出；dev 默认即挂即退不挡迭代，
// 需要目检时 `?splashMs=<ms>` 强行拉住（仅 dev 生效）。
// performance.now() 以导航起点为 time origin——动效从 HTML 解析即起跑，
// 剩余等待 = 保底时长 − 已流逝，避免「包加载慢就砍动画」。
const SPLASH_MIN_MS = import.meta.env.PROD
  ? 2500
  : Number(new URLSearchParams(location.search).get('splashMs')) || 0

const head = createHead()
createApp(App).use(router).use(head).mount('#app')

const bootSplash = document.getElementById('boot-splash')
if (bootSplash) {
  const remaining = Math.max(0, SPLASH_MIN_MS - performance.now())
  window.setTimeout(() => {
    bootSplash.classList.add('boot-splash--exit')
    window.setTimeout(() => bootSplash.remove(), 650)
  }, remaining)
}
