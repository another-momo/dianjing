/**
 * T52（S4 W2 / T-B1）brief 核心契约测试（S3 §3/§10 改写口径）。
 *
 * 验收映射（T52-plan §3 第 1 条）：
 * - 四区结构：内容区 / 素材区 / AI结论区 / 关联设计区（新建）齐备；
 *   根节点 role=brief + schemaVersion=1；zone 标记 content|materials|conclusions|designs。
 * - zone 标记寻址：显示名改名后读写仍正常；剥掉标记后 name 兜底兼容旧档。
 * - 字体治理：BRIEF_FONT_FAMILY 单一常量 + fontRegistryEntry('Alibaba PuHuiTi') 钉扎。
 * - 结论按设计归组（组 designId 标记 + GroupTitle 投影），保序。
 * - 关联设计区：registerBriefDesignEntry 幂等；tombstone 保痕；读侧容错补显。
 * - findBrief 解析序：显式 briefId > 当前页唯一 brief > 歧义信号（无静默兜底）。
 * - 标记走通用 shared pluginData 面（读侧兼容旧非编码格式）。
 */

import { expect, test } from 'bun:test'

import { computeAllLayouts } from '@open-pencil/core/layout'

import { getSharedPluginData, setSharedPluginData } from '#core/figma-api/plugin-data'
import { fontRegistryEntry } from '#core/text/font/registry'
import {
  BRIEF_BINDING_KEY,
  BRIEF_CONCLUSION_GROUP_DESIGN_KEY,
  BRIEF_CONCLUSION_GROUP_NAME,
  BRIEF_EMPTY_HINT_NAME,
  BRIEF_FONT_FAMILY,
  BRIEF_NAME,
  BRIEF_PLUGIN_NAMESPACE,
  BRIEF_ROLE_KEY,
  BRIEF_ROLE_VALUE,
  BRIEF_SCHEMA_VERSION,
  BRIEF_SCHEMA_VERSION_KEY,
  BRIEF_WIDTH,
  BRIEF_ZONE_CONCLUSIONS,
  BRIEF_ZONE_CONCLUSIONS_NAME,
  BRIEF_ZONE_CONTENT,
  BRIEF_ZONE_CONTENT_NAME,
  BRIEF_ZONE_DESIGNS,
  BRIEF_ZONE_DESIGNS_NAME,
  BRIEF_ZONE_KEY,
  BRIEF_ZONE_MATERIALS,
  BRIEF_ZONE_MATERIALS_NAME,
  DESIGN_BRIEF_KEY,
  DESIGN_MODE_KEY,
  appendToBriefAIZone,
  bindBriefToDesign,
  briefBoundDesignIds,
  briefSchemaVersion,
  clearNewIntent,
  createBrief,
  findBrief,
  findBriefZone,
  getDesignUniqueId,
  isBrief,
  listBriefs,
  readNewIntent,
  registerBriefDesignEntry,
  syncBriefDesignEntries,
  writeNewIntent,
  type BriefZoneId
} from '#core/tools/fork/marketing/brief'
import { readBrief, updateBriefContent } from '#core/tools/fork/marketing/brief-edit'
import { BRIEF_TEXTS } from '#core/tools/fork/marketing/texts'

import { expectDefined } from '#tests/helpers/assert'
import { setupToolTest } from '#tests/helpers/tools'

type TestGraph = ReturnType<typeof setupToolTest>['graph']

/** 剥掉节点上的 zone 标记（模拟旧档：只有中文显示名，无 pluginData 标记） */
function stripZoneMarker(graph: TestGraph, nodeId: string): void {
  const node = expectDefined(graph.getNode(nodeId))
  graph.updateNode(nodeId, {
    pluginData: node.pluginData.filter(
      (entry) => !(entry.key === BRIEF_ZONE_KEY || entry.key.endsWith(`/${BRIEF_ZONE_KEY}`))
    )
  })
}

