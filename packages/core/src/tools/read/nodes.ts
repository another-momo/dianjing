import * as v from 'valibot'

import type { FigmaNodeProxy } from '#core/figma-api'
import { toolNumber, nodeIdInput } from '#core/tools/input'
import { defineTool, nodeSummary, nodeToResult } from '#core/tools/schema'

import { resolvePage } from './pages'

interface TreeEntry {
  id: string
  type: string
  name: string
  w: number
  h: number
  children?: TreeEntry[]
}

function nodeToTreeEntry(
  node: FigmaNodeProxy,
  level: number,
  maxDepth?: number,
  typeFilter?: Set<string>
): TreeEntry | null {
  const children: TreeEntry[] = []
  if ((maxDepth === undefined || level < maxDepth) && node.children.length > 0) {
    for (const child of node.children) {
      const entry = nodeToTreeEntry(child, level + 1, maxDepth, typeFilter)
      if (entry) children.push(entry)
    }
  }

  const matches = !typeFilter || typeFilter.has(node.type)
  if (!matches && children.length === 0) return null

  const entry: TreeEntry = {
    id: node.id,
    type: node.type,
    name: node.name,
    w: node.width,
    h: node.height
  }
  if (children.length > 0) entry.children = children
  return entry
}

export const getPageTree = defineTool({
  name: 'get_page_tree',
  description:
    'Get the node tree of the current page. Returns lightweight hierarchy: id, type, name, size. Use depth, root_id, or node_types to keep large pages small. Use get_node for full properties of a specific node.',
  execution: { kind: 'sync', mutation: 'none' },
  input: v.object({
    depth: v.optional(
      toolNumber(
        v.pipe(
          v.number(),
          v.minValue(1),
          v.description(
            'Max nesting depth to return (1 = returned root nodes only). Default: unlimited'
          )
        )
      )
    ),
    root_id: v.optional(
      v.pipe(
        v.string(),
        v.description('Return only this node subtree instead of the whole current page')
      )
    ),
    node_types: v.optional(
      v.pipe(
        v.array(v.string()),
        v.minLength(1),
        v.description('Keep only these node types and their ancestors, for example FRAME or TEXT')
      )
    )
  }),
  execute: (figma, { depth, root_id, node_types }) => {
    const typeFilter = node_types && node_types.length > 0 ? new Set(node_types) : undefined

    if (root_id !== undefined) {
      const root = figma.getNodeById(root_id)
      if (!root) return { error: `Node "${root_id}" not found` }
      return { root: root.id, tree: nodeToTreeEntry(root, 1, depth, typeFilter) }
    }

    const page = figma.currentPage
    const children: TreeEntry[] = []
    for (const child of page.children) {
      const entry = nodeToTreeEntry(child, 1, depth, typeFilter)
      if (entry) children.push(entry)
    }
    return { page: page.name, children }
  }
})

export const getNode = defineTool({
  name: 'get_node',
  description:
    'Get detailed properties of a node by ID. Use depth to limit child recursion (0 = node only, 1 = direct children, etc). Default: unlimited.',
  execution: { kind: 'sync', mutation: 'none' },
  input: v.object({
    id: nodeIdInput,
    depth: v.optional(
      toolNumber(
        v.pipe(
          v.number(),
          v.description('Max depth of children to include (0 = no children). Default: unlimited')
        )
      )
    )
  }),
  execute: (figma, { id, depth }) => {
    const node = figma.getNodeById(id)
    if (!node) return { error: `Node "${id}" not found` }
    return nodeToResult(node, depth)
  }
})

export const findNodes = defineTool({
  name: 'find_nodes',
  description:
    'Find nodes by name pattern and/or type. Defaults to the current page; pass `page` (page id from list_pages, or an unambiguous page name) to scope the search to a specific page. Use this for simple within-page lookups by name/type; use query_nodes for XPath selectors or when you need to scan pages other than the current one. Call when the user asks to locate nodes on a specific page or to filter by name/type.',
  execution: { kind: 'sync', mutation: 'none' },
  input: v.object({
    name: v.optional(
      v.pipe(v.string(), v.description('Name substring to match (case-insensitive)'))
    ),
    type: v.optional(
      v.pipe(
        v.picklist([
          'FRAME',
          'RECTANGLE',
          'ELLIPSE',
          'TEXT',
          'LINE',
          'STAR',
          'POLYGON',
          'SECTION',
          'GROUP',
          'COMPONENT',
          'INSTANCE',
          'VECTOR'
        ]),
        v.description('Node type filter')
      )
    ),
    page: v.optional(
      v.pipe(
        v.string(),
        v.description(
          'Page id (preferred) or unambiguous page name to scope the search to. Omit to search the current page.'
        )
      )
    )
  }),
  execute: (figma, args) => {
    const resolved = resolvePage(figma, args.page)
    if ('error' in resolved) {
      return { error: resolved.error, candidates: resolved.candidates }
    }
    const page = resolved.page
    const matches = page.findAll((node) => {
      if (args.type && node.type !== args.type) return false
      if (args.name && !node.name.toLowerCase().includes(args.name.toLowerCase())) return false
      return true
    })
    return {
      count: matches.length,
      page: page.name,
      pageId: page.id,
      nodes: matches.map(nodeSummary)
    }
  }
})
