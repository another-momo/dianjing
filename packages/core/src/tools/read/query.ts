import * as v from 'valibot'

import { toolNumber } from '#core/tools/input'
import { defineTool } from '#core/tools/schema'
import { queryByXPath } from '#core/xpath'

import { resolvePage } from './pages'

export const queryNodes = defineTool({
  name: 'query_nodes',
  description: `Query nodes using XPath selectors. Defaults to the current page; pass \`page\` (page id from list_pages, or an unambiguous page name) to scope the query to a specific page. Use this for cross-page XPath traversal or when find_nodes' name/type filters aren't expressive enough.

Node types are element names (FRAME, TEXT, RECTANGLE, ELLIPSE, etc.). Attributes: name, width, height, x, y, visible, opacity, cornerRadius, fontSize, fontFamily, fontWeight, layoutMode, itemSpacing, paddingTop/Right/Bottom/Left, strokeWeight, rotation, locked, blendMode, text, lineHeight, letterSpacing.

Examples:
//FRAME — all frames
//FRAME[@width < 300] — frames narrower than 300px
//COMPONENT[starts-with(@name, 'Button')] — components starting with "Button"
//SECTION/FRAME — direct frame children of sections
//SECTION//TEXT — all text nodes inside sections
//*[@cornerRadius > 0] — any node with corner radius
//TEXT[contains(@text, 'Hello')] — text nodes containing "Hello"

Call when the user asks for an XPath-style query or when the lookup needs filters beyond name/type.`,
  execution: { kind: 'async', mutation: 'none' },
  exposure: { webmcp: false },
  input: v.object({
    selector: v.pipe(v.string(), v.description('XPath selector')),
    page: v.optional(
      v.pipe(
        v.string(),
        v.description(
          'Page id (preferred) or unambiguous page name to scope the query to. Omit to query the current page.'
        )
      )
    ),
    limit: v.optional(toolNumber(v.pipe(v.number(), v.description('Max results (default: 1000)'))))
  }),
  execute: async (figma, args) => {
    const resolved = resolvePage(figma, args.page)
    if ('error' in resolved) {
      return { error: resolved.error, candidates: resolved.candidates }
    }
    try {
      const nodes = await queryByXPath(figma.graph, args.selector, {
        // id 下穿到查询层——按名过滤会让「重名页传 id」退化为同名页全命中
        pageId: resolved.page.id,
        limit: args.limit
      })
      return {
        count: nodes.length,
        page: resolved.page.name,
        pageId: resolved.page.id,
        nodes: nodes.map((node) => ({ id: node.id, name: node.name, type: node.type }))
      }
    } catch (err) {
      return { error: `XPath error: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
})
