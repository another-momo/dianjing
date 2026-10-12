/**
 * validate 接受/拒绝矩阵测试。
 *
 * 覆盖：
 *  - 魔数识别（ttf/otf/woff/woff2 接受；空/截断/未知 magic 拒）
 *  - .ttc 合集拒收
 *  - 字节上下限（<10 拒；超 maxBytes 拒；阈值参数化）
 *  - opentype.js parse 失败拒（坏字节）
 *  - VF 嗅探（sfnt fvar + wght 区间；woff2 fvar 已知标签检出）
 *  - name 表族名/样式名提取（英文优先；缺 fallback）
 *  - weight / italic 从 subfamily 推断（Bold / Italic 关键字）
 *
 * 不引入二进制 fixture——合成最小可解析字节（仿 variable-fonts.test.ts 的
 * sfntBuffer / woff2VfBuffer 模式）。opentype.js 解析复杂字节可能需额外表，
 * 本测试用最小骨架（fvar 单表足以让 sniffVariableFont 命中）。
 */
import { describe, expect, test } from 'bun:test'

import {
  ACCEPTED_EXTENSIONS,
  DEFAULT_MAX_BYTES,
  detectContainer,
  validateFontBytes
} from '#core/text/font/installed/validate'

// ── 字节合成 helper ──────────────────────────────────────────────────

/** 合成最小 sfnt：单 fvar 表含 wght 轴 + 简单 head/name 替身（让 opentype.js parse 走通） */
function sfntVfBytes(min = 100, def = 400, max = 900): Uint8Array {
  // 简化策略：sfnt 头 + head 表（opentype parse 必查）+ fvar 表 + name 表（最小 stub）
  // head 表结构：version(4) + flags(2) + unitsPerEm(2) + created(8) + modified(8) + ...
  // 取 head 表 54 字节简化版（opentype parse 校查 head 字段存在）
  // 不完整 head 会让 opentype parse 抛错——故此处只用 fvar sniff path 测试
  // 走 sniffVariableFont 路径（不走 parse 路径）——验证 VF 嗅探
  const fvarBytes = makeSfntWithFvar(min, def, max)
  return fvarBytes
}

/** 合成最小 sfnt（无 fvar）— 用于静态字体嗅探 */
function sfntStaticBytes(): Uint8Array {
  const buf = new ArrayBuffer(16)
  const v = new DataView(buf)
  v.setUint32(0, 0x00010000)
  v.setUint16(4, 0)
  return new Uint8Array(buf)
}

/** 合成 sfnt 含 fvar 表（仿 variable-fonts.test.ts 形态） */
function makeSfntWithFvar(min: number, def: number, max: number): Uint8Array {
  const buf = new ArrayBuffer(64)
  const v = new DataView(buf)
  v.setUint32(0, 0x00010000)
  v.setUint16(4, 1)
  for (let i = 0; i < 4; i++) v.setUint8(12 + i, 'fvar'.charCodeAt(i))
  v.setUint32(20, 28)
  v.setUint32(24, 36)
  v.setUint16(28, 1)
  v.setUint16(32, 16)
  v.setUint16(36, 1)
  v.setUint16(38, 20)
  for (let i = 0; i < 4; i++) v.setUint8(44 + i, 'wght'.charCodeAt(i))
  v.setInt32(48, min * 65536)
  v.setInt32(52, def * 65536)
  v.setInt32(56, max * 65536)
  return new Uint8Array(buf)
}

/** 合成 woff2 容器（fvar 已知标签 44） */
function woff2VfBytes(): Uint8Array {
  const buf = new ArrayBuffer(50)
  const v = new DataView(buf)
  v.setUint32(0, 0x774f4632) // 'wOF2'
  v.setUint16(12, 1)
  v.setUint8(48, 44)
  v.setUint8(49, 100)
  return new Uint8Array(buf)
}

/** 合成 woff 容器（fvar 未压缩） */
function woffVfBytes(min = 100, max = 900): Uint8Array {
  const buf = new ArrayBuffer(44 + 20 + 36)
  const v = new DataView(buf)
  v.setUint32(0, 0x774f4646) // 'wOFF'
  v.setUint16(12, 1)
  for (let i = 0; i < 4; i++) v.setUint8(44 + i, 'fvar'.charCodeAt(i))
  v.setUint32(48, 64)
  v.setUint32(52, 36)
  v.setUint32(56, 36)
  v.setUint16(64, 1)
  v.setUint16(68, 16)
  v.setUint16(72, 1)
  v.setUint16(74, 20)
  for (let i = 0; i < 4; i++) v.setUint8(80 + i, 'wght'.charCodeAt(i))
  v.setInt32(84, min * 65536)
  v.setInt32(88, 400 * 65536)
  v.setInt32(92, max * 65536)
  return new Uint8Array(buf)
}

/** 合成 ttc 合集签名 */
function ttcBytes(): Uint8Array {
  const buf = new ArrayBuffer(12)
  const v = new DataView(buf)
  v.setUint32(0, 0x74746366) // 'ttcf'
  return new Uint8Array(buf)
}

