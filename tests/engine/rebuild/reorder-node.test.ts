import { describe, expect, test } from 'bun:test'

import { expectDefined } from '#tests/helpers/assert'
import { getTool, setupToolTest, type ToolResult } from '#tests/helpers/tools'

type Figma = ReturnType<typeof setupToolTest>['figma']

/** Builds a frame with `childCount` rectangle children in append order. */
function makeFrame(figma: Figma, childCount: number): { frameId: string; childIds: string[] } {
  const frame = figma.createFrame()
  const childIds: string[] = []
  for (let i = 0; i < childCount; i++) {
    const child = figma.createRectangle()
    frame.appendChild(child)
    childIds.push(child.id)
  }
  return { frameId: frame.id, childIds }
}

function childOrder(figma: Figma, frameId: string): string[] {
  const frame = expectDefined(figma.getNodeById(frameId), 'frame')
  return frame.children.map((child) => child.id)
}

describe('reorder_node', () => {
  test('moves a node up within the same parent via before_id', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const { frameId, childIds } = makeFrame(figma, 4)
    const [a, b, c, d] = childIds

    // [a, b, c, d] -> move b before d -> [a, c, b, d]
    const result = tool.execute(figma, { id: b, before_id: d }) as ToolResult

    expect(result.error).toBeUndefined()
    expect(result.id).toBe(b)
    expect(result.parent_id).toBe(frameId)
    expect(result.index).toBe(2)
    expect(childOrder(figma, frameId)).toEqual([a, c, b, d])
  })

  test('moves a node down within the same parent via after_id (remove-then-insert shift)', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const { frameId, childIds } = makeFrame(figma, 4)
    const [a, b, c, d] = childIds

    // [a, b, c, d] -> move a after c -> [b, c, a, d]
    const result = tool.execute(figma, { id: a, after_id: c }) as ToolResult

    expect(result.error).toBeUndefined()
    expect(result.index).toBe(2)
    expect(childOrder(figma, frameId)).toEqual([b, c, a, d])
  })

  test('moves a node down via before_id without shifting when it sits after the anchor', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const { frameId, childIds } = makeFrame(figma, 4)
    const [a, b, c, d] = childIds

    // [a, b, c, d] -> move d before b -> [a, d, b, c]
    const result = tool.execute(figma, { id: d, before_id: b }) as ToolResult

    expect(result.error).toBeUndefined()
    expect(result.index).toBe(1)
    expect(childOrder(figma, frameId)).toEqual([a, d, b, c])
  })

  test('moves a node to another parent and places it before a sibling anchor', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const source = makeFrame(figma, 3)
    const target = makeFrame(figma, 2)
    const [a, b, c] = source.childIds
    const [x, y] = target.childIds

    // target [x, y] -> move b before y -> source [a, c], target [x, b, y]
    const result = tool.execute(figma, {
      id: b,
      parent_id: target.frameId,
      before_id: y
    }) as ToolResult

    expect(result.error).toBeUndefined()
    expect(result.parent_id).toBe(target.frameId)
    expect(result.index).toBe(1)
    expect(childOrder(figma, target.frameId)).toEqual([x, b, y])
    expect(childOrder(figma, source.frameId)).toEqual([a, c])
  })

  test('places a node first and last via position', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const { frameId, childIds } = makeFrame(figma, 3)
    const [a, b, c] = childIds

    // [a, b, c] -> move c first -> [c, a, b]
    const first = tool.execute(figma, { id: c, position: 'first' }) as ToolResult
    expect(first.error).toBeUndefined()
    expect(first.index).toBe(0)
    expect(childOrder(figma, frameId)).toEqual([c, a, b])

    // [c, a, b] -> move c last -> [a, b, c]
    const last = tool.execute(figma, { id: c, position: 'last' }) as ToolResult
    expect(last.error).toBeUndefined()
    expect(last.index).toBe(2)
    expect(childOrder(figma, frameId)).toEqual([a, b, c])
  })

  test('converges an out-of-range index to the last position', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const { frameId, childIds } = makeFrame(figma, 3)
    const [a, b, c] = childIds

    // [a, b, c] -> move a at index 99 -> [b, c, a]
    const result = tool.execute(figma, { id: a, index: 99 }) as ToolResult

    expect(result.error).toBeUndefined()
    expect(result.index).toBe(2)
    expect(childOrder(figma, frameId)).toEqual([b, c, a])
  })

  test('rejects an anchor that is not a direct child of the target parent', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const source = makeFrame(figma, 2)
    const target = makeFrame(figma, 1)
    const [a, b] = source.childIds
    const [x] = target.childIds

    // anchor b belongs to the source frame, not the target parent
    const result = tool.execute(figma, {
      id: a,
      parent_id: target.frameId,
      after_id: b
    }) as ToolResult

    expect(result.error).toBeString()
    expect(childOrder(figma, source.frameId)).toEqual([a, b])
    expect(childOrder(figma, target.frameId)).toEqual([x])
  })

  test('rejects an anchor equal to the node itself', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const { frameId, childIds } = makeFrame(figma, 2)
    const [a, b] = childIds

    const result = tool.execute(figma, { id: a, before_id: a }) as ToolResult

    expect(result.error).toBeString()
    expect(childOrder(figma, frameId)).toEqual([a, b])
  })

  test('rejects moving a node into one of its descendants', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const outer = figma.createFrame()
    const inner = figma.createFrame()
    outer.appendChild(inner)
    const rect = figma.createRectangle()
    inner.appendChild(rect)

    const result = tool.execute(figma, {
      id: outer.id,
      parent_id: inner.id,
      position: 'last'
    }) as ToolResult

    expect(result.error).toBeString()
    expect(childOrder(figma, inner.id)).toEqual([rect.id])
  })

  test('rejects missing and duplicate position arguments', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const { frameId, childIds } = makeFrame(figma, 2)
    const [a, b] = childIds

    const none = tool.execute(figma, { id: a }) as ToolResult
    expect(none.error).toBeString()

    const multiple = tool.execute(figma, { id: a, before_id: b, position: 'first' }) as ToolResult
    expect(multiple.error).toBeString()

    expect(childOrder(figma, frameId)).toEqual([a, b])
  })

  test('rejects a node that does not exist', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')

    const result = tool.execute(figma, { id: 'missing-node', position: 'first' }) as ToolResult

    expect(result.error).toBeString()
  })

  test('rejects reordering a page node', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const frame = figma.createFrame()
    const page = expectDefined(frame.parent, 'page')

    const result = tool.execute(figma, {
      id: page.id,
      parent_id: frame.id,
      position: 'first'
    }) as ToolResult

    expect(result.error).toBeString()
    expect(childOrder(figma, page.id)).toContain(frame.id)
  })

  test('rejects a missing anchor and a missing parent', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const { frameId, childIds } = makeFrame(figma, 2)
    const [a] = childIds

    const missingAnchor = tool.execute(figma, { id: a, before_id: 'missing-anchor' }) as ToolResult
    expect(missingAnchor.error).toBeString()

    const missingParent = tool.execute(figma, {
      id: a,
      parent_id: 'missing-parent',
      position: 'first'
    }) as ToolResult
    expect(missingParent.error).toBeString()

    expect(childOrder(figma, frameId)).toEqual(childIds)
  })

  test('clamps an out-of-range low index to the first position', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const { frameId, childIds } = makeFrame(figma, 3)
    const [a, b, c] = childIds

    // [a, b, c] -> move b at index -1 -> clamps to first -> [b, a, c]
    const negative = tool.execute(figma, { id: b, index: -1 }) as ToolResult
    expect(negative.error).toBeUndefined()
    expect(negative.index).toBe(0)
    expect(childOrder(figma, frameId)).toEqual([b, a, c])

    // [b, a, c] -> move a at index 0 -> [a, b, c]
    const zero = tool.execute(figma, { id: a, index: 0 }) as ToolResult
    expect(zero.error).toBeUndefined()
    expect(childOrder(figma, frameId)).toEqual([a, b, c])
  })

  test('places a node by index in another parent without shifting', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const source = makeFrame(figma, 3)
    const target = makeFrame(figma, 2)
    const [a, b, c] = source.childIds
    const [x, y] = target.childIds

    const result = tool.execute(figma, { id: b, parent_id: target.frameId, index: 0 }) as ToolResult

    expect(result.error).toBeUndefined()
    expect(result.index).toBe(0)
    expect(childOrder(figma, target.frameId)).toEqual([b, x, y])
    expect(childOrder(figma, source.frameId)).toEqual([a, c])
  })

  test('places a node after a cross-parent anchor', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const source = makeFrame(figma, 3)
    const target = makeFrame(figma, 2)
    const [a, b, c] = source.childIds
    const [x, y] = target.childIds

    const result = tool.execute(figma, {
      id: b,
      parent_id: target.frameId,
      after_id: x
    }) as ToolResult

    expect(result.error).toBeUndefined()
    expect(childOrder(figma, target.frameId)).toEqual([x, b, y])
    expect(childOrder(figma, source.frameId)).toEqual([a, c])
  })

  test('moves a node into an empty parent via position last', () => {
    const { figma } = setupToolTest()
    const tool = getTool('reorder_node')
    const source = makeFrame(figma, 2)
    const target = makeFrame(figma, 0)
    const [a, b] = source.childIds

    const result = tool.execute(figma, {
      id: a,
      parent_id: target.frameId,
      position: 'last'
    }) as ToolResult

    expect(result.error).toBeUndefined()
    expect(result.index).toBe(0)
    expect(childOrder(figma, target.frameId)).toEqual([a])
    expect(childOrder(figma, source.frameId)).toEqual([b])
  })
})
