#!/usr/bin/env bun
/**
 * Direct core/io replacement for the retired `bun open-pencil export` CLI path:
 * renders one page of a .fig fixture to PNG without going through packages/cli.
 */

import { readFile, writeFile } from 'node:fs/promises'

import { BUILTIN_IO_FORMATS, IORegistry } from '@open-pencil/core/io'
import { computeAllLayouts } from '@open-pencil/core/layout'

const io = new IORegistry(BUILTIN_IO_FORMATS)

export async function exportFixturePageToPNG(
  file: string,
  pageName: string,
  outputPath: string
): Promise<void> {
  const bytes = new Uint8Array(await readFile(file))
  const { graph } = await io.readDocument({ name: file, data: bytes })
  computeAllLayouts(graph)

  const pages = graph.getPages()
  const page = pages.find((candidate) => candidate.name === pageName)
  if (!page) {
    const available = pages.map((candidate) => `"${candidate.name}"`).join(', ')
    throw new Error(
      `Page "${pageName}" not found in ${file}. Available pages: ${available || 'none'}.`
    )
  }

  const result = await io.exportContent(
    'png',
    { graph, target: { scope: 'page', pageId: page.id } },
    { format: 'PNG', scale: 1 }
  )
  await writeFile(outputPath, result.data as Uint8Array)
}
