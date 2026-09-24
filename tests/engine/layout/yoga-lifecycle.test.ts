import { describe, expect, test } from 'bun:test'

import Yoga, { Direction } from 'yoga-layout'

import { computeLayout, SceneGraph, setTextMeasurer } from '@open-pencil/core'

import { autoFrame, pageId } from '#tests/helpers/layout'

describe('yoga node lifecycle', () => {
  test('layout tree is fully freed when measure throws (create/free symmetry)', () => {
    const graph = new SceneGraph()
    const frame = autoFrame(graph, pageId(graph), { width: 200, height: 100 })
    graph.createNode('TEXT', frame.id, {
      text: 'boom',
      width: 50,
      height: 20,
      textAutoResize: 'WIDTH_AND_HEIGHT'
    })

    const probeNode = Yoga.Node.create()
    const proto = Object.getPrototypeOf(probeNode) as { free(): void }
    probeNode.free()

    let creates = 0
    let frees = 0
    const origCreate = Yoga.Node.create
    const origFree = proto.free
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Yoga.Node as any).create = (...args: Parameters<typeof Yoga.Node.create>) => {
      creates++
      return origCreate(...args)
    }
    proto.free = function (this: unknown) {
      frees++
      return origFree.call(this as never)
    }
    try {
      setTextMeasurer(() => {
        throw new Error('measure boom')
      })
      expect(() => computeLayout(graph, frame.id)).toThrow(/boom/)
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(Yoga.Node as any).create = origCreate
      proto.free = origFree
      setTextMeasurer(null)
    }

    expect(creates).toBeGreaterThan(0)
    expect(frees).toBe(creates)
  })

  test('node free is idempotent — a second free never touches the WASM heap', () => {
    const a = Yoga.Node.create()
    a.free()
    expect(() => a.free()).not.toThrow()

    // 双重 free 若损坏分配器，后续建树/布局/释放会在 WASM 内抛 OOB
    const root = Yoga.Node.create()
    const child = Yoga.Node.create()
    child.setMeasureFunc(() => ({ width: 5, height: 5 }))
    root.insertChild(child, 0)
    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(child.getComputedWidth()).toBe(5)
    child.free()
    root.free()
  })
})
