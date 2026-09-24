import { afterEach, describe, expect, test } from 'bun:test'

import {
  handleWindowError,
  type OobEvent,
  type ProbeEvent,
  recordYogaEvent,
  resetYogaProbe
} from '#core/layout/yoga-probe'

function fakeNode(ptr: number): object {
  return { _ptr: ptr }
}

function uniqueNode(): object {
  return fakeNode(Math.floor(Math.random() * 1e9))
}

function globalProbe(): { events: ProbeEvent[]; oob: OobEvent[] } {
  const state = (globalThis as { __YOGA_PROBE__?: { events: ProbeEvent[]; oob: OobEvent[] } })
    .__YOGA_PROBE__
  if (!state) throw new Error('probe global missing')
  return state
}

afterEach(() => {
  resetYogaProbe()
})

describe('yoga-probe ring and seq', () => {
  test('seq is monotonic across distinct nodes', () => {
    const a = uniqueNode()
    const b = uniqueNode()
    const c = uniqueNode()
    recordYogaEvent('create', a)
    recordYogaEvent('create', b)
    recordYogaEvent('create', c)
    const { events } = globalProbe()
    expect(events).toHaveLength(3)
    expect(events[0].seq).toBeLessThan(events[1].seq)
    expect(events[1].seq).toBeLessThan(events[2].seq)
  })

  test('same node re-probed yields the same seq', () => {
    const node = uniqueNode()
    recordYogaEvent('create', node)
    recordYogaEvent('measure-set', node, 'n-1')
    recordYogaEvent('free', node)
    const { events } = globalProbe()
    expect(events).toHaveLength(3)
    expect(new Set(events.map((e) => e.seq)).size).toBe(1)
    expect(events[1].nodeId).toBe('n-1')
  })

  test('ring overflow evicts the oldest event', () => {
    const capacity = 4096
    const firstNode = uniqueNode()
    recordYogaEvent('create', firstNode)
    for (let i = 0; i < capacity; i += 1) {
      recordYogaEvent('measure-set', uniqueNode(), `node-${i}`)
    }
    const { events } = globalProbe()
    expect(events.length).toBe(capacity)
    expect(events[0].nodeId).toBe('node-0')
    expect(events.some((e) => e.nodeId === undefined && e.seq === 1)).toBe(false)
  })

  test('ptr is captured when the node carries one', () => {
    const node = fakeNode(0xdeadbeef)
    recordYogaEvent('create', node)
    const { events } = globalProbe()
    expect(events[0].ptr).toBe(0xdeadbeef)
  })

  test('ptr is null when the node lacks a numeric _ptr', () => {
    const node = { _ptr: 'nope' }
    recordYogaEvent('create', node)
    const { events } = globalProbe()
    expect(events[0].ptr).toBeNull()
  })
})

describe('yoga-probe OOB capture', () => {
  test('captures events whose message contains the OOB phrase', () => {
    recordYogaEvent('create', uniqueNode())
    handleWindowError({
      message: 'memory access out of bounds at index 12',
      error: { stack: 'fake' }
    })
    const { oob } = globalProbe()
    expect(oob).toHaveLength(1)
    expect(oob[0].message).toContain('memory access out of bounds')
    expect(oob[0].recentEvents.length).toBeGreaterThan(0)
  })

  test('ignores errors whose message does not match', () => {
    handleWindowError({ message: 'TypeError: cannot read property', error: { stack: '' } })
    handleWindowError({ message: '', error: { stack: '' } })
    const { oob } = globalProbe()
    expect(oob).toHaveLength(0)
  })

  test('OOB ring is bounded by capacity (32)', () => {
    for (let i = 0; i < 40; i += 1) {
      handleWindowError({
        message: `memory access out of bounds #${i}`,
        error: { stack: '' }
      })
    }
    const { oob } = globalProbe()
    expect(oob.length).toBe(32)
    expect(oob[0].message).toBe('memory access out of bounds #8')
    expect(oob[oob.length - 1].message).toBe('memory access out of bounds #39')
  })

  test('recentEvents snapshot is bounded to last 64 events', () => {
    for (let i = 0; i < 80; i += 1) {
      recordYogaEvent('measure-set', uniqueNode(), `m-${i}`)
    }
    handleWindowError({ message: 'memory access out of bounds', error: { stack: '' } })
    const { oob } = globalProbe()
    expect(oob[0].recentEvents.length).toBe(64)
  })
})
