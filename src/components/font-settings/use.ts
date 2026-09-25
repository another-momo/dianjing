import { computed, ref } from 'vue'

import type { LocalFontAccessState } from '@open-pencil/core/text'
import { useI18n } from '@open-pencil/vue'

import { localFontAccessState, requestLocalFontAccess } from '@/app/editor/fonts'

/**
 * 字体设置 popover 的轻量 composable（统一批 A 后）：
 * popover 降级为只读状态摘要 + 「打开字体设置」深链 + 本地授权按钮。
 * 原 popover 独占的提供商开关、回退包预下载、缓存管理已迁入白名单面板
 * （src/components/settings/fonts/FontsSettingsPanel.vue），不再走 popover。
 *
 * 仅暴露本组件关心的两件事：本地字体访问状态与授权请求。
 */
export interface FontSettingsActions {
  localFontAccessState: () => LocalFontAccessState
  requestLocalFontAccess: () => Promise<unknown>
}

const defaultActions: FontSettingsActions = {
  localFontAccessState,
  requestLocalFontAccess
}

export function useFontSettings(actions: FontSettingsActions = defaultActions) {
  const { common } = useI18n()
  const accessState = ref(actions.localFontAccessState())
  const busyAction = ref<'access' | null>(null)
  const status = ref('')

  const accessStateLabel = computed(() => {
    if (accessState.value === 'granted') return common.value.enabled
    if (accessState.value === 'denied') return common.value.denied
    if (accessState.value === 'unsupported') return common.value.unavailable
    return common.value.notRequested
  })

  const canRequestLocalFonts = computed(
    () => accessState.value === 'prompt' || accessState.value === 'denied'
  )

  async function refreshSummary() {
    accessState.value = actions.localFontAccessState()
  }

  async function requestAccess() {
    busyAction.value = 'access'
    status.value = ''
    try {
      await actions.requestLocalFontAccess()
      accessState.value = actions.localFontAccessState()
    } finally {
      busyAction.value = null
    }
  }

  return {
    accessState,
    accessStateLabel,
    busyAction,
    canRequestLocalFonts,
    status,
    refreshSummary,
    requestAccess
  }
}
