import { describe, expect, test } from 'bun:test'

import Yoga from 'yoga-layout'

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
    const patchableNode = Yoga.Node as { create: typeof origCreate }
    patchableNode.create = (...args: Parameters<typeof Yoga.Node.create>) => {
      creates++
      return origCreate(...args)
    }
    proto.free = function (this: unknown) {
      frees++
      return origFree.call(this)
    }
    try {
      setTextMeasurer(() => {
        throw new Error('measure boom')
      })
      expect(() => computeLayout(graph, frame.id)).toThrow(/boom/)
    } finally {
      patchableNode.create = origCreate
      proto.free = origFree
      setTextMeasurer(null)
    }

    expect(creates).toBeGreaterThan(0)
    expect(frees).toBe(creates)
  })
})
