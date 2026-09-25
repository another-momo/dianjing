import { expect, test } from 'bun:test'

import { effectScope } from 'vue'

import { fontFaceDemand, fontManager, fontResolver } from '@open-pencil/core/text'
import type { SceneNode } from '@open-pencil/scene-graph'
import { useNodeFontStatus } from '@open-pencil/vue'

const FAMILY = 'NodeFontStatus Probe Family'
const EVICT_FAMILY = 'NodeFontStatus Evict Probe Family'

function textNode(family: string): SceneNode {
  return { type: 'TEXT', fontFamily: family, styleRuns: [] } as unknown as SceneNode
}

test('字体加载结算后 missing 徽标自动消除（非响应式 fontManager 经 resolver 事件驱动重算）', async () => {
  fontResolver.reset(fontFaceDemand(FAMILY, 'Regular').key)
  const scope = effectScope()
  try {
    const status = scope.run(() => useNodeFontStatus(() => textNode(FAMILY)))
    if (!status) throw new Error('Missing scope')

    expect(status.missingFonts.value).toEqual([FAMILY])
    expect(status.hasMissingFonts.value).toBe(true)

    fontManager.markLoaded(FAMILY, 'Regular', new ArrayBuffer(8))
    // 事件未发前保持滞留（基线：fontManager 本体非响应式，computed 不自发重算）
    expect(status.missingFonts.value).toEqual([FAMILY])

    // registered 候选即中，无网络；settle('loaded') → 订阅驱动重算
    await fontResolver.demand(fontFaceDemand(FAMILY, 'Regular'))

    expect(status.missingFonts.value).toEqual([])
    expect(status.hasMissingFonts.value).toBe(false)
  } finally {
    scope.stop()
    fontManager.evictFont(FAMILY, 'Regular')
  }
})

test('内存逐出后 missing 徽标重现（onFontEvicted → resolver.reset 同样驱动重算）', () => {
  fontManager.markLoaded(EVICT_FAMILY, 'Regular', new ArrayBuffer(8))
  const scope = effectScope()
  try {
    const status = scope.run(() => useNodeFontStatus(() => textNode(EVICT_FAMILY)))
    if (!status) throw new Error('Missing scope')

    expect(status.missingFonts.value).toEqual([])

    fontManager.evictFont(EVICT_FAMILY, 'Regular')

    expect(status.missingFonts.value).toEqual([EVICT_FAMILY])
    expect(status.hasMissingFonts.value).toBe(true)
  } finally {
    scope.stop()
    fontManager.evictFont(EVICT_FAMILY, 'Regular')
  }
})
