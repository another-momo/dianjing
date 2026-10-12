/**
 * render-jsx.md「Canonical examples」节的可渲染锁——示例即教学真源，
 * 渲染器演进使示例失效时本测试转红，防教学文档悄悄腐烂（对应上游
 * reference.test.ts 对 AUTHORING_EXAMPLES 的锁；我方示例真源在 md，故直锁 md）。
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderJSX } from '@open-pencil/core'

import { makeSceneGraph } from '#tests/helpers/scene'

const MD = join(__dirname, '../../../../src/app/ai/pi-backend/studio/references/render-jsx.md')

/** 提取「Canonical examples」节内的全部 ```jsx 围栏代码块。 */
function extractExampleBlocks(md: string): string[] {
  const section = md.split('## Canonical examples')[1]
  if (!section) throw new Error('render-jsx.md missing "## Canonical examples" section')
  const blocks: string[] = []
  for (const m of section.matchAll(/```jsx\n([\s\S]*?)```/g)) blocks.push(m[1].trim())
  return blocks
}

describe('render-jsx.md canonical examples', () => {
  const blocks = extractExampleBlocks(readFileSync(MD, 'utf8'))

  it('至少提取到一个示例块', () => {
    expect(blocks.length).toBeGreaterThan(0)
  })

  for (const [i, jsx] of blocks.entries()) {
    it(`示例 ${i + 1} 可渲染为单根节点`, async () => {
      const graph = makeSceneGraph()
      const roots = await renderJSX(graph, jsx)
      expect(roots).toHaveLength(1)
    })
  }
})
