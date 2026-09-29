import { createHead } from '@unhead/vue/client'
import { createApp, nextTick } from 'vue'

import { createRetainedScopePlugin } from '@open-pencil/vue'

import './app.css'
import { attachPiBackendTransport } from '@/app/ai/pi-backend/attach'
import { preloadFonts } from '@/app/editor/fonts'
import { observeBootErrors } from '@/app/shell/support/boot'
import { reportBootFailure } from '@/app/shell/support/gate'

import App from './App.vue'
import router from './router'

/**
 * Application entry, loaded by `main.ts` only after the support gate passes.
 * Keeping it behind a dynamic import means an unsupported engine never
 * evaluates the app bundle and can still show the gate's guidance.
 */
export async function boot(): Promise<void> {
  attachPiBackendTransport()
  preloadFonts()
  const head = createHead()
  const app = createApp(App)
  const bootErrors = observeBootErrors(app)
  app.use(router).use(head).use(createRetainedScopePlugin()).mount('#app')

  // 启动过渡页退场时序：CSS 动效全长 ~2.5s（眼廓 0.15→1.1s、瞳仁/涟漪 1.2s、
  // slogan 末词 ~2.5s）。动效从 HTML 解析即播（无类闸门——Electron 产品形态窗
  // 口 show:true 随创建即可见，播放与 bundle 加载重叠）；退场锚首帧 rAF +
  // 3100ms——rAF 即「bundle 求值完、Vue 已挂载」，保证其上的动画完整播完再停
  // 留一拍淡出，加载快慢都不砍动画也不重播。dev 默认即挂即退不挡迭代，需要目
  // 检时 `?splashMs=<ms>` 强行拉住（仅 dev 生效）。
  const SPLASH_VISIBLE_MS = import.meta.env.PROD
    ? 3100
    : Number(new URLSearchParams(location.search).get('splashMs')) || 0
  const bootSplash = document.getElementById('boot-splash')
  if (bootSplash) {
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        bootSplash.classList.add('boot-splash--exit')
        window.setTimeout(() => bootSplash.remove(), 650)
      }, SPLASH_VISIBLE_MS)
    })
  }

  await router.isReady()
  await nextTick()
  const failure = bootErrors.stop()
  if (failure) {
    await reportBootFailure(failure.error)
  }
}
