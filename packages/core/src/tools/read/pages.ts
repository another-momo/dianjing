import * as v from 'valibot'

import { computeBounds } from '@open-pencil/scene-graph/geometry'

import type { FigmaAPI, FigmaNodeProxy } from '#core/figma-api'
import type { ThumbnailPage } from '#core/io/formats/fig/thumbnail-page'
import { defineTool } from '#core/tools/schema'

// 形状与 io/formats/fig/thumbnail-page.ts ThumbnailPage 同构——并型复用，
// 重复字面量形状过不了 test:type-shapes 门禁
export type PageCandidate = ThumbnailPage

/**
 * Outcome of resolving a user-supplied page reference (id, name, or omitted).
 *
 * - `page` is set on success; the caller uses it as the search/operation scope.
 * - `error` + `candidates` is set on failure or ambiguity; the caller surfaces the
 *   error and the candidate list so the agent can disambiguate.
 *
 * Shared across `find_nodes` and `query_nodes` so the two read tools agree on
 * the page addressing contract: pageId is authoritative, page name is a
 * convenience alias that errors on duplicates, omitting `page` keeps the old
 * default (the current page).
 */
export type ResolvedPage =
  | { page: FigmaNodeProxy; candidates?: undefined }
  | { page?: undefined; error: string; candidates: PageCandidate[] }

/**
 * Resolve a `page` argument to a single page proxy.
 *
 *   undefined / ''   → figma.currentPage
 *   exact pageId     → that page (must be a CANVAS; ids don't collide)
 *   exact name match → the single page with that name, or an error listing
 *                       candidates (zero, or two-or-more)
 *
 * Page ids are exact match only — passing an id that resolves to a non-page
 * node falls through to the name lookup and reports not-found, so the agent
 * never silently lands on the wrong scope.
 */
export function resolvePage(figma: FigmaAPI, pageRef: string | undefined): ResolvedPage {
  if (pageRef === undefined || pageRef === '') {
    return { page: figma.currentPage }
  }

  const allPages = figma.root.children

  const byId = figma.getNodeById(pageRef)
  if (byId?.type === 'CANVAS') {
    return { page: byId }
  }

  const byName = allPages.filter((p) => p.name === pageRef)
  const candidates: PageCandidate[] = allPages.map((p) => ({ id: p.id, name: p.name }))
  if (byName.length === 1) {
    return { page: byName[0] }
  }
  if (byName.length === 0) {
    return { error: `Page "${pageRef}" not found`, candidates }
  }
  return {
    error: `Multiple pages named "${pageRef}" — pass the pageId from the candidates instead`,
    candidates: byName.map((p) => ({ id: p.id, name: p.name }))
  }
}

export const listPages = defineTool({
  name: 'list_pages',
  description: 'List all pages in the document.',
  execution: { kind: 'sync', mutation: 'none' },
  input: v.object({}),
  execute: (figma) => {
    const pages = figma.root.children
    return {
      current: figma.currentPage.name,
      pages: pages.map((page) => ({ id: page.id, name: page.name }))
    }
  }
})

export const switchPage = defineTool({
  name: 'switch_page',

  description: 'Switch to a different page by name or ID.',
  execution: { kind: 'sync', mutation: 'view' },
  input: v.object({
    page: v.pipe(v.string(), v.description('Page name or ID'))
  }),
  execute: (figma, { page }) => {
    const target =
      figma.root.children.find((candidate) => candidate.name === page) ?? figma.getNodeById(page)
    if (!target) return { error: `Page "${page}" not found` }
    figma.currentPage = target
    return { page: target.name, id: target.id }
  }
})

export const getCurrentPage = defineTool({
  name: 'get_current_page',
  description: 'Get the current page name and ID.',
  execution: { kind: 'sync', mutation: 'none' },
  input: v.object({}),
  execute: (figma) => {
    return { id: figma.currentPage.id, name: figma.currentPage.name }
  }
})

export const pageBounds = defineTool({
  name: 'page_bounds',
  description: 'Get bounding box of all objects on the current page.',
  execution: { kind: 'sync', mutation: 'none' },
  exposure: { webmcp: false },
  input: v.object({}),
  execute: (figma) => {
    return computeBounds(figma.currentPage.children.map((child) => child.absoluteBoundingBox))
  }
})
