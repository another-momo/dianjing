/**
 * T54→T66：generate_image requests 纯函数层钉扎（移植自源 image-gen/requests.ts）。
 * 验收锚（T54-plan §3.1）：尺寸/数量校验——16px 对齐、边长/纵横比/像素钳制、
 * 枚举校验与别名归一、references 形状、replace_id/id 别名。
 * T66 P4：工具 schema 化后原生数组直通（主通道）；字符串宽容解析保留为
 * 兼容降级（两类输入共用同一语义校验层）。
 */
import { describe, expect, test } from 'bun:test'

import {
  normalizeDimensions,
  normalizeSize,
  parseImageGenRequests,
  parseReferences
} from '@open-pencil/core/tools/fork/image-gen/requests'

describe('normalizeDimensions', () => {
  test('16px 对齐', () => {
    // 1008x496 像素数低于下限 655360，保宽高比继续抬升至 1168x576
    expect(normalizeDimensions(1000, 500)).toEqual({ width: 1168, height: 576 })
    expect(normalizeDimensions(1024, 1024)).toEqual({ width: 1024, height: 1024 })
  })

  test('超长边钳到 3840（保宽高比）', () => {
    const result = normalizeDimensions(8000, 4000)
    expect(result.width).toBeLessThanOrEqual(3840)
    expect(result.width / result.height).toBeCloseTo(2, 1)
  })

  test('纵横比钳到 3:1', () => {
    const result = normalizeDimensions(3000, 200)
    expect(result.width / result.height).toBeLessThanOrEqual(3.01)
  })

  test('像素下限抬升（保宽高比）', () => {
    const result = normalizeDimensions(100, 100)
    expect(result.width * result.height).toBeGreaterThanOrEqual(655_360 - 4096)
    expect(result.width).toBe(result.height)
  })
})

describe('normalizeSize', () => {
  test('非法尺寸报错（0 / 负数 / 非有限）', () => {
    expect('error' in normalizeSize(0, 100)).toBe(true)
    expect('error' in normalizeSize(100, -5)).toBe(true)
    expect('error' in normalizeSize(Number.NaN, 100)).toBe(true)
  })

  test('未调整时 adjusted=false', () => {
    const result = normalizeSize(1024, 1024)
    if ('error' in result) throw new Error('unexpected')
    expect(result.adjusted).toBe(false)
  })
})

