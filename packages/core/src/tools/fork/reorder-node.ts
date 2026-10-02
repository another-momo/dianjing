import * as v from 'valibot'

import type { FigmaNodeProxy } from '#core/figma-api'
import { defineTool } from '#core/tools/schema'

export const reorderNodeTool = defineTool({
  name: 'reorder_node',

  description:
    'Reorder a node among its siblings, or move it under a different parent and place it at a ' +
    'specific position. Specify exactly one of: before_id (a direct child of the target parent; ' +
    'the node is inserted before it), after_id (a direct child of the target parent; the node is ' +
    "inserted after it), position ('first' or 'last' among the target parent's children), or " +
    'index (target position among the target parent children counted after the node is removed ' +
    'from its current position). Omit parent_id to reorder within the current parent; set ' +
    'parent_id to move the node under a different parent.',
  execution: { kind: 'sync', mutation: 'document' },
  input: v.object({
    id: v.pipe(v.string(), v.description('Node ID to reorder')),
    parent_id: v.optional(
      v.pipe(
        v.string(),
        v.description('Target parent node ID. Omit to reorder within the current parent')
      )
    ),
    before_id: v.optional(
      v.pipe(
        v.string(),
        v.description('Direct child of the target parent to insert the node before')
      )
    ),
    after_id: v.optional(
      v.pipe(
        v.string(),
        v.description('Direct child of the target parent to insert the node after')
      )
    ),
    position: v.optional(
      v.pipe(
        v.picklist(['first', 'last']),
        v.description(
          "Insert at the start ('first') or end ('last') of the target parent's children"
        )
      )
    ),
    index: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.description(
          'Target position among the target parent children counted after the node is removed from its current position'
        )
      )
    )
  }),
  execute: (figma, { id, parent_id, before_id, after_id, position, index }) => {
    const given = [before_id, after_id, position, index].filter((arg) => arg !== undefined)
    if (given.length === 0) {
      return { error: 'Specify exactly one of before_id, after_id, position, or index' }
    }
    if (given.length > 1) {
      return {
        error:
          'Specify exactly one of before_id, after_id, position, or index; multiple position arguments were given'
      }
    }

    const node = figma.getNodeById(id)
    if (!node) return { error: `Node "${id}" not found` }
    if (node.type === 'CANVAS') {
      return { error: 'A page cannot be reordered — reorder elements on the page instead' }
    }

    const parent = parent_id !== undefined ? figma.getNodeById(parent_id) : node.parent
    if (!parent) {
      return parent_id !== undefined
        ? { error: `Parent "${parent_id}" not found` }
        : { error: `Node "${id}" has no parent to reorder within` }
    }

    for (let ancestor: FigmaNodeProxy | null = parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.id === node.id) {
        return { error: `Cannot move node "${id}" into itself or into one of its descendants` }
      }
    }

    const siblingIds = parent.children.map((child) => child.id)
    // -1 when the node is not a child of the target parent (cross-parent move).
    const nodeIdx = siblingIds.indexOf(node.id)
    // The engine removes the node before inserting, so when it stays under the same parent and
    // sits before the anchor, every anchor-relative index shifts by one.
    const anchorShift = (anchorIdx: number): number =>
      nodeIdx !== -1 && nodeIdx < anchorIdx ? 1 : 0

    const anchorError = (anchorId: string): string | null => {
      const anchor = figma.getNodeById(anchorId)
      if (!anchor) return `Node "${anchorId}" not found`
      if (anchor.id === id) return `Anchor node cannot be the node being moved ("${id}")`
      if (!siblingIds.includes(anchor.id)) {
        return `Node "${anchorId}" is not a direct child of parent "${parent.id}"`
      }
      return null
    }

    let idx: number
    if (position !== undefined) {
      idx = position === 'first' ? 0 : siblingIds.length
    } else if (index !== undefined) {
      idx = Math.max(0, index)
    } else if (before_id !== undefined) {
      const error = anchorError(before_id)
      if (error) return { error }
      const anchorIdx = siblingIds.indexOf(before_id)
      idx = anchorIdx - anchorShift(anchorIdx)
    } else if (after_id !== undefined) {
      const error = anchorError(after_id)
      if (error) return { error }
      const anchorIdx = siblingIds.indexOf(after_id)
      idx = anchorIdx + 1 - anchorShift(anchorIdx)
    } else {
      return { error: 'Specify exactly one of before_id, after_id, position, or index' }
    }

    parent.insertChild(idx, node)

    const finalIndex = parent.children.findIndex((child) => child.id === node.id)
    if (finalIndex === -1) {
      return { error: `Failed to move node "${id}" under parent "${parent.id}"` }
    }
    return { id: node.id, parent_id: parent.id, index: finalIndex }
  }
})
