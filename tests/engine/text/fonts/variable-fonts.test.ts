/**
 * T41 可变字体链路单测（D-b 收口）。
 * 覆盖：三容器 fvar 嗅探（font/variable.ts）/ FontManager VF 入账跟踪 /
 * 排版期 wght 轴自动注入。
 *
 * 「退役批」后 findLocalFont VF 放宽用例不再适用（系统字体整面退役）。
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { fontManager, FontManager, sniffVariableFont } from '@open-pencil/core/text'

import { withWeightAxisVariation } from '#core/canvas/text'

/** 合成最小 sfnt：单 fvar 表含 wght 轴（F16.16 定点） */
function vfBuffer(min = 250, def = 400, max = 900): ArrayBuffer {
  const buf = new ArrayBuffer(64)
  const v = new DataView(buf)
  v.setUint32(0, 0x00010000) // sfnt version
  v.setUint16(4, 1) // numTables
  for (let i = 0; i < 4; i++) v.setUint8(12 + i, 'fvar'.charCodeAt(i))
  v.setUint32(20, 28) // table offset
  v.setUint32(24, 36) // table length
  v.setUint16(28, 1) // fvar major
  v.setUint16(32, 16) // axesArrayOffset
  v.setUint16(36, 1) // axisCount
  v.setUint16(38, 20) // axisSize
  for (let i = 0; i < 4; i++) v.setUint8(44 + i, 'wght'.charCodeAt(i))
  v.setInt32(48, min * 65536)
  v.setInt32(52, def * 65536)
  v.setInt32(56, max * 65536)
  return buf
}

/** 静态 sfnt（无 fvar） */
function staticBuffer(): ArrayBuffer {
  const buf = new ArrayBuffer(16)
  const v = new DataView(buf)
  v.setUint32(0, 0x00010000)
  v.setUint16(4, 0)
  return buf
}

/** 最小 woff2：header 48B + 单目录项（fvar 已知标签 44，base128 长度 100） */
function woff2VfBuffer(): ArrayBuffer {
  const buf = new ArrayBuffer(50)
  const v = new DataView(buf)
  v.setUint32(0, 0x774f4632) // 'wOF2'
  v.setUint16(12, 1) // numTables
  v.setUint8(48, 44) // flags：tag index 44 = fvar，无 transform
  v.setUint8(49, 100) // origLength base128 单字节
  return buf
}

/** 最小 woff：header 44B + 20B 目录项（fvar 未压缩）+ fvar 数据 */
function woffVfBuffer(min = 100, max = 900): ArrayBuffer {
  const buf = new ArrayBuffer(44 + 20 + 36)
  const v = new DataView(buf)
  v.setUint32(0, 0x774f4646) // 'wOFF'
  v.setUint16(12, 1) // numTables
  for (let i = 0; i < 4; i++) v.setUint8(44 + i, 'fvar'.charCodeAt(i))
  v.setUint32(48, 64) // fvar offset
  v.setUint32(52, 36) // compLength
  v.setUint32(56, 36) // origLength（相等 = 未压缩）
  v.setUint16(64, 1) // fvar major
  v.setUint16(68, 16) // axesArrayOffset
  v.setUint16(72, 1) // axisCount
  v.setUint16(74, 20) // axisSize
  for (let i = 0; i < 4; i++) v.setUint8(80 + i, 'wght'.charCodeAt(i))
  v.setInt32(84, min * 65536)
  v.setInt32(88, 400 * 65536)
  v.setInt32(92, max * 65536)
  return buf
}