test('createBrief 建成四区结构：zone 标记 + schemaVersion=1 + role 标记', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma, 100, 200)

  expect(brief.type).toBe('FRAME')
  // T79 S1A：节点 name 带序号，第一张为 `需求单 1`
  expect(brief.name).toBe(`${BRIEF_NAME} 1`)
  expect(brief.x).toBe(100)
  expect(brief.y).toBe(200)
  expect(isBrief(brief)).toBe(true)
  expect(briefSchemaVersion(brief)).toBe(BRIEF_SCHEMA_VERSION)
  expect(BRIEF_SCHEMA_VERSION).toBe('1')
  expect(getSharedPluginData(brief, BRIEF_PLUGIN_NAMESPACE, BRIEF_SCHEMA_VERSION_KEY)).toBe('1')

  // 四区均可由 zone 标记寻址，显示名保留中文
  const zones: Array<[BriefZoneId, string]> = [
    [BRIEF_ZONE_CONTENT, BRIEF_ZONE_CONTENT_NAME],
    [BRIEF_ZONE_MATERIALS, BRIEF_ZONE_MATERIALS_NAME],
    [BRIEF_ZONE_CONCLUSIONS, BRIEF_ZONE_CONCLUSIONS_NAME],
    [BRIEF_ZONE_DESIGNS, BRIEF_ZONE_DESIGNS_NAME]
  ]
  for (const [zone, displayName] of zones) {
    const node = expectDefined(findBriefZone(graph, brief, zone), `zone ${zone}`)
    expect(node.name).toBe(displayName)
    expect(getSharedPluginData(node, BRIEF_PLUGIN_NAMESPACE, BRIEF_ZONE_KEY)).toBe(zone)
  }

  // 关联设计区存在且初始为空（DesignList 无条目 + EmptyHint 可见）
  const designsZone = expectDefined(findBriefZone(graph, brief, BRIEF_ZONE_DESIGNS))
  const listId = expectDefined(
    designsZone.childIds.find((id) => graph.getNode(id)?.name === 'DesignList')
  )
  expect(expectDefined(graph.getNode(listId)).childIds).toEqual([])
  const hintId = expectDefined(
    designsZone.childIds.find((id) => graph.getNode(id)?.name === BRIEF_EMPTY_HINT_NAME)
  )
  expect(expectDefined(graph.getNode(hintId)).visible).not.toBe(false)
})

test('字体钉扎：全部 TEXT 用 BRIEF_FONT_FAMILY，注册表在册', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)

  expect(BRIEF_FONT_FAMILY).toBe('Alibaba PuHuiTi')
  const entry = expectDefined(fontRegistryEntry(BRIEF_FONT_FAMILY), 'font registry entry')
  expect(entry.family).toBe('Alibaba PuHuiTi')
  expect(entry.weights).toContain('Regular')

  const stack = [...brief.childIds]
  let textCount = 0
  while (stack.length > 0) {
    const node = expectDefined(graph.getNode(expectDefined(stack.pop())))
    if (node.type === 'TEXT') {
      textCount++
      expect(node.fontFamily).toBe(BRIEF_FONT_FAMILY)
    }
    stack.push(...node.childIds)
  }
  expect(textCount).toBeGreaterThan(0)
})

test('zone 标记寻址：显示名改名后读写仍正常', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)

  // 用户把四个区显示名全改了
  const allZones: BriefZoneId[] = [
    BRIEF_ZONE_CONTENT,
    BRIEF_ZONE_MATERIALS,
    BRIEF_ZONE_CONCLUSIONS,
    BRIEF_ZONE_DESIGNS
  ]
  for (const zone of allZones) {
    const node = expectDefined(findBriefZone(graph, brief, zone))
    graph.updateNode(node.id, { name: `改名后的${node.name}` })
  }

  const view = expectDefined(readBrief(figma))
  expect(view.briefId).toBe(brief.id)
  expect(updateBriefContent(figma, brief.id, '改名后仍可写')).toBe(true)
  expect(expectDefined(readBrief(figma)).content).toBe('改名后仍可写')
  expect(appendToBriefAIZone(figma, brief.id, '改名后仍可追加')).toBe(true)
})

test('zone 标记缺失时 name 兜底兼容旧档', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)

  const allZones: BriefZoneId[] = [
    BRIEF_ZONE_CONTENT,
    BRIEF_ZONE_MATERIALS,
    BRIEF_ZONE_CONCLUSIONS,
    BRIEF_ZONE_DESIGNS
  ]
  for (const zone of allZones) {
    const node = expectDefined(findBriefZone(graph, brief, zone))
    stripZoneMarker(graph, node.id)
  }

  const view = expectDefined(readBrief(figma))
  expect(view.briefId).toBe(brief.id)
  expect(updateBriefContent(figma, brief.id, '旧档兜底')).toBe(true)
})

