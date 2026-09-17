/**
 * T60（Phase 3 W3/T-B9）active_design 单槽 + set_active_design 契约测试。
 *
 * 验收映射（T60-plan §3 core 侧）：
 *  - 单槽读写：写入 / 读穿 / 缺槽 '' / 清槽删键 / 节点删除后读穿 → dangling
 *  - 四条件校验：通过路径 + 四驳回（不存在 / 非根框 / 跨页 / briefId 不一致）
 *  - 槽位状态读穿：empty / ok / briefMissing（需求单被删）/ dangling
 *  - set_active_design：mutates:false 钉扎、{proposed:{nodeId,...}} 不落槽、
 *    驳回结构化错误；ACTIVE_DESIGN_TOOLS 交付面形状
 *  - typeId 残留容忍（T62 并行删除期：旧文档残留键忽略不读）
 */

import { describe, expect, test } from 'bun:test'

import { getSharedPluginData, setSharedPluginData } from '#core/figma-api/plugin-data'
import {
  ACTIVE_DESIGN_KEY,
  ACTIVE_DESIGN_PROBE_KEYS,
  ACTIVE_DESIGN_TOOLS,
  checkActiveDesignCandidate,
  clearActiveDesignNodeId,
  evaluateActiveDesignSlot,
  readActiveDesignNodeId,
  setActiveDesignTool,
  snapshotBriefLink,
  snapshotDesignRoot,
  validateActiveDesignCandidate,
  writeActiveDesignNodeId,
  type BriefLinkSnapshot,
  type DesignRootSnapshot
} from '#core/tools/fork/marketing/active-design'
import {
  BRIEF_PLUGIN_NAMESPACE,
  DESIGN_BRIEF_KEY,
  briefBoundDesignIds,
  createBrief
} from '#core/tools/fork/marketing/brief'
import { setupDesign } from '#core/tools/fork/marketing/setup'

import { expectDefined } from '#tests/helpers/assert'
import { setupToolTest, toolInputSchema } from '#tests/helpers/tools'

/** 一页一 brief 一设计根的标准前置（general mode，无 profile） */
function setupPageWithDesign() {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)
  const result = setupDesign(figma, {
    modeId: 'general',
    briefId: brief.id,
    confirmedNewIntent: true
  })
  if ('error' in result) throw new Error(`setup_design failed: ${result.error}`)
  return { graph, figma, brief, rootId: result.rootId }
}

describe('active_design 单槽读写', () => {
  test('缺槽读穿 → 空串；写入 → 读穿一致；清槽 → 键删除', () => {
    const { figma, rootId } = setupPageWithDesign()
    expect(readActiveDesignNodeId(figma)).toBe('')

    writeActiveDesignNodeId(figma, rootId)
    expect(readActiveDesignNodeId(figma)).toBe(rootId)
    const root = expectDefined(figma.graph.getNode(figma.graph.rootId))
    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, ACTIVE_DESIGN_KEY)).toBe(rootId)

    clearActiveDesignNodeId(figma)
    expect(readActiveDesignNodeId(figma)).toBe('')
    // 清槽 = 删键（setSharedPluginData 空串语义），不留空值残留
    const fresh = expectDefined(figma.graph.getNode(figma.graph.rootId))
    expect(fresh.pluginData.some((entry) => entry.key.endsWith(`/${ACTIVE_DESIGN_KEY}`))).toBe(
      false
    )
  })

  test('槽位节点删除后读穿 → dangling（宿主据此前桥清槽）', () => {
    const { graph, figma, rootId } = setupPageWithDesign()
    writeActiveDesignNodeId(figma, rootId)
    graph.deleteNode(rootId)

    expect(readActiveDesignNodeId(figma)).toBe(rootId) // 槽值本身仍在（指针悬空）
    expect(snapshotDesignRoot(figma, rootId)).toBeNull()
    const slot = evaluateActiveDesignSlot(rootId, null, null)
    expect(slot).toEqual({ status: 'dangling', nodeId: rootId })
  })

  test('槽位空串 → empty；读穿 ok 携带三元组与 briefMissing=false', () => {
    const { figma, brief, rootId } = setupPageWithDesign()
    expect(evaluateActiveDesignSlot('', null, null)).toEqual({ status: 'empty' })

    const design = expectDefined(snapshotDesignRoot(figma, rootId))
    const link = expectDefined(snapshotBriefLink(figma, brief.id))
    const slot = evaluateActiveDesignSlot(rootId, design, link)
    expect(slot.status).toBe('ok')
    if (slot.status !== 'ok') return
    expect(slot.design.nodeId).toBe(rootId)
    expect(slot.design.modeId).toBe('general')
    expect(slot.design.briefId).toBe(brief.id)
    expect(slot.briefMissing).toBe(false)
  })

  test('brief 悬空（需求单被删、设计区仍在）→ ok + briefMissing=true（不清槽）', () => {
    const { graph, figma, brief, rootId } = setupPageWithDesign()
    graph.deleteNode(brief.id)
    const design = expectDefined(snapshotDesignRoot(figma, rootId))
    const slot = evaluateActiveDesignSlot(rootId, design, snapshotBriefLink(figma, brief.id))
    expect(slot.status).toBe('ok')
    if (slot.status !== 'ok') return
    expect(slot.briefMissing).toBe(true)
  })

  test('槽内节点已非设计区根框（role 标记被抹）→ dangling', () => {
    const { figma, rootId } = setupPageWithDesign()
    const node = expectDefined(figma.graph.getNode(rootId))
    setSharedPluginData(figma.graph, node, BRIEF_PLUGIN_NAMESPACE, 'role', '')
    const design = expectDefined(snapshotDesignRoot(figma, rootId))
    expect(evaluateActiveDesignSlot(rootId, design, null).status).toBe('dangling')
  })
})

