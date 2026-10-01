/**
 * DOM 水表钉扎（src/components/assistant/dom-meters.ts）。
 *
 * 覆盖：变化门控判定矩阵、createDomMeter 采样状态机（首笔基线 / 门控内
 * 不记 / 达门控记 delta / 心跳强制记 / 心跳后重置）、startDomMeters 的
 * 无 document 环境守卫（非渲染层运行时 no-op 化不排定时器）。生产接线
 * （真实 document 采样 + setInterval）不在 bun 环境覆盖——渲染层行为由
 * 收口门禁 typecheck + L3 实测兜底。
 */

import { describe, expect, test } from 'bun:test'

import {
  createDomMeter,
  passedChangeGate,
  startDomMeters,
  type DomSampleRecord
} from '@/components/assistant/dom-meters'

describe('passedChangeGate 变化门控', () => {
  test('previous=0 无基数：任何非零计为变化，双方皆 0 不记', () => {
    expect(passedChangeGate(0, 0, 0.1)).toBe(false)
    expect(passedChangeGate(0, 1, 0.1)).toBe(true)
  })

  test('相对变化达阈值才记（涨跌对称、恰在阈值记）', () => {
    expect(passedChangeGate(1000, 1099, 0.1)).toBe(false)
    expect(passedChangeGate(1000, 1100, 0.1)).toBe(true)
    expect(passedChangeGate(1000, 901, 0.1)).toBe(false)
    expect(passedChangeGate(1000, 900, 0.1)).toBe(true)
    expect(passedChangeGate(1000, 1000, 0.1)).toBe(false)
  })
})

describe('createDomMeter 采样状态机', () => {
  function makeHarness() {
    let current = 0
    let now = 0
    const recorded: Array<{ scope: string; nodes: number; delta: number | null }> = []
    const record: DomSampleRecord = (scope, nodes, delta) => {
      recorded.push({ scope, nodes, delta })
    }
    const meter = createDomMeter({
      scope: 'chat-transcript',
      changeGate: 0.1,
      heartbeatMs: 300_000,
      sample: () => current,
      now: () => now,
      record
    })
    return {
      meter,
      recorded,
      setNodes: (nodes: number) => {
        current = nodes
      },
      advance: (ms: number) => {
        now += ms
      }
    }
  }

  test('首笔必记（null delta 基线）', () => {
    const h = makeHarness()
    h.setNodes(1000)
    h.meter.tick()
    expect(h.recorded).toEqual([{ scope: 'chat-transcript', nodes: 1000, delta: null }])
  })

  test('变化低于门控不记', () => {
    const h = makeHarness()
    h.setNodes(1000)
    h.meter.tick()
    h.setNodes(1090)
    h.advance(60_000)
    h.meter.tick()
    expect(h.recorded).toHaveLength(1)
  })

  test('变化达门控记 delta（相对上次记录值）', () => {
    const h = makeHarness()
    h.setNodes(1000)
    h.meter.tick()
    h.setNodes(1200)
    h.advance(60_000)
    h.meter.tick()
    expect(h.recorded).toEqual([
      { scope: 'chat-transcript', nodes: 1000, delta: null },
      { scope: 'chat-transcript', nodes: 1200, delta: 200 }
    ])
  })

  test('心跳到期强制记一笔（无变化也记，重置心跳窗）', () => {
    const h = makeHarness()
    h.setNodes(1000)
    h.meter.tick()
    h.setNodes(1004)
    h.advance(60_000)
    h.meter.tick()
    expect(h.recorded).toHaveLength(1)
    h.advance(240_000)
    h.meter.tick()
    expect(h.recorded).toHaveLength(2)
    expect(h.recorded[1]).toEqual({ scope: 'chat-transcript', nodes: 1004, delta: 4 })
    h.setNodes(1008)
    h.advance(60_000)
    h.meter.tick()
    expect(h.recorded).toHaveLength(2)
  })

  test('门控与心跳同时命中只记一笔', () => {
    const h = makeHarness()
    h.setNodes(1000)
    h.meter.tick()
    h.setNodes(2000)
    h.advance(300_000)
    h.meter.tick()
    expect(h.recorded).toEqual([
      { scope: 'chat-transcript', nodes: 1000, delta: null },
      { scope: 'chat-transcript', nodes: 2000, delta: 1000 }
    ])
  })
})

describe('startDomMeters 生产接线守卫', () => {
  test('无 document 环境 no-op 化：返回 stop 函数、不排定时器不采样', () => {
    const stop = startDomMeters()
    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
  })
})