describe('sniffVariableFont（三容器 fvar 嗅探）', () => {
  test('sfnt fvar：variable + wght 区间读出', () => {
    const info = sniffVariableFont(vfBuffer(250, 400, 900))
    expect(info.variable).toBe(true)
    expect(info.wght).toEqual({ min: 250, default: 400, max: 900 })
  })

  test('静态 sfnt / 空数据 / 截断数据：variable false 且不 throw', () => {
    expect(sniffVariableFont(staticBuffer()).variable).toBe(false)
    expect(sniffVariableFont(new ArrayBuffer(4)).variable).toBe(false)
    expect(sniffVariableFont(vfBuffer().slice(0, 30)).variable).toBe(true) // 目录可读
    expect(sniffVariableFont(vfBuffer().slice(0, 30)).wght).toBeUndefined() // 表体截断
  })

  test('woff2 容器：目录已知标签 44 检出，区间不可读（brotli 流内）', () => {
    const info = sniffVariableFont(woff2VfBuffer())
    expect(info.variable).toBe(true)
    expect(info.wght).toBeUndefined()
  })

  test('woff 容器：未压缩 fvar 直读区间', () => {
    const info = sniffVariableFont(woffVfBuffer(100, 900))
    expect(info.variable).toBe(true)
    expect(info.wght).toEqual({ min: 100, default: 400, max: 900 })
  })
})

describe('FontManager VF 入账跟踪', () => {
  test('markLoaded VF → isVariableFamily / variableWeightRange；静态族为 false/null', () => {
    const manager = new FontManager()
    manager.markLoaded('VF Test Fam', 'Regular', vfBuffer(250, 400, 900))
    manager.markLoaded('Static Test Fam', 'Regular', staticBuffer())

    expect(manager.isVariableFamily('VF Test Fam')).toBe(true)
    expect(manager.variableWeightRange('VF Test Fam')).toEqual({ min: 250, max: 900 })
    expect(manager.isVariableFamily('Static Test Fam')).toBe(false)
    expect(manager.variableWeightRange('Static Test Fam')).toBeNull()
  })

  test('evictFont 清理 VF 跟踪', () => {
    const manager = new FontManager()
    manager.markLoaded('VF Evict Fam', 'Regular', vfBuffer())
    expect(manager.isVariableFamily('VF Evict Fam')).toBe(true)
    manager.evictFont('VF Evict Fam', 'Regular')
    expect(manager.isVariableFamily('VF Evict Fam')).toBe(false)
    expect(manager.variableWeightRange('VF Evict Fam')).toBeNull()
  })
})

describe('withWeightAxisVariation（排版期 wght 轴注入，canvas/text）', () => {
  const FAMILY = 'VF Canvas Probe Fam'

  afterEach(() => {
    fontManager.evictFont(FAMILY, 'Regular')
  })

  test('非 VF 家族：variations 原样透传', () => {
    expect(withWeightAxisVariation('Never Variable Fam', 700, undefined)).toBeUndefined()
    const explicit = [{ axis: 'opsz', value: 14 }]
    expect(withWeightAxisVariation('Never Variable Fam', 700, explicit)).toBe(explicit)
  })

  test('VF 家族未显式 wght：按 fontWeight 注入并 clamp 到 fvar 区间', () => {
    fontManager.markLoaded(FAMILY, 'Regular', vfBuffer(250, 400, 900))

    expect(withWeightAxisVariation(FAMILY, 650, undefined)).toEqual([{ axis: 'wght', value: 650 }])
    expect(withWeightAxisVariation(FAMILY, 100, undefined)).toEqual([
      { axis: 'wght', value: 250 } // clamp 下界
    ])
    expect(withWeightAxisVariation(FAMILY, 1200, undefined)).toEqual([
      { axis: 'wght', value: 900 } // clamp 上界
    ])
  })

  test('显式 wght 优先不被覆盖；其他轴与注入并存', () => {
    fontManager.markLoaded(FAMILY, 'Regular', vfBuffer(250, 400, 900))

    const explicit = [{ axis: 'wght', value: 500 }]
    expect(withWeightAxisVariation(FAMILY, 700, explicit)).toBe(explicit)
    expect(withWeightAxisVariation(FAMILY, 700, [{ axis: 'opsz', value: 14 }])).toEqual([
      { axis: 'opsz', value: 14 },
      { axis: 'wght', value: 700 }
    ])
  })
})