describe('四条件校验（端点 ②/③ 与 set_active_design 共用）', () => {
  test('通过路径：setup_design 产物天然四条件齐备', () => {
    const { figma, brief, rootId } = setupPageWithDesign()
    const check = validateActiveDesignCandidate(figma, rootId)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(check.design.nodeId).toBe(rootId)
    expect(check.design.briefId).toBe(brief.id)
    // T91a：bound-designs 现存 design uniqueId（UUID）；按 UUID 断言
    const design = expectDefined(figma.graph.getNode(rootId))
    const designUuid = getSharedPluginData(design, BRIEF_PLUGIN_NAMESPACE, 'uniqueId')
    expect(designUuid).not.toBe('')
    expect(briefBoundDesignIds(figma.graph.getNode(brief.id))).toContain(designUuid)
  })

  test('驳回：节点不存在 → not_found（message 用户语言化）', () => {
    const { figma } = setupPageWithDesign()
    const check = validateActiveDesignCandidate(figma, '999:999')
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toBe('not_found')
    expect(check.message).toContain('999:999')
  })

  test('驳回：普通 FRAME 非设计区根框 → not_design_root', () => {
    const { figma } = setupPageWithDesign()
    const plain = figma.graph.createNode('FRAME', figma.currentPage.id, { name: 'plain' })
    const check = validateActiveDesignCandidate(figma, plain.id)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toBe('not_design_root')
  })

  test('驳回：跨页 → cross_page', () => {
    const { figma, rootId } = setupPageWithDesign()
    const page2 = figma.graph.addPage('Page 2')
    figma.currentPage = expectDefined(figma.getNodeById(page2.id))
    const check = validateActiveDesignCandidate(figma, rootId)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toBe('cross_page')
  })

  test('驳回：briefId 不一致（brief 未登记该设计区）→ brief_mismatch', () => {
    const { figma, rootId } = setupPageWithDesign()
    const otherBrief = createBrief(figma) // 未 bind 本设计区
    const node = expectDefined(figma.graph.getNode(rootId))
    setSharedPluginData(figma.graph, node, BRIEF_PLUGIN_NAMESPACE, DESIGN_BRIEF_KEY, otherBrief.id)
    const check = validateActiveDesignCandidate(figma, rootId)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toBe('brief_mismatch')
  })

  test('驳回：briefId 指向已删除需求单 → brief_mismatch', () => {
    const { graph, figma, brief, rootId } = setupPageWithDesign()
    graph.deleteNode(brief.id)
    const check = validateActiveDesignCandidate(figma, rootId)
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.reason).toBe('brief_mismatch')
  })

  test('纯函数单源：快照直接喂 checkActiveDesignCandidate（桥探针路径同判定）', () => {
    const design: DesignRootSnapshot = {
      nodeId: '1:2',
      name: '长图',
      type: 'FRAME',
      pageId: 'page-1',
      marketingRoot: true,
      modeId: 'longform',
      profileId: 'p1',
      briefId: 'b1'
    }
    const brief: BriefLinkSnapshot = { briefId: 'b1', pageId: 'page-1', boundDesignIds: ['1:2'] }
    expect(checkActiveDesignCandidate('1:2', design, brief, 'page-1').ok).toBe(true)
    expect(checkActiveDesignCandidate('1:2', null, brief, 'page-1')).toMatchObject({
      ok: false,
      reason: 'not_found'
    })
    expect(
      checkActiveDesignCandidate('1:2', { ...design, marketingRoot: false }, brief, 'page-1')
    ).toMatchObject({ ok: false, reason: 'not_design_root' })
    expect(
      checkActiveDesignCandidate('1:2', { ...design, pageId: 'page-2' }, brief, 'page-1')
    ).toMatchObject({ ok: false, reason: 'cross_page' })
    expect(
      checkActiveDesignCandidate('1:2', design, { ...brief, boundDesignIds: [] }, 'page-1')
    ).toMatchObject({ ok: false, reason: 'brief_mismatch' })
  })

  test('typeId 残留容忍：旧文档 typeId 键存在 → 快照无 typeId 字段且校验不受影响', () => {
    const { figma, rootId } = setupPageWithDesign()
    const node = expectDefined(figma.graph.getNode(rootId))
    // T62 已删 DESIGN_TYPE_KEY 常量——旧文档残留键用字面量模拟（键名是历史事实）
    setSharedPluginData(figma.graph, node, BRIEF_PLUGIN_NAMESPACE, 'typeId', 'legacy-type')
    const design = expectDefined(snapshotDesignRoot(figma, rootId))
    expect('typeId' in design).toBe(false)
    expect(validateActiveDesignCandidate(figma, rootId).ok).toBe(true)
  })
})