describe('parseImageGenRequests', () => {
  test('空数组拒绝', () => {
    const result = parseImageGenRequests('[]')
    expect('error' in result && result.error).toContain('Empty requests array')
  })

  test('非法 JSON 拒绝', () => {
    const result = parseImageGenRequests('[{"prompt":')
    expect('error' in result).toBe(true)
  })

  test('每条需要非空 prompt', () => {
    const result = parseImageGenRequests('[{"width":1024,"height":1024}]')
    expect('error' in result && result.error).toContain('prompt')
  })

  test('新图必须有数值 width/height（数量校验）', () => {
    const result = parseImageGenRequests('[{"prompt":"hero"}]')
    expect('error' in result && result.error).toContain('width')
  })

  test('带 replace_id 可省略尺寸（从目标节点读取）', () => {
    const result = parseImageGenRequests('[{"prompt":"hero","replace_id":"0:7"}]')
    if ('error' in result) throw new Error(result.error)
    expect(result.requests[0].replaceId).toBe('0:7')
    expect(result.requests[0].width).toBeUndefined()
  })

  test('请求面保留原始尺寸，API 归一只进 sizeNote', () => {
    const result = parseImageGenRequests('[{"prompt":"hero","width":1000,"height":500}]')
    if ('error' in result) throw new Error(result.error)
    // 节点尺寸 = agent 原始请求值；16px 对齐 + 像素钳制（1000x500 → 1168x576）
    // 只作用于生图调用的 API size（apply.ts resolveOutputTarget 落图前归一）
    expect(result.requests[0].width).toBe(1000)
    expect(result.requests[0].height).toBe(500)
    expect(result.sizeNote).toContain('1000x500 → 1168x576')
  })

  test('quality 枚举校验 + hd→auto 别名', () => {
    const bad = parseImageGenRequests(
      '[{"prompt":"a","width":1024,"height":1024,"quality":"ultra"}]'
    )
    expect('error' in bad && bad.error).toContain('Invalid quality')
    const aliased = parseImageGenRequests(
      '[{"prompt":"a","width":1024,"height":1024,"quality":"hd"}]'
    )
    if ('error' in aliased) throw new Error(aliased.error)
    expect(aliased.requests[0].quality).toBe('auto')
  })

  test('output_format/background 枚举校验', () => {
    const badFormat = parseImageGenRequests(
      '[{"prompt":"a","width":1024,"height":1024,"output_format":"gif"}]'
    )
    expect('error' in badFormat && badFormat.error).toContain('Invalid output_format')
    const badBackground = parseImageGenRequests(
      '[{"prompt":"a","width":1024,"height":1024,"background":"transparent"}]'
    )
    expect('error' in badBackground && badBackground.error).toContain('Invalid background')
  })

  test('尾部垃圾打捞（warning 而非报错）', () => {
    const result = parseImageGenRequests('[{"prompt":"a","width":1024,"height":1024}]"}')
    if ('error' in result) throw new Error(result.error)
    expect(result.warning).toContain('Trailing garbage')
  })

  test('单对象（非数组）按单条处理', () => {
    const result = parseImageGenRequests('{"prompt":"a","width":1024,"height":1024}')
    if ('error' in result) throw new Error(result.error)
    expect(result.requests).toHaveLength(1)
  })
})

describe('parseImageGenRequests（T66 P4：原生数组通道——schema 化后运行时交付形状）', () => {
  test('数组输入直通语义校验（尺寸归一 + 枚举 + replace_id）', () => {
    const result = parseImageGenRequests([
      { prompt: 'hero', width: 1000, height: 500, quality: 'high', output_format: 'webp' },
      { prompt: 'swap', replace_id: '0:7', references: [{ id: '0:7' }] }
    ])
    if ('error' in result) throw new Error(result.error)
    expect(result.requests).toHaveLength(2)
    expect(result.requests[0].width).toBe(1000)
    expect(result.requests[0].quality).toBe('high')
    expect(result.requests[1].replaceId).toBe('0:7')
    expect(result.requests[1].references).toEqual([{ id: '0:7' }])
  })

  test('数组输入的空数组/坏条目同样拒绝', () => {
    expect('error' in (parseImageGenRequests([]) as { error: string })).toBe(true)
    const bad = parseImageGenRequests([
      { prompt: 'a', width: 1024, height: 1024, quality: 'ultra' }
    ])
    expect('error' in bad && bad.error).toContain('Invalid quality')
    const noDims = parseImageGenRequests([{ prompt: 'a' }])
    expect('error' in noDims && noDims.error).toContain('width')
  })
})

describe('parseReferences', () => {
  test('缺省/空 = 空数组', () => {
    expect(parseReferences(undefined)).toEqual([])
    expect(parseReferences(null)).toEqual([])
  })

  test('字符串 id 与 {id, composite} 两种形态；asImage 旧别名', () => {
    const refs = parseReferences([
      '0:1',
      { id: '0:2', composite: true },
      { id: '0:3', asImage: true }
    ])
    expect(refs).toEqual([
      { id: '0:1' },
      { id: '0:2', composite: true },
      { id: '0:3', composite: true }
    ])
  })

  test('非数组/坏条目拒绝', () => {
    expect('error' in (parseReferences('0:1') as { error: string })).toBe(true)
    expect('error' in (parseReferences([{ name: 'x' }]) as { error: string })).toBe(true)
    expect('error' in (parseReferences(['  ']) as { error: string })).toBe(true)
  })
})
