import { afterEach, describe, expect, test } from 'bun:test'

import { createEditor } from '@open-pencil/core/editor'
import { setTextMeasurer } from '@open-pencil/core/layout'
import { fontFaceDemand, fontManager, fontResolver } from '@open-pencil/core/text'

import { getNodeOrThrow } from '#tests/helpers/assert'

const FAMILY = 'SettleRelayout Probe Family'
const SETTLE_WAIT_MS = 150

function settleWait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
}

afterEach(() => {
  setTextMeasurer(null)
  fontResolver.reset(fontFaceDemand(FAMILY, 'Regular').key)
  fontManager.evictFont(FAMILY, 'Regular')
})

describe('字体 settle 后 layout 追排（宽高随真实度量纠正）', () => {
  test('settled(loaded) 触发防抖重排：回退度量宽高被真实度量纠正', async () => {
    // 回退度量（字体未装）：≈8.5px/字；真实度量（装完）：14px/字
    let advance = 8.5
    setTextMeasurer((node) => ({ width: node.text.length * advance, height: 20 }))

    const editor = createEditor()
    try {
      const text = editor.graph.createNode('TEXT', editor.state.currentPageId, {
        text: '宽度实测锚点',
        fontFamily: FAMILY,
        textAutoResize: 'WIDTH_AND_HEIGHT',
        width: 51,
        height: 20
      })
      // apply 时回退度量产的滞留宽度
      expect(getNodeOrThrow(editor.graph, text.id).width).toBe(51)

      // 字体注册但 settle 事件未发：不触发重排（事件驱动，非轮询）
      advance = 14
      fontManager.markLoaded(FAMILY, 'Regular', new ArrayBuffer(8))
      await settleWait()
      expect(getNodeOrThrow(editor.graph, text.id).width).toBe(51)

      // registered 候选即中（无网络）→ settled(loaded) → 防抖后重排
      await fontResolver.demand(fontFaceDemand(FAMILY, 'Regular'))
      await settleWait()
      expect(getNodeOrThrow(editor.graph, text.id).width).toBe(84)
    } finally {
      editor.dispose()
    }
  })

  test('非 loaded 事件（reset）不触发重排', async () => {
    let advance = 8.5
    setTextMeasurer((node) => ({ width: node.text.length * advance, height: 20 }))

    const editor = createEditor()
    try {
      const text = editor.graph.createNode('TEXT', editor.state.currentPageId, {
        text: '宽度实测锚点',
        fontFamily: FAMILY,
        textAutoResize: 'WIDTH_AND_HEIGHT',
        width: 51,
        height: 20
      })

      advance = 14
      fontResolver.reset(fontFaceDemand(FAMILY, 'Regular').key)
      await settleWait()
      expect(getNodeOrThrow(editor.graph, text.id).width).toBe(51)
    } finally {
      editor.dispose()
    }
  })
})
