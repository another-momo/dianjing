import { useLocalStorage, usePreferredDark } from '@vueuse/core'
import { computed, watch } from 'vue'

import type { RulerTheme } from '@open-pencil/core/canvas'
import { parseColor } from '@open-pencil/core/color'
import { hasWindowGlobal, IS_BROWSER } from '@open-pencil/core/constants'

import { getActiveEditorStoreOrNull, useActiveEditorStoreRef } from '@/app/editor/active-store'
import { isElectron } from '@/app/shell/electron'

export type AppTheme = 'dark' | 'light' | 'auto'

const THEME_STORAGE_KEY = 'open-pencil:theme'
const DEFAULT_THEME: AppTheme = 'light'

const theme = useLocalStorage<AppTheme>(THEME_STORAGE_KEY, DEFAULT_THEME)
const prefersDark = usePreferredDark()
export const resolvedAppTheme = computed<'dark' | 'light'>(() => {
  if (theme.value === 'auto') return prefersDark.value ? 'dark' : 'light'
  return theme.value
})

function readRulerTheme(): RulerTheme | null {
  if (!IS_BROWSER || !('document' in globalThis)) return null
  const style = getComputedStyle(document.documentElement)
  return {
    background: parseColor(style.getPropertyValue('--color-ruler-bg')),
    tick: parseColor(style.getPropertyValue('--color-ruler-tick')),
    text: parseColor(style.getPropertyValue('--color-ruler-text')),
    label: parseColor(style.getPropertyValue('--color-ruler-label'))
  }
}

function updateCanvasTheme(): void {
  if (!hasWindowGlobal()) return
  const store = getActiveEditorStoreOrNull()
  if (!store) return
  store.state.rulerTheme = readRulerTheme() ?? undefined
  store.requestRepaint()
}

// shell-polish A2：标题栏主题跟随——同色 + 高对比前景。端点 POST 静默 catch，
// 网络抖动或 main 进程尚未就绪不影响前端应用主题本身（页面背景已正确切）。
// 端点幂等，无需去抖——每次 applyTheme 都发。symbolColor 仅 Windows 实际生效
// （macOS titleBarOverlay 无按钮可见），逻辑仍写全端兼容代码。
function syncElectronTitleBar(value: 'dark' | 'light'): void {
  if (!hasWindowGlobal() || !isElectron()) return
  const style = getComputedStyle(document.documentElement)
  const color = style.getPropertyValue('--color-canvas').trim()
  // symbolColor：app.css 无独立 --color-titlebar-symbol；浅色主题用 --color-surface
  // （src/app.css L84 = #1f2328，与白底对比度 OK）；深色主题用 #ffffff（与
  // --color-canvas: #1e1e1e 对比度 16:1，满足 WCAG AAA）。前端 fallback 不应
  // 触发——color 缺位说明 app.css 漏 token，是上游 bug 而非缺值。
  const symbolColor =
    value === 'light' ? style.getPropertyValue('--color-surface').trim() : '#ffffff'
  if (!color) return
  void fetch('/__dianjing/titlebar-theme', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ color, symbolColor })
  }).catch(() => {
    // 静默——端点可能尚未 listen（首启竞速）或网络断开，不影响主题应用本身
  })
}

function applyTheme(value: 'dark' | 'light', setting: AppTheme): void {
  if (!IS_BROWSER || !('document' in globalThis)) return
  document.documentElement.dataset.theme = value
  document.documentElement.dataset.themeSetting = setting
  document.documentElement.style.colorScheme = value
  updateCanvasTheme()
  syncElectronTitleBar(value)
}

export function useAppTheme() {
  watch([resolvedAppTheme, theme], ([value, setting]) => applyTheme(value, setting), {
    immediate: true
  })

  // Editors may mount after the theme was applied; push the canvas (ruler)
  // theme whenever the active editor changes so rulers always match.
  const activeStoreRef = useActiveEditorStoreRef()
  watch([activeStoreRef, resolvedAppTheme], () => updateCanvasTheme(), { flush: 'post' })

  const isLight = computed(() => resolvedAppTheme.value === 'light')

  function setTheme(value: AppTheme): void {
    theme.value = value
  }

  function toggleTheme(): void {
    theme.value = isLight.value ? 'dark' : 'light'
  }

  return { theme, resolvedTheme: resolvedAppTheme, isLight, setTheme, toggleTheme }
}

applyTheme(resolvedAppTheme.value, theme.value)
