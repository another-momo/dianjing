import { describe, expect, test } from 'bun:test'

import { useFontSettings, type FontSettingsActions } from '@/components/font-settings/use'

/**
 * 字体设置 popover 轻量 composable 的钉扎（统一批 A 后）：
 * popover 降级为只读摘要 + 本地授权按钮 + 「打开字体设置」深链；
 * 原 popover 独占的提供商开关、回退包预下载、缓存管理已迁入白名单面板，
 * 不再走 composable。
 */
function actions(overrides: Partial<FontSettingsActions> = {}): FontSettingsActions {
  let accessState: ReturnType<FontSettingsActions['localFontAccessState']> = 'prompt'
  return {
    localFontAccessState() {
      return accessState
    },
    async requestLocalFontAccess() {
      accessState = 'granted'
      return []
    },
    ...overrides
  }
}

describe('useFontSettings', () => {
  test('starts in prompt state and reflects not-requested label', () => {
    const settings = useFontSettings(actions())

    expect(settings.accessState.value).toBe('prompt')
    expect(settings.accessStateLabel.value).toBe('Not requested')
    expect(settings.canRequestLocalFonts.value).toBe(true)
    expect(settings.busyAction.value).toBeNull()
  })

  test('refreshSummary syncs from the action', () => {
    const settings = useFontSettings(
      actions({
        localFontAccessState() {
          return 'denied'
        }
      })
    )

    void settings.refreshSummary()

    expect(settings.accessState.value).toBe('denied')
    expect(settings.accessStateLabel.value).toBe('Denied')
    expect(settings.canRequestLocalFonts.value).toBe(true)
  })

  test('requests local font access and updates state without leaving busy', async () => {
    const settings = useFontSettings(actions())

    await settings.requestAccess()

    expect(settings.accessState.value).toBe('granted')
    expect(settings.accessStateLabel.value).toBe('Enabled')
    expect(settings.canRequestLocalFonts.value).toBe(false)
    expect(settings.busyAction.value).toBeNull()
  })

  test('unsupported state hides the request button', () => {
    const settings = useFontSettings(
      actions({
        localFontAccessState() {
          return 'unsupported'
        }
      })
    )
    void settings.refreshSummary()

    expect(settings.accessState.value).toBe('unsupported')
    expect(settings.accessStateLabel.value).toBe('Unavailable')
    expect(settings.canRequestLocalFonts.value).toBe(false)
  })
})
