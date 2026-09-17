import * as v from 'valibot'

import { defineTool } from './schema'
import { applyPhoto } from './stock-photo/apply'
import { getActiveProvider } from './stock-photo/providers'
import { parsePhotoRequests } from './stock-photo/requests'

export { applyPhoto, type PhotoRequest, type PhotoResult } from './stock-photo/apply'
export { parsePhotoRequests } from './stock-photo/requests'
export {
  getStockPhotoProviders,
  registerStockPhotoProvider,
  setActiveStockPhotoProvider,
  setPexelsAPIKey,
  setUnsplashAccessKey,
  type StockPhotoProvider,
  type StockPhotoResult
} from './stock-photo/providers'

export const stockPhoto = defineTool({
  name: 'stock_photo',

  description:
    'Search stock photos and apply to leaf image placeholders or closed area geometry. ' +
    'Pass a JSON array; each item is {id, query, index?, orientation?}. ' +
    'Text, lines, and structural nodes are rejected. Containers with content are rejected — except FRAME, which takes the photo as a background fill behind its children. ' +
    'Batch ALL photos in ONE call — do not loop with repeated single calls. ' +
    'If no key is configured or the API returns 401, return the error to the user — do NOT fall back to eval-drawn gradients or rectangles as fake photos; leave placeholder colors as-is.',
  execution: { kind: 'async', mutation: 'document' },
  capabilities: ['document:write', 'network:access'],
  input: v.object({
    requests: v.pipe(
      v.string(),
      v.description(
        'JSON array: [{"id":"0:5","query":"mountain sunset"},{"id":"0:8","query":"business team","orientation":"square"}]'
      )
    )
  }),
  execute: async (figma, { requests }) => {
    const provider = getActiveProvider()
    if (!provider) {
      return {
        error: `No stock photo provider configured. Ask the user to add an API key in AI chat settings. Available providers: Pexels, Unsplash.`
      }
    }

    const reqs = parsePhotoRequests(requests)
    if ('error' in reqs) return reqs

    const results = await Promise.all(reqs.map((request) => applyPhoto(figma, provider, request)))
    const ok = results.filter((result) => result.photo).length

    return { applied: ok, failed: results.length - ok, provider: provider.name, results }
  }
})