test('标记读侧兼容旧非编码格式（明文 key 旧档可读）', () => {
  const { graph, figma } = setupToolTest()
  const legacy = graph.createNode('FRAME', figma.currentPage.id, {
    name: BRIEF_NAME,
    pluginData: [
      { pluginId: BRIEF_PLUGIN_NAMESPACE, key: BRIEF_ROLE_KEY, value: BRIEF_ROLE_VALUE },
      { pluginId: BRIEF_PLUGIN_NAMESPACE, key: BRIEF_BINDING_KEY, value: 'root-1,root-2' }
    ]
  })
  expect(isBrief(legacy)).toBe(true)
  expect(briefBoundDesignIds(legacy)).toEqual(['root-1', 'root-2'])
})

test('isBrief 不认同名外观节点；listBriefs 只列当前页 brief', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)
  const lookalike = graph.createNode('FRAME', figma.currentPage.id, { name: BRIEF_NAME })
  expect(isBrief(graph.getNode(lookalike.id))).toBe(false)
  expect(listBriefs(figma).map((node) => node.id)).toEqual([brief.id])
})

test('T79 S1A：节点 name 带序号，按页内已有 brief 数递增', () => {
  const { graph, figma } = setupToolTest()
  const first = createBrief(figma)
  expect(first.name).toBe(`${BRIEF_NAME} 1`)

  const second = createBrief(figma)
  expect(second.name).toBe(`${BRIEF_NAME} 2`)

  const third = createBrief(figma)
  expect(third.name).toBe(`${BRIEF_NAME} 3`)

  // 序号基于 listBriefs 长度（页面级），命名唯一不冲突
  const names = [first, second, third].map((n) => graph.getNode(n.id)?.name)
  expect(new Set(names).size).toBe(3)
})

test('findBrief 解析序：无 brief → none；唯一 → ok；多个 → ambiguous；显式 briefId 优先', () => {
  const { figma } = setupToolTest()
  expect(findBrief(figma).status).toBe('none')

  const first = createBrief(figma)
  const unique = findBrief(figma)
  expect(unique.status).toBe('ok')
  expect(unique.status === 'ok' && unique.brief.id).toBe(first.id)

  const second = createBrief(figma)
  const ambiguous = findBrief(figma)
  expect(ambiguous.status).toBe('ambiguous')
  expect(ambiguous.status === 'ambiguous' && ambiguous.candidates.length).toBe(2)

  const explicit = findBrief(figma, second.id)
  expect(explicit.status === 'ok' && explicit.brief.id).toBe(second.id)

  expect(findBrief(figma, 'nonexistent').status).toBe('not-found')
})

test('brief 布局几何不塌缩（computeAllLayouts 后尺寸合理）', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma, 0, 0)
  computeAllLayouts(graph, figma.currentPage.id)

  const fresh = expectDefined(graph.getNode(brief.id))
  expect(fresh.width).toBe(BRIEF_WIDTH)
  expect(fresh.height).toBeGreaterThan(200)

  const aiCard = expectDefined(findBriefZone(graph, fresh, BRIEF_ZONE_CONCLUSIONS))
  expect(aiCard.width).toBe(384)
  expect(aiCard.height).toBe(fresh.height - 72)
})

test('bindBriefToDesign 走通用 upsert：幂等追加', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)

  // T91a：bindBriefToDesign 现在需要真实 design 节点（用来 resolve / 写 UUID）。
  const designA = graph.createNode('FRAME', figma.currentPage.id, { name: '设计 A' })
  const designB = graph.createNode('FRAME', figma.currentPage.id, { name: '设计 B' })

  bindBriefToDesign(figma, brief.id, designA.id)
  bindBriefToDesign(figma, brief.id, designA.id)
  bindBriefToDesign(figma, brief.id, designB.id)
  const fresh = expectDefined(graph.getNode(brief.id))
  const uuidA = getDesignUniqueId(graph.getNode(designA.id))
  const uuidB = getDesignUniqueId(graph.getNode(designB.id))
  expect(uuidA).not.toBe('')
  expect(uuidB).not.toBe('')
  expect(briefBoundDesignIds(fresh)).toEqual([uuidA, uuidB])
  // 通用 shared 面编码键可读出（按 UUID 序列化的字符串）
  expect(getSharedPluginData(fresh, BRIEF_PLUGIN_NAMESPACE, BRIEF_BINDING_KEY)).toBe(
    `${uuidA},${uuidB}`
  )
})