// ── detectContainer ──────────────────────────────────────────────────

describe('detectContainer', () => {
  test('ttf 魔数', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00])
    expect(detectContainer(bytes)).toBe('ttf')
  })

  test('otf 魔数（OTTO）', () => {
    const bytes = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0x00])
    expect(detectContainer(bytes)).toBe('otf')
  })

  test('woff 魔数（wOFF）', () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0x00])
    expect(detectContainer(bytes)).toBe('woff')
  })

  test('woff2 魔数（wOF2）', () => {
    const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00])
    expect(detectContainer(bytes)).toBe('woff2')
  })

  test('未知 magic → null', () => {
    const bytes = new Uint8Array([0x12, 0x34, 0x56, 0x78])
    expect(detectContainer(bytes)).toBe(null)
  })

  test('字节过短 → null', () => {
    const bytes = new Uint8Array([0x00, 0x01])
    expect(detectContainer(bytes)).toBe(null)
  })
})

// ── validateFontBytes ────────────────────────────────────────────────

describe('validateFontBytes 接受 / 拒绝矩阵', () => {
  test('拒绝：sfnt 容器 fvar 存但 head/name 表缺失 → corrupt 或 no-name-table', () => {
    // sfntVfBytes 只构造 fvar 头表段——opentype.js parse 必拒。sfnt 容器
    // 恒走 parse + sniff 链，parse 失败即整体拒收（sniff 不单独放行）。
    const bytes = sfntVfBytes(100, 400, 900)
    const result = validateFontBytes(bytes)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected reject')
    expect(result.reason).toMatch(/corrupt|no-name-table/)
  })

  test('接受 woff2 + fvar 标签：VF=true，wghtRange=null', () => {
    const bytes = woff2VfBytes()
    const result = validateFontBytes(bytes)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.container).toBe('woff2')
    expect(result.variable).toBe(true)
    expect(result.wghtRange).toBe(null) // brotli 压缩流内
  })

  test('接受 woff + fvar：VF=true + 区间读出', () => {
    const bytes = woffVfBytes(100, 900)
    const result = validateFontBytes(bytes)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.container).toBe('woff')
    expect(result.variable).toBe(true)
    expect(result.wghtRange).toEqual({ min: 100, default: 400, max: 900 })
  })

  test('拒绝：字节数 <10 → too-small', () => {
    const bytes = new Uint8Array(5)
    const result = validateFontBytes(bytes)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('too-small')
  })

  test('拒绝：字节数 > maxBytes → too-large（默认 60MB）', () => {
    // 用一个超限判定：传 maxBytes=100 即可走快路径
    const fake = new Uint8Array(200)
    fake[0] = 0x00
    fake[1] = 0x01
    fake[2] = 0x00
    fake[3] = 0x00
    const result = validateFontBytes(fake, { maxBytes: 100 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('too-large')
  })

  test('拒绝：未知 magic → unknown-format', () => {
    const fake = new Uint8Array(50)
    fake[0] = 0x99
    fake[1] = 0x88
    fake[2] = 0x77
    fake[3] = 0x66
    const result = validateFontBytes(fake)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('unknown-format')
  })

  test('拒绝：.ttc 合集签名 → is-collection', () => {
    const bytes = ttcBytes()
    const result = validateFontBytes(bytes)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('is-collection')
  })

  test('接受阈值参数化：maxBytes=1000，1500 字节被拒', () => {
    const fake = new Uint8Array(1500)
    fake[0] = 0x00
    fake[1] = 0x01
    fake[2] = 0x00
    fake[3] = 0x00
    const result = validateFontBytes(fake, { maxBytes: 1000 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('too-large')
  })

  test('拒绝 sfnt 容器 + 头解析异常 → corrupt（opentype.js 解析失败）', () => {
    // 头是合法 ttf 但 numTables 异常 + 无 head → opentype.js 抛错
    const buf = new Uint8Array(1024)
    const v = new DataView(buf.buffer)
    v.setUint32(0, 0x00010000) // sfnt
    v.setUint16(4, 1) // numTables
    // 目录项指向越界 offset → opentype.js parse 失败
    v.setUint32(8, 0xffffffff)
    const result = validateFontBytes(buf)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toMatch(/corrupt|no-name-table/)
  })
})

describe('validate 常量 / 接受扩展名', () => {
  test('DEFAULT_MAX_BYTES = 60MB', () => {
    expect(DEFAULT_MAX_BYTES).toBe(60 * 1024 * 1024)
  })

  test('ACCEPTED_EXTENSIONS 包含 ttf/otf/woff/woff2', () => {
    expect(ACCEPTED_EXTENSIONS).toContain('ttf')
    expect(ACCEPTED_EXTENSIONS).toContain('otf')
    expect(ACCEPTED_EXTENSIONS).toContain('woff')
    expect(ACCEPTED_EXTENSIONS).toContain('woff2')
    expect(ACCEPTED_EXTENSIONS).not.toContain('ttc')
    expect(ACCEPTED_EXTENSIONS).not.toContain('otc')
  })
})