describe('set_active_design 工具', () => {
  test('mutates:false 钉扎 + 交付面形状（ACTIVE_DESIGN_TOOLS 单件）', () => {
    expect(setActiveDesignTool.mutates).toBe(false)
    expect(ACTIVE_DESIGN_TOOLS).toHaveLength(1)
    expect(ACTIVE_DESIGN_TOOLS[0]?.name).toBe('set_active_design')
    // PR697 后钉扎 wire contract（LLM 可见的 JSON Schema）而非内部 ParamDef
    expect(Object.keys(toolInputSchema(setActiveDesignTool).properties)).toEqual(['node_id'])
  })

  test('合法目标 → {proposed:{nodeId,name,modeId,profileId,briefId}}，不落槽', () => {
    const { figma, brief, rootId } = setupPageWithDesign()
    const result = setActiveDesignTool.execute(figma, { node_id: rootId }) as {
      proposed?: {
        nodeId: string
        name: string
        modeId: string
        profileId: string
        briefId: string
      }
    }
    expect(result.proposed).toEqual({
      nodeId: rootId,
      name: '营销设计',
      modeId: 'general',
      profileId: '',
      briefId: brief.id
    })
    // 不落槽：单槽仍为空
    expect(readActiveDesignNodeId(figma)).toBe('')
  })

  test('非法目标 → 结构化错误（error=reason + message），不落槽', () => {
    const { figma } = setupPageWithDesign()
    const result = setActiveDesignTool.execute(figma, { node_id: '7:7' }) as {
      error?: string
      message?: string
    }
    expect(result.error).toBe('not_found')
    expect(result.message).toBeTruthy()
    expect(readActiveDesignNodeId(figma)).toBe('')
  })
})

test('桥探针键面常量钉扎（eval 片段插值的单一事实源）', () => {
  expect(ACTIVE_DESIGN_PROBE_KEYS).toEqual({
    namespace: 'open-pencil-marketing',
    slotKey: 'activeDesignNodeId',
    roleKey: 'role',
    roleRoot: 'marketing-root',
    roleBrief: 'brief',
    modeKey: 'modeId',
    profileKey: 'profileId',
    briefKey: 'briefId',
    bindingKey: 'bound-designs',
    heroGeometryKey: 'hero-geometry',
    // T91a 修复：design/brief 同键名 'uniqueId'——探针捕获/UUID 解析共用
    uniqueIdKey: 'uniqueId',
    // A3 B2：newIntent pluginData 四键（键面 import 单源）——canvas 扩键
    newIntentModeIdKey: 'newIntentModeId',
    newIntentProfileIdKey: 'newIntentProfileId',
    newIntentConfirmedKey: 'newIntentConfirmed',
    newIntentCanvasKey: 'newIntentCanvas'
  })
})
