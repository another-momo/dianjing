/**
 * setup_design 契约测试（state-layering wave-2 批 4 摘除半 + 批 5b 后形态）。
 *
 * 机制基线（2026-09-27 帧无身份）：modeId/profileId 参数、catalog 注入缝
 * （__catalog / __confirmedNewIntent）、新建意图确认门（awaiting 信封）与
 * 设计身份三元组落盘已整体退役——本文件钉活下来的面：
 *  - 建框契约：缺省长图兜底（物料库 DEFAULT_MATERIAL_SPEC）、显式 canvas
 *    覆盖（像素直给 > 物料库别名 > invalid_canvas，错误消息附物料 id 速览）
 *  - 帧无身份：设计根只落 role 标记 + schemaVersion + uniqueId，三元组键不写
 *  - 命名：最小空闲「营销设计 N」（去重域 = 当前页全部设计根）+ 恒新建
 *  - brief 校验：not-found / none / ambiguous 三态 + 关联设计区登记
 *    （bound-designs 指针 + 条目 + readBrief designs 视图无 mode 投影）
 *  - ToolDef：schema 两参数（briefId 必填 + canvas 可选）、静默执行
 */

import { describe, expect, test } from 'bun:test'

import { getSharedPluginData } from '#core/figma-api/plugin-data'
import {
  BRIEF_DESIGN_ENTRY_KEY,
  BRIEF_PLUGIN_NAMESPACE,
  BRIEF_ROLE_KEY,
  BRIEF_SCHEMA_VERSION,
  BRIEF_SCHEMA_VERSION_KEY,
  BRIEF_WIDTH,
  BRIEF_ZONE_DESIGNS,
  briefBoundDesignIds,
  createBrief,
  findBriefZone
} from '#core/tools/fork/marketing/brief'
import { readBrief } from '#core/tools/fork/marketing/brief-edit'
import { DEFAULT_MATERIAL_SPEC, MATERIAL_SPEC_IDS } from '#core/tools/fork/marketing/material-specs'
import {
  MARKETING_ROLE_ROOT,
  isMarketingDesignRoot,
  scanMarketingDesigns,
  setupDesign,
  type SetupDesignError,
  type SetupDesignErrorCode,
  type SetupDesignResult,
  type SetupDesignSuccess
} from '#core/tools/fork/marketing/setup'
import { SETUP_TOOLS, setupDesignTool } from '#core/tools/fork/marketing/setup-tool'
import { SETUP_TEXTS } from '#core/tools/fork/marketing/texts'
import { PLACEMENT_GAP } from '#core/tools/fork/placement'

import { expectDefined } from '#tests/helpers/assert'
import { setupToolTest, toolInputSchema } from '#tests/helpers/tools'

