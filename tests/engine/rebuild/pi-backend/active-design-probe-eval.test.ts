/**
 * 2026-09-27 sl-w2-state-chain：桥探针生成串 × 真实数据形态接线测试（slim 版，
 * 前身 = T91a active-design-probe-eval.test.ts，随槽位机制摘除整删）。
 *
 * 钉死的接线面：host 的桥探针 eval 串由代码生成，mock 桥的单测从不执行串本
 * 体——「生成串 × 真实数据形态」断裂只有真跑能兜。2026-09-27 推送前独立
 * review 实证：probeSlot 的 docUuid 查询键误用条目全键（自命名空间编码形
 * 下匹配器剥前缀比对后缀，传全键 = 双前缀恒 miss），生产恒返空串——
 * page-state 读写面（冻结 / 确认门端点 / 信封规制）整体静默失效。
 */
import { describe, expect, test } from 'bun:test'

import type { FigmaAPI } from '@open-pencil/core/figma-api'
import { wrapEvalCode } from '@open-pencil/core/tools'
import { createBrief } from '@open-pencil/core/tools/fork/marketing/brief'
import type { SceneGraph } from '@open-pencil/scene-graph'

import { createBridgeSlotIO } from '@/app/ai/pi-backend/active-design-host'

import { setupToolTest } from '#tests/helpers/tools'

/**
 * 与桥 eval-handler 同形态执行生成串（AsyncFunction + wrapEvalCode）；
 * args.pageId 存在时先钉页（复刻桥 resolveAutomationTarget 的 page_id 语义）。
 */
async function evalInPage(figma: FigmaAPI, code: string, pageId?: string): Promise<unknown> {
  if (pageId) {
    const page = figma.getNodeById(pageId)
    if (!page) throw new Error(`page not found: ${pageId}`)
    figma.currentPage = page
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {
    /* noop */
  }).constructor
  const fn = new AsyncFunction('figma', wrapEvalCode(code)) as (figma: FigmaAPI) => Promise<unknown>
  return fn(figma)
}

function bridgeOn(figma: FigmaAPI) {
  return createBridgeSlotIO((code, args) => evalInPage(figma, code, args.pageId))
}

/** 以 document-key.ts 的生产形态写 docUuid 条目（自命名空间编码全键直写数组） */
function writeDocUuid(graph: SceneGraph, uuid: string): void {
  const root = graph.getNode(graph.rootId)
  graph.updateNode(graph.rootId, {
    pluginData: [
      ...(root?.pluginData ?? []),
      { pluginId: 'openpencil.ai', key: 'openpencil.ai/docId', value: uuid }
    ]
  })
}

describe('桥探针生成串 × 真实数据形态（接线面钉扎）', () => {
  test('probeSlot：docUuid 按生产条目形态读回 + currentPageId 为视图页', async () => {
    const { graph, figma } = setupToolTest()
    writeDocUuid(graph, 'uuid-123')

    const probe = await bridgeOn(figma).probeSlot()
    expect(probe).toEqual({ currentPageId: figma.currentPageId, docUuid: 'uuid-123' })
  })

  test('probeSlot：文档未铸 uuid → docUuid 空串（首跑形态）', async () => {
    const { figma } = setupToolTest()

    const probe = await bridgeOn(figma).probeSlot()
    expect(probe?.docUuid).toBe('')
  })

  test('probeBrief：按钉页扫描需求单根——命中页返 id，他页返空', async () => {
    const { graph, figma } = setupToolTest()
    const brief = createBrief(figma)
    const pageA = figma.currentPageId
    const pageB = graph.addPage('Page 2')

    const io = bridgeOn(figma)
    expect(await io.probeBrief(pageA)).toEqual([brief.id])
    expect(await io.probeBrief(pageB.id)).toEqual([])
  })
})