test('appendToBriefAIZone：无归属平铺 + 按设计归组（组标记 designId），保序', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)
  const design = graph.createNode('FRAME', figma.currentPage.id, { name: '产品长图' })

  expect(appendToBriefAIZone(figma, brief.id, '方向A：水彩萌趣')).toBe(true)
  expect(
    appendToBriefAIZone(figma, brief.id, '方向B：活力几何', { id: design.id, name: design.name })
  ).toBe(true)
  expect(appendToBriefAIZone(figma, brief.id, '收尾：无归属')).toBe(true)
  expect(appendToBriefAIZone(figma, 'nonexistent', 'x')).toBe(false)

  // 组 frame 携带 designId 标记
  const aiZone = expectDefined(findBriefZone(graph, brief, BRIEF_ZONE_CONCLUSIONS))
  const stack = [aiZone.id]
  let groupMarked = false
  while (stack.length > 0) {
    const node = expectDefined(graph.getNode(expectDefined(stack.pop())))
    if (node.name === BRIEF_CONCLUSION_GROUP_NAME) {
      expect(
        getSharedPluginData(node, BRIEF_PLUGIN_NAMESPACE, BRIEF_CONCLUSION_GROUP_DESIGN_KEY)
      ).toBe(design.id)
      groupMarked = true
    }
    stack.push(...node.childIds)
  }
  expect(groupMarked).toBe(true)

  // 视图保序 + 归属字段
  const view = expectDefined(readBrief(figma))
  expect(view.conclusions).toEqual([
    { text: '方向A：水彩萌趣', designId: null, designName: null },
    { text: '方向B：活力几何', designId: design.id, designName: '产品长图' },
    { text: '收尾：无归属', designId: null, designName: null }
  ])
})

test('关联设计区：registerBriefDesignEntry 幂等 + 投影读穿三元组缺省「—」', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)
  const design = graph.createNode('FRAME', figma.currentPage.id, { name: '产品长图' })

  const first = registerBriefDesignEntry(figma, brief.id, design.id)
  expect('entryId' in first && first.created).toBe(true)
  const second = registerBriefDesignEntry(figma, brief.id, design.id)
  expect('entryId' in second && second.created).toBe(false)
  if (!('entryId' in first) || !('entryId' in second)) return
  expect(second.entryId).toBe(first.entryId)

  // 空态提示隐藏
  const designsZone = expectDefined(findBriefZone(graph, brief, BRIEF_ZONE_DESIGNS))
  const hintId = expectDefined(
    designsZone.childIds.find((id) => graph.getNode(id)?.name === BRIEF_EMPTY_HINT_NAME)
  )
  expect(expectDefined(graph.getNode(hintId)).visible).toBe(false)

  // 三元组未写入（T53 前）→ 投影缺省「—」，名称读活设计名
  const view = expectDefined(readBrief(figma))
  expect(view.designs).toEqual([
    {
      entryId: first.entryId,
      designId: design.id,
      // T91a：design uniqueId——registerBriefDesignEntry 路径不写 uniqueId；只有
      // setup_design / bindBriefToDesign 才会触发懒补
      uniqueId: '',
      name: '产品长图',
      modeId: BRIEF_TEXTS.missingProjection,
      deleted: false,
      registered: true
    }
  ])

  // 三元组写入后投影读穿
  setSharedPluginData(
    graph,
    expectDefined(graph.getNode(design.id)),
    BRIEF_PLUGIN_NAMESPACE,
    DESIGN_MODE_KEY,
    'longform'
  )
  const after = expectDefined(readBrief(figma))
  expect(after.designs[0]?.modeId).toBe('longform')

  // 设计改名 → 名称投影读穿活名
  graph.updateNode(design.id, { name: '产品长图 v2' })
  expect(expectDefined(readBrief(figma)).designs[0]?.name).toBe('产品长图 v2')
})

test('tombstone 保痕：设计已删 → 视图标注「（已删除）」，条目节点不物理清除', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)
  const design = graph.createNode('FRAME', figma.currentPage.id, { name: '产品长图' })
  const registered = registerBriefDesignEntry(figma, brief.id, design.id)
  if (!('entryId' in registered)) throw new Error('registration failed')

  graph.deleteNode(design.id)

  const view = expectDefined(readBrief(figma))
  expect(view.designs.length).toBe(1)
  const entry = expectDefined(view.designs[0])
  expect(entry.deleted).toBe(true)
  expect(entry.name).toBe(`产品长图${BRIEF_TEXTS.deletedMark}`)
  expect(entry.modeId).toBe(BRIEF_TEXTS.missingProjection)
  // 保痕：条目节点仍在画布上
  expect(graph.getNode(registered.entryId)).toBeDefined()
})