function ok(result: SetupDesignResult): SetupDesignSuccess {
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`)
  return result
}

function err(result: SetupDesignResult, code: SetupDesignErrorCode): SetupDesignError {
  if (!('error' in result)) throw new Error(`expected error ${code}, got success`)
  expect(result.error).toBe(code)
  expect(result.message).toBeTruthy()
  return result
}

/** 一页一 brief 的标准前置 */
function setupPage() {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)
  const run = (args: { briefId?: string; canvas?: string }) =>
    setupDesign(figma, { briefId: brief.id, ...args })
  return { graph, figma, brief, run }
}

describe('setup_design core：建框契约', () => {
  test('缺省尺寸建框：750 宽 + VERTICAL/counter-FIXED + 白底 + clipsContent', () => {
    const { graph, run } = setupPage()
    const result = ok(run())

    const root = expectDefined(graph.getNode(result.rootId))
    expect(root.type).toBe('FRAME')
    expect(root.width).toBe(750)
    expect(root.layoutMode).toBe('VERTICAL')
    expect(root.counterAxisSizing).toBe('FIXED')
    expect(root.clipsContent).toBe(true)
    expect(root.fills[0]).toMatchObject({ type: 'SOLID', color: { r: 1, g: 1, b: 1 } })
    expect(result.size).toEqual({ width: 750, height: null })
    expect(result.name).toBe(SETUP_TEXTS.designRootName)
  })

  test('HUG 语义：初始高 400 / primaryAxisSizing HUG', () => {
    const { graph, run } = setupPage()
    const result = ok(run())
    const root = expectDefined(graph.getNode(result.rootId))
    expect(root.primaryAxisSizing).toBe('HUG')
    expect(root.height).toBe(400)
    expect(result.size).toEqual({ width: 750, height: null })
  })

  test('标记读穿：role + schemaVersion + uniqueId 落盘；身份三元组键不写（帧无身份）', () => {
    const { graph, brief, run } = setupPage()
    const result = ok(run())
    const root = expectDefined(graph.getNode(result.rootId))

    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, BRIEF_ROLE_KEY)).toBe(
      MARKETING_ROLE_ROOT
    )
    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, BRIEF_SCHEMA_VERSION_KEY)).toBe(
      BRIEF_SCHEMA_VERSION
    )
    expect(BRIEF_SCHEMA_VERSION).toBe('1')
    expect(isMarketingDesignRoot(root)).toBe(true)
    // T91a：design uniqueId（跨持久化寻址键）落盘
    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, 'uniqueId')).toMatch(/^[0-9a-f-]{36}$/)
    // 帧无身份：modeId / profileId / briefId 键一概不写（旧文档残留键读侧天然忽略）
    for (const legacyKey of ['modeId', 'profileId', 'briefId']) {
      expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, legacyKey)).toBe('')
    }

    // brief 根 uniqueId 在位（bound-designs 寻址前提）
    const briefUuid = getSharedPluginData(
      expectDefined(graph.getNode(brief.id)),
      BRIEF_PLUGIN_NAMESPACE,
      'uniqueId'
    )
    expect(briefUuid).not.toBe('')
  })

  test('最小空闲「营销设计 N」命名 + 恒新建：同参数再调递增', () => {
    const { graph, run } = setupPage()
    const first = ok(run())
    const second = ok(run())
    const third = ok(run())

    // 恒新建：无领养无幂等，三调三根
    expect(second.rootId).not.toBe(first.rootId)
    expect(third.rootId).not.toBe(second.rootId)
    expect(first.name).toBe(SETUP_TEXTS.designRootName)
    expect(second.name).toBe(`${SETUP_TEXTS.designRootName} 2`)
    expect(third.name).toBe(`${SETUP_TEXTS.designRootName} 3`)

    // 最小空闲：改掉裸名后新建回到裸名（去重域 = 当前页全部设计根，无 mode 子域）
    graph.updateNode(first.rootId, { name: '已改名' })
    const fourth = ok(run())
    expect(fourth.name).toBe(SETUP_TEXTS.designRootName)
  })

  test('briefId 不存在 → brief_not_found；空 briefId 多 brief → ambiguous_brief', () => {
    const { figma } = setupToolTest()
    createBrief(figma)
    const missing = setupDesign(figma, { briefId: 'nonexistent' })
    err(missing, 'brief_not_found')
    expect(scanMarketingDesigns(figma)).toEqual([])

    // 文档无 brief（briefId 空 → none 态）
    const empty = setupToolTest()
    err(setupDesign(empty.figma, { briefId: '' }), 'brief_not_found')

    // 多 brief 无定位依据 → 歧义信号（比照 findBrief 三态）
    const two = setupToolTest()
    createBrief(two.figma)
    createBrief(two.figma)
    const ambiguous = setupDesign(two.figma, { briefId: '' })
    const failure = err(ambiguous, 'ambiguous_brief')
    expect(failure.candidates?.length).toBe(2)
  })

  test('信封字段：成功全字段（rootId/name/size/briefId/placement/message）', () => {
    const { brief, run } = setupPage()
    const full = ok(run({ canvas: '750x' }))
    expect(full).toEqual({
      rootId: full.rootId,
      name: SETUP_TEXTS.designRootName,
      size: { width: 750, height: null },
      briefId: brief.id,
      placement: { x: BRIEF_WIDTH + PLACEMENT_GAP, y: 0 },
      message: SETUP_TEXTS.workspaceCreated()
    })
  })

  test('放置：页面内容右侧 +100，y 跟随 bounds 顶', () => {
    const { graph, figma, brief, run } = setupPage()
    // 既有内容把 bounds 顶抬到 -500（brief 在 (0,0)，宽 1252）
    graph.createNode('FRAME', figma.currentPage.id, { x: 0, y: -500, width: 100, height: 100 })

    const result = ok(run())
    expect(result.placement).toEqual({ x: BRIEF_WIDTH + PLACEMENT_GAP, y: -500 })
    const root = expectDefined(graph.getNode(result.rootId))
    expect(root.x).toBe(BRIEF_WIDTH + PLACEMENT_GAP)
    expect(root.y).toBe(-500)
    expect(brief.id).not.toBe(result.rootId)
  })

  test('创建后 scrollAndZoomIntoView：viewport 中心移到新根包围盒中心', () => {
    const { graph, figma, run } = setupPage()
    expect(figma.viewport.center).toEqual({ x: 0, y: 0 })

    const result = ok(run())
    const root = expectDefined(graph.getNode(result.rootId))
    expect(figma.viewport.center.x).toBe(root.x + root.width / 2)
    expect(figma.viewport.center.y).toBe(root.y + root.height / 2)
    expect(figma.viewport.zoom).toBeLessThanOrEqual(1)
    expect(figma.viewport.zoom).toBeGreaterThan(0)
  })

  test('brief 关联登记：bound-designs 指针（UUID）+ 条目 designId + 名称投影', () => {
    const { graph, figma, brief, run } = setupPage()
    const result = ok(run())

    // T91a：bound-designs 存 design uniqueId（UUID），不是 node id
    const freshBrief = expectDefined(graph.getNode(brief.id))
    const designRoot = expectDefined(graph.getNode(result.rootId))
    const designUuid = getSharedPluginData(designRoot, BRIEF_PLUGIN_NAMESPACE, 'uniqueId')
    expect(designUuid).not.toBe('')
    expect(briefBoundDesignIds(freshBrief)).toContain(designUuid)

    // 关联设计区条目：designId 标记权威 + 名称投影（无 mode 投影——帧无身份）
    const zone = expectDefined(findBriefZone(graph, freshBrief, BRIEF_ZONE_DESIGNS))
    const listId = expectDefined(
      zone.childIds.find((id) => graph.getNode(id)?.name === 'DesignList')
    )
    const entryId = expectDefined(expectDefined(graph.getNode(listId)).childIds[0])
    const entry = expectDefined(graph.getNode(entryId))
    expect(getSharedPluginData(entry, BRIEF_PLUGIN_NAMESPACE, BRIEF_DESIGN_ENTRY_KEY)).toBe(
      result.rootId
    )
    const entryText = entry.childIds
      .map((id) => graph.getNode(id))
      .find((node) => node?.type === 'TEXT')
    expect(entryText?.text).toBe(SETUP_TEXTS.designRootName)

    // read_brief designs 视图：无 modeId / registered 字段（投影视已退役）
    const view = expectDefined(readBrief(figma))
    expect(view.designs).toEqual([
      {
        entryId,
        designId: result.rootId,
        uniqueId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: SETUP_TEXTS.designRootName,
        deleted: false
      }
    ])
  })
})

describe('setup_design 尺寸解析：canvas 二态（显式覆盖 / 缺省）', () => {
  test('缺省：750 宽 + HUG', () => {
    const { graph, run } = setupPage()
    const result = ok(run())
    expect(result.size).toEqual({ width: 750, height: null })
    expect(expectDefined(graph.getNode(result.rootId)).primaryAxisSizing).toBe('HUG')
  })

  test('显式 canvas 覆盖：HUG 形 / 定高形均可', () => {
    const { graph, run } = setupPage()
    const hug = ok(run({ canvas: '1080x' }))
    expect(hug.size).toEqual({ width: 1080, height: null })
    expect(expectDefined(graph.getNode(hug.rootId)).width).toBe(1080)

    const fixed = ok(run({ canvas: '1080x1920' }))
    expect(fixed.size).toEqual({ width: 1080, height: 1920 })
    const fixedRoot = expectDefined(graph.getNode(fixed.rootId))
    expect(fixedRoot.height).toBe(1920)
    expect(fixedRoot.primaryAxisSizing).toBe('FIXED')
  })

  test('非法 canvas → invalid_canvas 且无框落地（非数字宽 / 缺 x / 三段 / 空串）；消息附物料速览', () => {
    const { graph, figma, run } = setupPage()
    const before = expectDefined(graph.getNode(figma.currentPage.id)).childIds.length
    for (const bad of ['abc', '750', '750x2000x3', '']) {
      const failure = err(run({ canvas: bad }), 'invalid_canvas')
      expect(failure.message).toBe(SETUP_TEXTS.invalidCanvas(bad, MATERIAL_SPEC_IDS.join(', ')))
    }
    // 物料速览 = agent 自愈锚点（id 列表一行流，物料库单源）
    const unknown = err(run({ canvas: 'myspace' }), 'invalid_canvas')
    expect(unknown.message).toContain('Materials:')
    expect(unknown.message).toContain('long-image')
    expect(unknown.message).toContain('ig-square')
    expect(expectDefined(graph.getNode(figma.currentPage.id)).childIds.length).toBe(before)
    expect(scanMarketingDesigns(figma)).toEqual([])
  })
})

describe('setup_design 尺寸解析：canvas 接物料规格库（像素直给 > 库别名 > invalid_canvas）', () => {
  test('库别名命中：id / CJK 俗名 / 比例俗名 → 物料尺寸落框', () => {
    const { graph, run } = setupPage()
    const square = ok(run({ canvas: 'ig-square' }))
    expect(square.size).toEqual({ width: 1080, height: 1080 })
    const squareRoot = expectDefined(graph.getNode(square.rootId))
    expect(squareRoot.height).toBe(1080)
    expect(squareRoot.primaryAxisSizing).toBe('FIXED')

    const xhs = ok(run({ canvas: '小红书' }))
    expect(xhs.size).toEqual({ width: 1080, height: 1440 })

    const slides = ok(run({ canvas: '16:9' }))
    expect(slides.size).toEqual({ width: 1920, height: 1080 })
  })

  test('HUG 条目别名命中：长图 → 750 宽 + HUG（与缺省同形）', () => {
    const { graph, run } = setupPage()
    const hug = ok(run({ canvas: '长图' }))
    expect(hug.size).toEqual({ width: 750, height: null })
    expect(expectDefined(graph.getNode(hug.rootId)).primaryAxisSizing).toBe('HUG')
  })

  test('像素直给优先且自由值不受库限制：库外像素原样落框', () => {
    const { run } = setupPage()
    const free = ok(run({ canvas: '1234x567' }))
    expect(free.size).toEqual({ width: 1234, height: 567 })
    const freeHug = ok(run({ canvas: '640x' }))
    expect(freeHug.size).toEqual({ width: 640, height: null })
  })

  test('缺省 = DEFAULT_MATERIAL_SPEC 兜底条目（引用库常量，非字面量 750）', () => {
    const { run } = setupPage()
    const result = ok(run())
    expect(result.size).toEqual({
      width: DEFAULT_MATERIAL_SPEC.width,
      height: DEFAULT_MATERIAL_SPEC.height
    })
  })
})

describe('setup_design 命中物料回执：notes just-in-time 投递', () => {
  test('命中带 notes 的物料（公众号封面）→ 成功 message 追加一行平台要点', () => {
    const { run } = setupPage()
    const result = ok(run({ canvas: 'wechat-cover' }))
    // 命中带 notes → 追加「平台要点：{notes}」行
    expect(result.message).toContain(SETUP_TEXTS.workspaceCreated().split('\n')[0])
    expect(result.message).toContain('平台要点：')
    expect(result.message).toContain('383')
  })

  test('命中无 notes 的物料（演示页 16:9）→ 成功 message 不追加平台要点行', () => {
    const { run } = setupPage()
    const result = ok(run({ canvas: 'slides-16x9' }))
    expect(result.message).toBe(SETUP_TEXTS.workspaceCreated())
    expect(result.message).not.toContain('平台要点：')
  })

  test('像素直给 → 不追加 notes（即使有同尺寸库条目带 notes）', () => {
    const { run } = setupPage()
    const result = ok(run({ canvas: '900x383' }))
    expect(result.message).toBe(SETUP_TEXTS.workspaceCreated())
    expect(result.message).not.toContain('平台要点：')
  })

  test('缺省（不传 canvas）→ 不追加 notes', () => {
    const { run } = setupPage()
    const result = ok(run())
    expect(result.message).toBe(SETUP_TEXTS.workspaceCreated())
    expect(result.message).not.toContain('平台要点：')
  })
})

describe('scanMarketingDesigns 无状态扫描（无身份投影）', () => {
  test('空页 → scan 空；brief/普通 frame 不被误认', () => {
    const { graph, figma } = setupToolTest()
    createBrief(figma)
    graph.createNode('FRAME', figma.currentPage.id, { name: '产品长图' })

    expect(scanMarketingDesigns(figma)).toEqual([])
  })

  test('唯一设计 → scan 出 {rootId, name}（无三元组投影字段）', () => {
    const { figma, run } = setupPage()
    const created = ok(run())

    expect(scanMarketingDesigns(figma)).toEqual([
      { rootId: created.rootId, name: SETUP_TEXTS.designRootName }
    ])
  })

  test('死节点不出现：删除设计根后 scan 为空；两次扫描独立（无进程态）', () => {
    const { graph, figma, run } = setupPage()
    const created = ok(run())
    expect(scanMarketingDesigns(figma).length).toBe(1)

    graph.deleteNode(created.rootId)
    expect(scanMarketingDesigns(figma)).toEqual([])

    const second = ok(run())
    const secondScan = scanMarketingDesigns(figma)
    expect(secondScan.length).toBe(1)
    expect(secondScan.map((design) => design.rootId)).toContain(second.rootId)
  })
})

describe('setup_design ToolDef：schema 与静默执行', () => {
  test('SETUP_TOOLS 交付面 + mutates 钉扎 + schema 两参数（briefId 必填 / canvas 可选）', () => {
    expect(SETUP_TOOLS).toEqual([setupDesignTool])
    expect(setupDesignTool.name).toBe('setup_design')
    expect(setupDesignTool.mutates).toBe(true)
    // PR697 后钉扎 wire contract（LLM 可见的 JSON Schema）而非内部 ParamDef
    const schema = toolInputSchema(setupDesignTool)
    expect(Object.keys(schema.properties)).toEqual(['briefId', 'canvas'])
    expect(schema.required).toEqual(['briefId'])
  })

  test('execute 静默建框：无确认注入缝也放行（awaiting 信封已退役）', () => {
    const { graph, figma } = setupToolTest()
    const brief = createBrief(figma)
    const before = expectDefined(graph.getNode(figma.currentPage.id)).childIds.length

    const result = setupDesignTool.execute(figma, { briefId: brief.id }) as SetupDesignResult
    const success = ok(result)
    expect(success.briefId).toBe(brief.id)
    expect(expectDefined(graph.getNode(figma.currentPage.id)).childIds.length).toBe(before + 1)
  })

  test('execute canvas 透传 core：合法值生效；非法值 → invalid_canvas', () => {
    const { graph, figma } = setupToolTest()
    const brief = createBrief(figma)

    const result = setupDesignTool.execute(figma, {
      briefId: brief.id,
      canvas: '1080x'
    }) as SetupDesignResult
    const success = ok(result)
    expect(success.size).toEqual({ width: 1080, height: null })
    expect(expectDefined(graph.getNode(success.rootId)).width).toBe(1080)

    const invalid = setupDesignTool.execute(figma, {
      briefId: brief.id,
      canvas: 'not-a-size'
    }) as SetupDesignResult
    err(invalid, 'invalid_canvas')
  })
})
