import { beforeAll, describe, expect, test } from 'bun:test'

import { exportFigFile, initCodec, SceneGraph } from '@open-pencil/core'
import { parseFigBuffer } from '@open-pencil/fig'

import { expectDefined } from '#tests/helpers/assert'

describe('.fig thumbnail fallback (render-decoupled save chain)', () => {
  beforeAll(async () => {
    await initCodec()
  })

  test('exportFigFile without CanvasKit still produces a 1×1 PNG thumbnail', async () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    graph.createNode('RECTANGLE', page.id, {
      name: 'Visible node',
      width: 80,
      height: 80,
      fills: [
        {
          type: 'SOLID',
          color: { r: 0, g: 0, b: 0, a: 1 },
          opacity: 1,
          visible: true
        }
      ]
    })

    // No ck / no renderer: renderFigThumbnail must skip the live-render path
    // and emit the placeholder bytes rather than throwing.
    const exported = await exportFigFile(graph)
    const parsed = parseFigBuffer(
      exported.buffer.slice(
        exported.byteOffset,
        exported.byteOffset + exported.byteLength
      ) as ArrayBuffer
    )
    const thumbnail = expectDefined(parsed.thumbnailPNG, 'thumbnail PNG')

    expect(thumbnail.byteLength).toBeGreaterThan(0)
    // Verify the PNG signature (89 50 4E 47 0D 0A 1A 0A) — anything else means
    // we no longer emit a valid PNG and downstream readers (Figma importer)
    // will reject the archive.
    const pngSignature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    expect(thumbnail.subarray(0, pngSignature.length)).toEqual(pngSignature)
  })

  test('exportFigFile still finishes when the document has zero pages that can produce a thumbnail', async () => {
    const graph = new SceneGraph()
    // Empty graph (no children on the default page): renderFigThumbnail early
    // returns THUMBNAIL_1X1 via the pageId branch and the save must still
    // complete.
    const exported = expectDefined(await exportFigFile(graph), 'exported archive')
    expect(exported.byteLength).toBeGreaterThan(0)
  })
})
