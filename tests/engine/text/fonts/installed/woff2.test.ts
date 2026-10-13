/**
 * woff2.ts 转码封装 round-trip 测试。
 *
 * 覆盖：
 *  - wawoff2.compress 真实 wasm 压 ttf fixture → 产物 woff2 魔数
 *  - 本封装 transcodeWoff2ToSfnt：入参必须是 woff2，否则 throw
 *  - 产物走 validate 容器检测（sfnt ttf/otf 魔数）
 *
 * 仓内无现成 woff2 fixture——用 wawoff2.compress 压出 woff2 样本做
 * round-trip。wawoff2 是 packages/core 的依赖（workspace 布局下装在
 * 包内 node_modules），从包目录锚点 createRequire 解析。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { detectContainer, validateFontBytes } from '#core/text/font/installed/validate'
import { transcodeWoff2ToSfnt } from '#core/text/font/installed/woff2'

const FIXTURE_PATH = join(import.meta.dir, '../../../../fixtures/fonts/NotoSansCJK-Test.otf')
const fixtureBytes = new Uint8Array(readFileSync(FIXTURE_PATH))

/** wawoff2 是 packages/core 的依赖；workspace 布局下装在包内 node_modules，
 * 从包目录锚点解析（根工作区无 hoist 副本）。 */
const wawoff2 = createRequire(join(import.meta.dir, '../../../../../packages/core/package.json'))(
  'wawoff2'
) as unknown as {
  decompress: (input: Uint8Array) => Promise<Uint8Array>
  compress: (input: Uint8Array) => Promise<Uint8Array>
}

describe('wawoff2 真实 wasm round-trip', () => {
  test('compress ttf → woff2 容器（wOF2 魔数）', async () => {
    const compressed = await wawoff2.compress(fixtureBytes)
    expect(detectContainer(compressed)).toBe('woff2')
  })

  test('decompress woff2 → sfnt 魔数（ttf 0x00010000 / otf OTTO）', async () => {
    const compressed = await wawoff2.compress(fixtureBytes)
    const decompressed = await wawoff2.decompress(compressed)
    expect(decompressed.byteLength).toBeGreaterThan(0)
    const view = new DataView(decompressed.buffer, decompressed.byteOffset, 4)
    const magic = view.getUint32(0)
    expect([0x00010000, 0x4f54544f]).toContain(magic)
  })

  test('round-trip：ttf → woff2 字节显著缩小（brotli 压缩）', async () => {
    const compressed = await wawoff2.compress(fixtureBytes)
    expect(compressed.byteLength).toBeLessThan(fixtureBytes.byteLength)
  })
})

describe('transcodeWoff2ToSfnt 封装', () => {
  test('woff2 入参 → 返 sfnt 字节（魔数 ttf/otf）', async () => {
    const compressed = await wawoff2.compress(fixtureBytes)
    const sfnt = await transcodeWoff2ToSfnt(compressed)
    const view = new DataView(sfnt.buffer, sfnt.byteOffset, 4)
    const magic = view.getUint32(0)
    expect([0x00010000, 0x4f54544f]).toContain(magic)
    expect(detectContainer(sfnt)).not.toBe('woff2')
    expect(detectContainer(sfnt)).not.toBe('woff')
  })

  test('转码产物走 validateFontBytes：ok 且族名提取成功', async () => {
    const compressed = await wawoff2.compress(fixtureBytes)
    const sfnt = await transcodeWoff2ToSfnt(compressed)
    const result = validateFontBytes(sfnt)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.family.length).toBeGreaterThan(0)
  })

  test('非 woff2 入参 → throw', () => {
    expect(() => transcodeWoff2ToSfnt(fixtureBytes)).toThrow(/woff2/)
  })

  test('未知魔数入参 → throw', () => {
    const bad = new Uint8Array(64)
    bad[0] = 0x12
    bad[1] = 0x34
    bad[2] = 0x56
    bad[3] = 0x78
    expect(() => transcodeWoff2ToSfnt(bad)).toThrow(/woff2/)
  })

  test('空入参 → throw（短字节）', () => {
    expect(() => transcodeWoff2ToSfnt(new Uint8Array(2))).toThrow(/woff2/)
  })

  test('产物是私有拷贝而非 WASM 堆视图（堆视图持有期会被复写——回归钉扎）', async () => {
    const compressed = await wawoff2.compress(fixtureBytes)
    const sfnt = await transcodeWoff2ToSfnt(compressed)
    // 堆视图特征：buffer 是整块 16MB 堆，远大于视图自身；私有拷贝 buffer 恰好等于内容长度
    expect(sfnt.buffer.byteLength).toBe(sfnt.byteLength)
    // 后续 decompress 不得影响已返回的产物
    const before = Buffer.from(sfnt.slice(0, 8)).toString('hex')
    await wawoff2.decompress(compressed)
    await wawoff2.decompress(compressed)
    const after = Buffer.from(sfnt.slice(0, 8)).toString('hex')
    expect(after).toBe(before)
  })
})
