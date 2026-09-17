import { uniq } from 'es-toolkit/array'
import * as v from 'valibot'

import { defineTool } from '#core/tools/schema'

export const getFontStatus = defineTool({
  name: 'get_font_status',
  description:
    'Report whether fonts used on the current page are faithfully available. Returns requested ' +
    'faces, their loaded source, active substitutions, and affected nodes.',
  execution: { kind: 'sync', mutation: 'none' },
  exposure: { webmcp: false },
  input: v.object({}),
  execute: (figma) => figma.getFontStatus()
})

export const listFonts = defineTool({
  name: 'list_fonts',
  description: 'List fonts used in the current page.',
  execution: { kind: 'sync', mutation: 'none' },
  exposure: { webmcp: false },
  input: v.object({
    family: v.optional(v.pipe(v.string(), v.description('Filter by family name (substring)')))
  }),
  execute: (figma, args) => {
    const fonts = new Map<string, Set<number>>()
    const page = figma.currentPage
    page.findAll((node) => {
      if (node.type === 'TEXT') {
        const raw = figma.graph.getNode(node.id)
        if (raw) {
          const key = raw.fontFamily
          if (!fonts.has(key)) fonts.set(key, new Set())
          fonts.get(key)?.add(raw.fontWeight)
        }
      }
      return false
    })
    let result = [...fonts.entries()].map(([family, weights]) => ({
      family,
      weights: [...weights].sort((a, b) => a - b)
    }))
    if (args.family) {
      const q = args.family.toLowerCase()
      result = result.filter((font) => font.family.toLowerCase().includes(q))
    }
    return { count: result.length, fonts: result }
  }
})

export const listAvailableFonts = defineTool({
  name: 'list_available_fonts',
  description:
    'List font families available for rendering — bundled fonts plus enabled online font ' +
    'sources and host-exposed local fonts. Use this to pick a family before set_font; ' +
    'distinct from list_fonts which only reports families currently used in the page.',
  execution: { kind: 'async', mutation: 'none' },
  exposure: { webmcp: false },
  input: v.object({
    family: v.optional(
      v.pipe(v.string(), v.description('Filter by family name (substring, case-insensitive)'))
    )
  }),
  execute: async (figma, args) => {
    const fonts = await figma.listAvailableFontsAsync()
    let families = uniq(fonts.map((font) => font.fontName.family))
    if (args.family) {
      const q = args.family.toLowerCase()
      families = families.filter((family) => family.toLowerCase().includes(q))
    }
    families.sort((a, b) => a.localeCompare(b))
    // 空结果给说明——无枚举面的运行时（默认 stub / 浏览器未授权本地字体）返回 []，
    // 不给 note 的话 agent 无法区分「没有字体」与「此运行时不提供枚举」
    if (families.length === 0) {
      return {
        count: 0,
        fonts: families,
        note: 'No fonts enumerated — the host may not expose a font list in this runtime.'
      }
    }
    return { count: families.length, fonts: families }
  }
})
