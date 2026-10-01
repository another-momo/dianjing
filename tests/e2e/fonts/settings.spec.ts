import { expect, test } from '@playwright/test'

import { CanvasHelper } from '#tests/helpers/canvas'

test('font settings gear opens the settings dialog fonts section directly', async ({ page }) => {
  await page.goto('/')
  const canvas = new CanvasHelper(page)
  await canvas.waitForInit()

  await page.evaluate(() => {
    const store = window.openPencil?.getStore?.()
    if (!store) throw new Error('OpenPencil store not initialized')
    const id = store.createShape('TEXT', 120, 120, 240, 40)
    store.updateNode(id, {
      characters: 'Font settings smoke',
      fontFamily: 'Missing Test Sans'
    })
    store.select([id])
  })

  const typography = page.getByRole('region', { name: 'Typography' })
  await expect(typography).toBeVisible()
  await expect(
    typography.getByRole('img', { name: /Missing font: Missing Test Sans/ })
  ).toBeVisible()
  const fontBanner = page.getByTestId('font-status-banner')
  await expect(fontBanner).toContainText('1 font face is unavailable or substituted')
  await page.getByTestId('font-status-toggle').click()
  await expect(page.getByTestId('font-status-issue')).toContainText(
    'Missing Test Sans Regular → Inter'
  )
  await page.getByTestId('font-status-select').click()
  await expect(page.getByTestId('font-status-banner')).toBeVisible()
  const selected = await page.evaluate(() => {
    const store = window.openPencil?.getStore?.()
    return store ? [...store.state.selectedIds] : []
  })
  expect(selected).toHaveLength(1)

  // 齿轮按钮无中间 popover：悬浮出 Tip，点击直开设置对话框字体分区
  const fontSettings = page.getByRole('button', { name: 'Open font settings' })
  await expect(fontSettings).toHaveAttribute('data-test-id', 'font-settings-trigger')
  await fontSettings.hover()
  await expect(
    page.locator('[role=tooltip]').filter({ hasText: 'Open font settings' })
  ).toBeVisible()
  await fontSettings.click()

  const fontsPanel = page.getByTestId('settings-fonts-panel')
  await expect(fontsPanel).toBeVisible()
  // 管理功能只在设置面板（popover 已摘除）：提供商开关与维护区都在此
  await expect(fontsPanel.getByTestId('fonts-providers')).toBeVisible()
  await expect(fontsPanel.getByTestId('fonts-fallback-download')).toBeVisible()
  // 下载缓存块 Tauri 专属（实现层 isTauri 门控），浏览器运行时整块不渲染
  await expect(fontsPanel.getByTestId('fonts-cache-clear')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(fontsPanel).toBeHidden()
  await expect(typography).toBeVisible()
})
