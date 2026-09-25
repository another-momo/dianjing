import { describe, expect, test } from 'bun:test'

import {
  cdnFontEntry,
  FONT_REGISTRY,
  fontRegistryEntry,
  isBundledFamilyAllowed,
  isProviderFamilyVisible
} from '#core/text/font/registry'

describe('FONT_REGISTRY', () => {
  test('registers the three bundled families with tiers', () => {
    const families = FONT_REGISTRY.map((entry) => entry.family)
    expect(families).toContain('Inter')
    expect(families).toContain('Alibaba PuHuiTi')
    expect(families).toContain('Noto Naskh Arabic')
  })

  test('Alibaba PuHuiTi carries all nine weights and T1 licensing note', () => {
    const entry = fontRegistryEntry('Alibaba PuHuiTi')
    expect(entry?.tier).toBe('T1')
    expect(entry?.weights).toHaveLength(9)
    expect(entry?.note).toBeTruthy()
  })

  test('only T0/T1 entries are registered', () => {
    for (const entry of FONT_REGISTRY) {
      expect(['T0', 'T1']).toContain(entry.tier)
    }
  })
})

describe('isBundledFamilyAllowed', () => {
  test('allows registered bundled families', () => {
    expect(isBundledFamilyAllowed('Inter')).toBe(true)
    expect(isBundledFamilyAllowed('Alibaba PuHuiTi')).toBe(true)
  })

  test('rejects unregistered families', () => {
    expect(isBundledFamilyAllowed('Comic Sans MS')).toBe(false)
    expect(isBundledFamilyAllowed('')).toBe(false)
  })
})

describe('CDN 家族注册（T40 S4）', () => {
  test('registers the nine verified cn-font families with descriptors', () => {
    const cdnFamilies = FONT_REGISTRY.filter((entry) => entry.source === 'cdn').map(
      (entry) => entry.family
    )
    expect(cdnFamilies).toEqual([
      'Source Han Serif CN VF',
      'LXGW WenKai',
      'Xiaolai SC',
      'Yozai',
      'MaokenAssortedSans',
      '寒蝉全圆体',
      'Zhuque Fangsong (technical preview)',
      'Zhi Mang Xing',
      'Cubic 11'
    ])
    for (const entry of FONT_REGISTRY.filter((entry) => entry.source === 'cdn')) {
      expect(entry.cdn?.package).toMatch(/^@chinese-fonts\//)
      expect(['T0', 'T1']).toContain(entry.tier)
    }
  })

  test('syst registers as the single variable CDN family (T41)', () => {
    const syst = FONT_REGISTRY.find((entry) => entry.family === 'Source Han Serif CN VF')
    expect(syst).toMatchObject({
      tier: 'T0',
      license: 'OFL-1.1',
      source: 'cdn',
      variable: true,
      weights: [],
      cdn: { package: '@chinese-fonts/syst' }
    })
    for (const entry of FONT_REGISTRY.filter(
      (item) => item.source === 'cdn' && item.family !== 'Source Han Serif CN VF'
    )) {
      expect(entry.variable ?? false).toBe(false)
    }
  })

  test('cdnFontEntry only returns families carrying a cdn descriptor', () => {
    expect(cdnFontEntry('LXGW WenKai')?.cdn?.package).toBe('@chinese-fonts/lxgwwenkai')
    expect(cdnFontEntry('Inter')).toBeUndefined()
    expect(cdnFontEntry('Comic Sans MS')).toBeUndefined()
  })

  test('CDN families are not part of the bundled allowlist', () => {
    expect(isBundledFamilyAllowed('LXGW WenKai')).toBe(false)
    expect(isBundledFamilyAllowed('Inter')).toBe(true)
  })
})

describe('isProviderFamilyVisible', () => {
  test('keeps online provider families visible (generic capability)', () => {
    expect(isProviderFamilyVisible('Any Web Font')).toBe(true)
  })
})