test('读侧容错补显：design→brief 指针有而条目缺 → registered:false；变更路径物理补写', () => {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)
  const design = graph.createNode('FRAME', figma.currentPage.id, { name: '详情页' })
  setSharedPluginData(
    graph,
    expectDefined(graph.getNode(design.id)),
    BRIEF_PLUGIN_NAMESPACE,
    DESIGN_BRIEF_KEY,
    brief.id
  )

  // 读侧：条目缺 → 视图补显但不落盘
  const view = expectDefined(readBrief(figma))
  expect(view.designs.length).toBe(1)
  expect(view.designs[0]?.registered).toBe(false)
  expect(view.designs[0]?.entryId).toBe(null)
  expect(view.designs[0]?.name).toBe('详情页')
  const designsZone = expectDefined(findBriefZone(graph, brief, BRIEF_ZONE_DESIGNS))
  const listId = expectDefined(
    designsZone.childIds.find((id) => graph.getNode(id)?.name === 'DesignList')
  )
  expect(expectDefined(graph.getNode(listId)).childIds).toEqual([])

  // 变更路径：syncBriefDesignEntries 物理补写，之后 registered:true
  expect(syncBriefDesignEntries(figma, brief.id)).toEqual([design.id])
  expect(expectDefined(readBrief(figma)).designs[0]?.registered).toBe(true)
  // 幂等：再次 sync 不重复登记
  expect(syncBriefDesignEntries(figma, brief.id)).toEqual([])
})

// ── T91b：newIntent pluginData helper round-trip ────────────────────────────

test('newIntent pluginData 四键 round-trip：write → read 对称；clear 复位（A3 B2 canvas 扩展）', () => {
  const { figma } = setupToolTest()

  // 初态：未写入 = 缺省空 state
  expect(readNewIntent(figma)).toEqual({
    modeId: '',
    profileId: '',
    confirmed: false,
    canvas: ''
  })

  // 写完整四键
  writeNewIntent(figma, {
    modeId: 'longform',
    profileId: 'p1',
    canvas: '750x2000',
    confirmed: true
  })
  expect(readNewIntent(figma)).toEqual({
    modeId: 'longform',
    profileId: 'p1',
    confirmed: true,
    canvas: '750x2000'
  })

  // 写 confirmed=false（profileId/canvas 不传 → ''——单一原子入口语义，不保留旧值）
  writeNewIntent(figma, { modeId: 'general', confirmed: false })
  expect(readNewIntent(figma)).toEqual({
    modeId: 'general',
    profileId: '',
    confirmed: false,
    canvas: ''
  })

  // profileId/canvas 缺省 = ''
  writeNewIntent(figma, { modeId: 'general', confirmed: true })
  expect(readNewIntent(figma)).toEqual({
    modeId: 'general',
    profileId: '',
    confirmed: true,
    canvas: ''
  })

  // 清：read 返缺省空 state
  clearNewIntent(figma)
  expect(readNewIntent(figma)).toEqual({
    modeId: '',
    profileId: '',
    confirmed: false,
    canvas: ''
  })
})

test('newIntent confirmed 仅字面量 "true" 视为真；其他字串 / 空串视为假', () => {
  const { figma, graph } = setupToolTest()
  const root = expectDefined(graph.getNode(figma.graph.rootId))
  // 直接写 pluginData 模拟"非 'true' 真值"——核心读侧只看字面量
  setSharedPluginData(graph, root, BRIEF_PLUGIN_NAMESPACE, 'newIntentModeId', 'longform')
  setSharedPluginData(graph, root, BRIEF_PLUGIN_NAMESPACE, 'newIntentProfileId', 'p1')
  setSharedPluginData(graph, root, BRIEF_PLUGIN_NAMESPACE, 'newIntentConfirmed', 'TRUE')
  expect(readNewIntent(figma).confirmed).toBe(false)

  setSharedPluginData(graph, root, BRIEF_PLUGIN_NAMESPACE, 'newIntentConfirmed', 'true')
  expect(readNewIntent(figma).confirmed).toBe(true)
  expect(readNewIntent(figma).modeId).toBe('longform')
  expect(readNewIntent(figma).profileId).toBe('p1')
})
