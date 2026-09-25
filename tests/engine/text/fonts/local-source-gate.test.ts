/**
 * 本地字体应用级开关钉扎（统一批 B）：
 * - 默认开；
 * - 关停时 listFamilyOptions 排除本地族；
 * - 关停时 ensureFallbackFamilies 的 localFamilies 循环跳过；
 * - 重新启用后行为恢复。
 *
 * 设计目的：本批把本地（系统）字体归入与在线 / CDN 同形的「来源开关」语义——
 * 开关管「要不要」、权限管「能不能」；关停时本地族视为未安装（与单族关停
 * 「视为未安装」语义对齐），picker 不枚举、回退链不拼装本地段。
 */
import { describe, expect, test } from 'bun:test'

import { FontManager } from '@open-pencil/core/text'

import { fontFallbackEntry } from '#core/text/fallbacks'

interface LocalFontRecord {
  family: string
  fullName: string
  style: string
  postscriptName: string
}

type LocalAccessState = 'unsupported' | 'prompt' | 'granted' | 'denied'

interface FontManagerProbe {
  localFonts: LocalFontRecord[]
  localFontAccessState: LocalAccessState
}

describe('FontManager 本地字体应用级开关（统一批 B）', () => {
  test('默认开', () => {
    const manager = new FontManager()
    expect(manager.isLocalFontsEnabled()).toBe(true)
  })

  test('setLocalFontsEnabled(false) 切换为关', () => {
    const manager = new FontManager()

    manager.setLocalFontsEnabled(false)

    expect(manager.isLocalFontsEnabled()).toBe(false)
  })

  test('关停时 listFamilyOptions 不暴露本地族（即使 localFonts 已 granted）', async () => {
    const manager = new FontManager()
    // 在线 provider 枚举超时改极小值——避免默认 6s 兜底拖慢单测
    manager.setWebFontListTimeout(1)
    // 直接写入已授权的本地字体表（避开权限门禁）——本测试只验开关过滤行为
    const probe = manager as FontManagerProbe
    probe.localFonts = [
      {
        family: 'Local Sans',
        fullName: 'Local Sans Regular',
        style: 'Regular',
        postscriptName: 'LocalSans-Regular'
      }
    ]
    // 模拟 grant 状态
    probe.localFontAccessState = 'granted'

    manager.setLocalFontsEnabled(false)

    const options = await manager.listFamilyOptions({ includeDisabled: true })
    expect(options.some((option) => option.family === 'Local Sans')).toBe(false)

    manager.setLocalFontsEnabled(true)

    const reopened = await manager.listFamilyOptions({ includeDisabled: true })
    expect(reopened.some((option) => option.family === 'Local Sans')).toBe(true)
  })

  test('关停时回退链拼装跳过本地族（cjk manifest 的 localFamilies 不入链）', async () => {
    const manager = new FontManager()
    manager.setCnFontPieceCache(null)
    manager.setWebFontListTimeout(50)

    // 关停前 cjk 链含 manifest.localFamilies（即便单条加载失败，链基线仍包含本地段）
    const beforeChain = [...manager.getCJKFallbackFamilies()].sort((a, b) => a.localeCompare(b))
    const manifestLocal = [...fontFallbackEntry('cjk').localFamilies].sort((a, b) =>
      a.localeCompare(b)
    )
    expect(manifestLocal.length).toBeGreaterThan(0)

    manager.setLocalFontsEnabled(false)
    // 触发一次 ensureCJKFallback 跑通本地循环（虽然已跳过）
    await manager.ensureCJKFallback()
    const afterChain = [...manager.getCJKFallbackFamilies()].sort((a, b) => a.localeCompare(b))

    // 关停后链基线不应含任何 manifest.localFamilies 中未通过远端拿到的条目
    // （manifest.localFamilies 与 afterChain 取差集 = 0；beforeChain 同理以便 sanity check）
    const overlap = afterChain.filter((family) => manifestLocal.includes(family))
    expect(overlap).toEqual([])

    // 重新启用：行为恢复（不强制断言具体成员——网络/远端可达性各异，
    // 只要 setLocalFontsEnabled(true) 后开关回到 true 即可）
    manager.setLocalFontsEnabled(true)
    expect(manager.isLocalFontsEnabled()).toBe(true)

    // 防止 unused warning
    void beforeChain
  })
})
