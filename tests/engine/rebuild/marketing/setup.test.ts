/**
 * T53（S4 W2 / T-B2）setup_design 契约测试（S3 §10 九契约改写版 + 三态解析）。
 * T62：type 机制整体删除——⑦ 三态整例删除；①② 尺寸重钉缺省（750 宽 + HUG）；错误面九码收六码；设计身份三元组。
 * T65：尺寸契约落地——catalog modes[] 带 sizes 预设清单；canvas 覆盖参数三态（预设/自由/非法 → invalid_canvas，六码收七码）；
 * 优先序 = 显式 canvas > mode 首选预设（sizes[0]）> 750 宽 HUG 缺省。
 *
 * 验收映射（T53-plan §3 + T62-plan §2 + T65-plan §2.2）：
 * ① 缺省尺寸建框（750 宽）；② HUG 语义（初始高 400 / primaryAxisSizing HUG）；③ 标记五键读穿（role + 三元组 + schemaVersion）；
 * ④ 最小空闲「label N」命名（去重域 = 仅 modeId）；⑤ briefId 不存在 → brief_not_found；
 * ⑥ modeId 校验（general 恒过 / unknown_mode / 无尺寸 mode 同走缺省）；⑧ 未确认 → awaiting_new_intent_confirmation 信封且无框落地；
 * ⑨ 关联设计区登记 + bound-designs 指针 + 读穿投影。
 * 另钉：信封字段、恒新建、放置右 +100/y 跟随、scrollAndZoomIntoView、catalog 缺省仅 general 可用、unknown_profile、
 * __catalog/__confirmedNewIntent 注入缝（ToolDef 层）、scan/resolve 三态、canvas 三态与优先序。
 *
 * SETUP_TOOLS 未注册进 FORK_TOOLS（fork/index.ts 是集成期主 agent 领土），catalog fixture 直接注入 core 函数（S3 §10 校验断言落 bun 层）。
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
  DESIGN_BRIEF_KEY,
  DESIGN_MODE_KEY,
  DESIGN_PROFILE_KEY,
  briefBoundDesignIds,
  clearNewIntent,
  createBrief,
  findBriefZone,
  readNewIntent,
  writeNewIntent
} from '#core/tools/fork/marketing/brief'
import { readBrief } from '#core/tools/fork/marketing/brief-edit'
import {
  MARKETING_ROLE_ROOT,
  isMarketingDesignRoot,
  resolveMarketingDesign,
  scanMarketingDesigns,
  setupDesign,
  type SetupCatalog,
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

const CATALOG: SetupCatalog = {
  modes: [
    // longform 预设首选 = 750x 与缺省同值——既有缺省断言不因透传翻转（T65）
    {
      id: 'longform',
      label: '长图',
      sizes: [
        { label: '电商详情长图', canvas: '750x' },
        { label: '小红书长图', canvas: '1080x' }
      ]
    },
    { id: 'workflow', label: '工作流' },
    { id: 'fixed', label: '定高图', sizes: [{ label: '详情定高', canvas: '750x2000' }] }
  ],
  profileIds: ['profile-a']
}

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

/** 一页一 brief 的标准前置；run 默认带 CATALOG，runWithoutCatalog 走无注入路径 */
function setupPage() {
  const { graph, figma } = setupToolTest()
  const brief = createBrief(figma)
  const call = (
    args: { modeId: string; profileId?: string; canvas?: string },
    catalog: SetupCatalog | undefined
  ) => setupDesign(figma, { briefId: brief.id, confirmedNewIntent: true, ...args }, catalog)
  const run = (args: { modeId: string; profileId?: string; canvas?: string }) => call(args, CATALOG)
  const runWithoutCatalog = (args: { modeId: string; profileId?: string; canvas?: string }) =>
    call(args, undefined)
  return { graph, figma, brief, run, runWithoutCatalog }
}

describe('setup_design core：契约组', () => {
  test('① 缺省尺寸建框：750 宽 + VERTICAL/counter-FIXED + 白底 + clipsContent', () => {
    const { graph, run } = setupPage()
    const result = ok(run({ modeId: 'longform' }))

    const root = expectDefined(graph.getNode(result.rootId))
    expect(root.type).toBe('FRAME')
    expect(root.width).toBe(750)
    expect(root.layoutMode).toBe('VERTICAL')
    expect(root.counterAxisSizing).toBe('FIXED')
    expect(root.clipsContent).toBe(true)
    expect(root.fills[0]).toMatchObject({ type: 'SOLID', color: { r: 1, g: 1, b: 1 } })
    expect(result.size).toEqual({ width: 750, height: null })
    expect(result.name).toBe('长图')
  })

  test('② HUG 语义（T62 尺寸重钉）：全 mode 同口径 750 宽 + HUG 初始高 400', () => {
    const { graph, run } = setupPage()
    const hug = ok(run({ modeId: 'longform' }))
    const hugRoot = expectDefined(graph.getNode(hug.rootId))
    expect(hugRoot.primaryAxisSizing).toBe('HUG')
    expect(hugRoot.height).toBe(400)
    expect(hug.size).toEqual({ width: 750, height: null })

    const general = ok(run({ modeId: 'general' }))
    const generalRoot = expectDefined(graph.getNode(general.rootId))
    expect(generalRoot.primaryAxisSizing).toBe('HUG')
    expect(generalRoot.width).toBe(750)
    expect(generalRoot.height).toBe(400)
  })

  test('③ 标记五键读穿：role + 三元组 + schemaVersion（general 缺省键不写）', () => {
    const { graph, brief, run } = setupPage()
    const result = ok(run({ modeId: 'longform', profileId: 'profile-a' }))
    const root = expectDefined(graph.getNode(result.rootId))

    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, BRIEF_ROLE_KEY)).toBe(
      MARKETING_ROLE_ROOT
    )
    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, DESIGN_MODE_KEY)).toBe('longform')
    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, DESIGN_PROFILE_KEY)).toBe('profile-a')
    // T91a：DESIGN_BRIEF_KEY 现存 brief 的 uniqueId（UUID）；断言非空 + 配对
    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, DESIGN_BRIEF_KEY)).toMatch(
      /^[0-9a-f-]{36}$/
    )
    const briefUuid = getSharedPluginData(
      expectDefined(graph.getNode(brief.id)),
      BRIEF_PLUGIN_NAMESPACE,
      'uniqueId'
    )
    expect(briefUuid).not.toBe('')
    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, DESIGN_BRIEF_KEY)).toBe(briefUuid)
    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, BRIEF_SCHEMA_VERSION_KEY)).toBe(
      BRIEF_SCHEMA_VERSION
    )
    expect(BRIEF_SCHEMA_VERSION).toBe('1')
    expect(isMarketingDesignRoot(root)).toBe(true)

    // general 无 profileId：缺省键不落盘（读穿为 ''）
    const general = ok(run({ modeId: 'general' }))
    const generalRoot = expectDefined(graph.getNode(general.rootId))
    expect(getSharedPluginData(generalRoot, BRIEF_PLUGIN_NAMESPACE, DESIGN_PROFILE_KEY)).toBe('')
  })

  test('④ 最小空闲「label N」命名 + 恒新建：同参数再调得「长图 2」', () => {
    const { graph, run } = setupPage()
    const first = ok(run({ modeId: 'longform' }))
    const second = ok(run({ modeId: 'longform' }))
    const third = ok(run({ modeId: 'longform' }))

    // 恒新建：无领养无幂等，三调三根
    expect(second.rootId).not.toBe(first.rootId)
    expect(third.rootId).not.toBe(second.rootId)
    expect(first.name).toBe('长图')
    expect(second.name).toBe('长图 2')
    expect(third.name).toBe('长图 3')

    // 最小空闲：改掉裸名后新建回到「长图」
    graph.updateNode(first.rootId, { name: '已改名' })
    const fourth = ok(run({ modeId: 'longform' }))
    expect(fourth.name).toBe('长图')
  })

  test('⑤ briefId 不存在 → brief_not_found；空 briefId 多 brief → ambiguous_brief', () => {
    const { figma } = setupToolTest()
    createBrief(figma)
    const missing = setupDesign(figma, {
      modeId: 'general',
      briefId: 'nonexistent',
      confirmedNewIntent: true
    })
    err(missing, 'brief_not_found')
    expect(scanMarketingDesigns(figma)).toEqual([])

    // 文档无 brief（briefId 空 → none 态）
    const empty = setupToolTest()
    err(
      setupDesign(empty.figma, { modeId: 'general', briefId: '', confirmedNewIntent: true }),
      'brief_not_found'
    )

    // 多 brief 无定位依据 → 歧义信号（比照 findBrief 三态）
    const two = setupToolTest()
    createBrief(two.figma)
    createBrief(two.figma)
    const ambiguous = setupDesign(two.figma, {
      modeId: 'general',
      briefId: '',
      confirmedNewIntent: true
    })
    const failure = err(ambiguous, 'ambiguous_brief')
    expect(failure.candidates?.length).toBe(2)
  })

  test('⑥ modeId 校验：general 恒过 / 未知 → unknown_mode / 无尺寸 mode 同走缺省', () => {
    const { graph, run } = setupPage()

    const general = ok(run({ modeId: 'general' }))
    const generalRoot = expectDefined(graph.getNode(general.rootId))
    expect(generalRoot.width).toBe(750)
    expect(generalRoot.primaryAxisSizing).toBe('HUG')
    expect(general.name).toBe(SETUP_TEXTS.generalDesignName)

    err(run({ modeId: 'nope' }), 'unknown_mode')

    const workflow = ok(run({ modeId: 'workflow' }))
    expect(workflow.name).toBe('工作流')
    expect(workflow.size).toEqual({ width: 750, height: null })
    const workflowRoot = expectDefined(graph.getNode(workflow.rootId))
    expect(getSharedPluginData(workflowRoot, BRIEF_PLUGIN_NAMESPACE, DESIGN_MODE_KEY)).toBe(
      'workflow'
    )
  })

  test('⑧ 未确认 → awaiting_new_intent_confirmation 信封且无框落地', () => {
    const { graph, figma, brief } = setupPage()
    const before = expectDefined(graph.getNode(figma.currentPage.id)).childIds.length

    // T91b：未确认不再是错误——返 awaiting 信封。args 缺 / args=false 都返。
    const r1 = setupDesign(figma, { modeId: 'longform', briefId: brief.id }, CATALOG)
    expect(r1).toMatchObject({
      status: 'awaiting_new_intent_confirmation',
      proposed: { modeId: 'longform', briefId: brief.id }
    })
    // A3 B6：纯 general（无 profileId）静默放行——用 general+profile 维持「专项未确认仍拦」
    const r2 = setupDesign(
      figma,
      { modeId: 'general', profileId: 'profile-a', briefId: brief.id, confirmedNewIntent: false },
      CATALOG
    )
    expect(r2).toMatchObject({
      status: 'awaiting_new_intent_confirmation',
      proposed: { modeId: 'general', profileId: 'profile-a', briefId: brief.id }
    })
    expect(expectDefined(graph.getNode(figma.currentPage.id)).childIds.length).toBe(before)
    expect(scanMarketingDesigns(figma)).toEqual([])
  })

  // T91b：pluginData 路径双面——args 缺 + pluginData 确认 → 放行 + 落图后清三键；
  // args 缺 + pluginData 未确认 → 返 awaiting 信封；clearNewIntent 复位。
  test('⑧b pluginData 双源确认 + 清三键（放行 + 落图后清 + 未确认返 awaiting）', () => {
    const { graph, figma, brief } = setupPage()

    // case 1: pluginData confirmed → 放行；落图后 pluginData 三键应清
    writeNewIntent(figma, { modeId: 'longform', profileId: 'p1', confirmed: true })
    const okResult = setupDesign(figma, { modeId: 'longform', briefId: brief.id }, CATALOG)
    if ('rootId' in okResult) {
      const root = expectDefined(graph.getNode(okResult.rootId))
      expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, DESIGN_MODE_KEY)).toBe('longform')
      expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, DESIGN_PROFILE_KEY)).toBe('p1')
    } else throw new Error('expected setupDesign success')
    // A3 B2：四键（含 canvas 缺省 ''）
    expect(readNewIntent(figma)).toEqual({
      modeId: '',
      profileId: '',
      confirmed: false,
      canvas: ''
    })

    // case 2: pluginData 未确认 → awaiting 信封
    writeNewIntent(figma, { modeId: 'longform', profileId: 'p1' })
    const waitResult = setupDesign(figma, { modeId: 'longform', briefId: brief.id }, CATALOG)
    expect(waitResult).toMatchObject({
      status: 'awaiting_new_intent_confirmation',
      proposed: { modeId: 'longform', profileId: 'p1', briefId: brief.id }
    })
    clearNewIntent(figma)
    expect(readNewIntent(figma)).toEqual({
      modeId: '',
      profileId: '',
      confirmed: false,
      canvas: ''
    })
  })

  test('⑨ 关联设计区登记：条目 designId + 名称投影 + bound-designs 指针 + 读穿三元组', () => {
    const { graph, figma, brief, run } = setupPage()
    const result = ok(run({ modeId: 'longform' }))

    // T91a：bound-designs 现在存 design uniqueId（UUID），不是 node id。
    // 找 design 根的 uniqueId，断言 brief 绑了它。
    const freshBrief = expectDefined(graph.getNode(brief.id))
    const designRoot = expectDefined(graph.getNode(result.rootId))
    const designUuid = getSharedPluginData(designRoot, BRIEF_PLUGIN_NAMESPACE, 'uniqueId')
    expect(designUuid).not.toBe('')
    expect(briefBoundDesignIds(freshBrief)).toContain(designUuid)

    // 关联设计区条目：designId 标记权威 + 名称投影
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
    expect(entryText?.text).toBe('长图')

    // 读穿投影：read_brief 视图的 modeId 来自设计根标记
    const view = expectDefined(readBrief(figma))
    expect(view.designs).toEqual([
      {
        entryId,
        designId: result.rootId,
        // T91a：setup_design 路径写入 uniqueId（UUID v4）；断言非空即可
        uniqueId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        name: '长图',
        modeId: 'longform',
        deleted: false,
        registered: true
      }
    ])
  })

  test('信封字段：成功全字段（含 placement + message 锚点行）；general 缺省键不出现', () => {
    const { brief, run } = setupPage()
    const full = ok(run({ modeId: 'longform', profileId: 'profile-a' }))
    expect(full).toEqual({
      rootId: full.rootId,
      name: '长图',
      size: { width: 750, height: null },
      modeId: 'longform',
      profileId: 'profile-a',
      briefId: brief.id,
      placement: { x: BRIEF_WIDTH + PLACEMENT_GAP, y: 0 },
      // A3 B4：结果锚点行按 mode 分型——专项 workflow 推进
      message: '「长图」设计工作区已落图并成为当前设计目标——后续回合按其 workflow 推进。'
    })

    const general = ok(run({ modeId: 'general' }))
    expect('profileId' in general).toBe(false)
    expect(general.briefId).toBe(brief.id)
    // A3 B4：通用工作区无 workflow——结果行换型
    expect(general.message).toBe('设计工作区已落图并成为当前设计目标——后续回合以它为工作区续作。')
  })

  test('放置：页面内容右侧 +100，y 跟随 bounds 顶', () => {
    const { graph, figma, brief, run } = setupPage()
    // 既有内容把 bounds 顶抬到 -500（brief 在 (0,0)，宽 1252）
    graph.createNode('FRAME', figma.currentPage.id, { x: 0, y: -500, width: 100, height: 100 })

    const result = ok(run({ modeId: 'longform' }))
    expect(result.placement).toEqual({ x: BRIEF_WIDTH + PLACEMENT_GAP, y: -500 })
    const root = expectDefined(graph.getNode(result.rootId))
    expect(root.x).toBe(BRIEF_WIDTH + PLACEMENT_GAP)
    expect(root.y).toBe(-500)
    expect(brief.id).not.toBe(result.rootId)
  })

  test('创建后 scrollAndZoomIntoView：viewport 中心移到新根包围盒中心', () => {
    const { graph, figma, run } = setupPage()
    expect(figma.viewport.center).toEqual({ x: 0, y: 0 })

    const result = ok(run({ modeId: 'longform' }))
    const root = expectDefined(graph.getNode(result.rootId))
    expect(figma.viewport.center.x).toBe(root.x + root.width / 2)
    expect(figma.viewport.center.y).toBe(root.y + root.height / 2)
    expect(figma.viewport.zoom).toBeLessThanOrEqual(1)
    expect(figma.viewport.zoom).toBeGreaterThan(0)
  })

  test('catalog 缺省：仅 general（不带 profileId）可用，否则 catalog_unavailable', () => {
    const { runWithoutCatalog } = setupPage()

    const general = ok(runWithoutCatalog({ modeId: 'general' }))
    expect(general.size).toEqual({ width: 750, height: null })

    err(runWithoutCatalog({ modeId: 'longform' }), 'catalog_unavailable')
    err(runWithoutCatalog({ modeId: 'general', profileId: 'profile-a' }), 'catalog_unavailable')
  })

  test('profileId 不在册 → unknown_profile', () => {
    const { run } = setupPage()
    const failure = err(run({ modeId: 'longform', profileId: 'nope' }), 'unknown_profile')
    expect(failure.profileId).toBe('nope')
  })
})

describe('setup_design 尺寸解析（T65 §2.2）：canvas 三态 + 优先序', () => {
  test('缺省：mode 首选预设生效（sizes[0] 定高 → FIXED 2000）；无预设 mode 走 750 宽 HUG', () => {
    const { graph, run } = setupPage()
    const fixed = ok(run({ modeId: 'fixed' }))
    expect(fixed.size).toEqual({ width: 750, height: 2000 })
    const fixedRoot = expectDefined(graph.getNode(fixed.rootId))
    expect(fixedRoot.height).toBe(2000)
    expect(fixedRoot.primaryAxisSizing).toBe('FIXED')
    // 无 sizes → 缺省
    const plain = ok(run({ modeId: 'workflow' }))
    expect(plain.size).toEqual({ width: 750, height: null })
    expect(expectDefined(graph.getNode(plain.rootId)).primaryAxisSizing).toBe('HUG')
  })

  test('显式 canvas 覆盖首选预设：预设值与自由值（HUG / 定高）均可', () => {
    const { graph, run } = setupPage()
    // 预设值（longform sizes[1]）
    const preset = ok(run({ modeId: 'longform', canvas: '1080x' }))
    expect(preset.size).toEqual({ width: 1080, height: null })
    expect(expectDefined(graph.getNode(preset.rootId)).width).toBe(1080)
    // 自由定高值覆盖 fixed 的 750x2000 首选预设
    const free = ok(run({ modeId: 'fixed', canvas: '1080x1920' }))
    expect(free.size).toEqual({ width: 1080, height: 1920 })
    const freeRoot = expectDefined(graph.getNode(free.rootId))
    expect(freeRoot.height).toBe(1920)
    expect(freeRoot.primaryAxisSizing).toBe('FIXED')
    // general 无预设清单也可显式覆盖（恒过校验不查 catalog）
    const general = ok(run({ modeId: 'general', canvas: '500x800' }))
    expect(general.size).toEqual({ width: 500, height: 800 })
  })

  test('catalog 缺省：general 仍可显式 canvas；非 general 依旧 catalog_unavailable', () => {
    const { runWithoutCatalog } = setupPage()
    const general = ok(runWithoutCatalog({ modeId: 'general', canvas: '900x' }))
    expect(general.size).toEqual({ width: 900, height: null })
    err(runWithoutCatalog({ modeId: 'longform', canvas: '1080x' }), 'catalog_unavailable')
  })

  test('非法 canvas → invalid_canvas 且无框落地（非数字宽 / 缺 x / 三段 / 空串）', () => {
    const { graph, figma, run } = setupPage()
    const before = expectDefined(graph.getNode(figma.currentPage.id)).childIds.length
    for (const bad of ['abc', '750', '750x2000x3', '']) {
      const failure = err(run({ modeId: 'longform', canvas: bad }), 'invalid_canvas')
      expect(failure.message).toBe(SETUP_TEXTS.invalidCanvas(bad))
    }
    // general 路径同走校验
    err(run({ modeId: 'general', canvas: '宽750' }), 'invalid_canvas')
    expect(expectDefined(graph.getNode(figma.currentPage.id)).childIds.length).toBe(before)
    expect(scanMarketingDesigns(figma)).toEqual([])
  })
})

describe('scanMarketingDesigns / resolveMarketingDesign 无状态三态', () => {
  test('空页 → scan 空 + resolve none；brief/普通 frame 不被误认', () => {
    const { graph, figma } = setupToolTest()
    createBrief(figma)
    graph.createNode('FRAME', figma.currentPage.id, { name: '产品长图' })

    expect(scanMarketingDesigns(figma)).toEqual([])
    expect(resolveMarketingDesign(figma).status).toBe('none')
  })

  test('唯一设计 → resolve ok；scan 读穿三元组 + 名称', () => {
    const { figma, brief, run } = setupPage()
    const created = ok(run({ modeId: 'longform', profileId: 'profile-a' }))

    const designs = scanMarketingDesigns(figma)
    expect(designs).toEqual([
      {
        rootId: created.rootId,
        name: '长图',
        modeId: 'longform',
        profileId: 'profile-a',
        briefId: brief.id
      }
    ])

    const resolved = resolveMarketingDesign(figma)
    expect(resolved.status === 'ok' && resolved.design.rootId).toBe(created.rootId)
    const explicit = resolveMarketingDesign(figma, created.rootId)
    expect(explicit.status === 'ok' && explicit.design.rootId).toBe(created.rootId)
  })

  test('两个设计 → resolve ambiguous（candidates 含三元组投影）；显式 id 命中', () => {
    const { figma, run } = setupPage()
    const first = ok(run({ modeId: 'longform' }))
    const second = ok(run({ modeId: 'general' }))

    const ambiguous = resolveMarketingDesign(figma)
    expect(ambiguous.status).toBe('ambiguous')
    const candidates = ambiguous.status === 'ambiguous' ? ambiguous.candidates : []
    expect(candidates.length).toBe(2)
    const byId = new Map(candidates.map((candidate) => [candidate.rootId, candidate]))
    expect(byId.get(first.rootId)).toMatchObject({
      name: '长图',
      modeId: 'longform'
    })
    expect(byId.get(second.rootId)).toMatchObject({
      name: SETUP_TEXTS.generalDesignName,
      modeId: 'general'
    })

    const explicit = resolveMarketingDesign(figma, second.rootId)
    expect(explicit.status === 'ok' && explicit.design.rootId).toBe(second.rootId)
  })

  test('显式 id 未中 → not-found（不存在节点 / 非设计根 frame）', () => {
    const { graph, figma, run } = setupPage()
    ok(run({ modeId: 'general' }))
    const plain = graph.createNode('FRAME', figma.currentPage.id, { name: '普通' })

    expect(resolveMarketingDesign(figma, 'nonexistent')).toEqual({
      status: 'not-found',
      rootId: 'nonexistent'
    })
    expect(resolveMarketingDesign(figma, plain.id)).toEqual({
      status: 'not-found',
      rootId: plain.id
    })
  })

  test('死节点不出现：删除设计根后 scan 为空 + resolve none', () => {
    const { graph, figma, run } = setupPage()
    const created = ok(run({ modeId: 'general' }))
    expect(scanMarketingDesigns(figma).length).toBe(1)

    graph.deleteNode(created.rootId)
    expect(scanMarketingDesigns(figma)).toEqual([])
    expect(resolveMarketingDesign(figma).status).toBe('none')
    expect(resolveMarketingDesign(figma, created.rootId)).toEqual({
      status: 'not-found',
      rootId: created.rootId
    })
  })

  test('两次扫描独立：无进程态，图面变化即时反映', () => {
    const { figma, run } = setupPage()
    ok(run({ modeId: 'general' }))

    const first = scanMarketingDesigns(figma)
    expect(first.length).toBe(1)

    const second = ok(run({ modeId: 'general' }))
    const secondScan = scanMarketingDesigns(figma)
    expect(secondScan).not.toBe(first)
    expect(secondScan.length).toBe(2)
    expect(secondScan.map((design) => design.rootId)).toContain(second.rootId)
  })
})

describe('setup_design ToolDef：schema 与注入缝', () => {
  test('SETUP_TOOLS 交付面 + mutates 钉扎 + schema 四参数（T65 加 canvas 可选）', () => {
    expect(SETUP_TOOLS).toEqual([setupDesignTool])
    expect(setupDesignTool.name).toBe('setup_design')
    expect(setupDesignTool.mutates).toBe(true)
    // PR697 后钉扎 wire contract（LLM 可见的 JSON Schema）而非内部 ParamDef
    const schema = toolInputSchema(setupDesignTool)
    expect(Object.keys(schema.properties)).toEqual(['modeId', 'profileId', 'briefId', 'canvas'])
    expect(schema.required).toEqual(['modeId', 'briefId'])
  })

  test('__catalog JSON + __confirmedNewIntent=true 注入 → 建框成功', () => {
    const { graph, figma } = setupToolTest()
    const brief = createBrief(figma)

    const result = setupDesignTool.execute(figma, {
      modeId: 'longform',
      briefId: brief.id,
      __catalog: JSON.stringify(CATALOG),
      __confirmedNewIntent: 'true'
    }) as SetupDesignResult
    const success = ok(result)
    const root = expectDefined(graph.getNode(success.rootId))
    expect(getSharedPluginData(root, BRIEF_PLUGIN_NAMESPACE, DESIGN_MODE_KEY)).toBe('longform')
  })

  test('canvas schema 参数透传 core：预设值生效；非法值 → invalid_canvas', () => {
    const { graph, figma } = setupToolTest()
    const brief = createBrief(figma)

    const result = setupDesignTool.execute(figma, {
      modeId: 'longform',
      briefId: brief.id,
      canvas: '1080x',
      __catalog: JSON.stringify(CATALOG),
      __confirmedNewIntent: 'true'
    }) as SetupDesignResult
    const success = ok(result)
    expect(success.size).toEqual({ width: 1080, height: null })
    expect(expectDefined(graph.getNode(success.rootId)).width).toBe(1080)

    const invalid = setupDesignTool.execute(figma, {
      modeId: 'longform',
      briefId: brief.id,
      canvas: 'not-a-size',
      __catalog: JSON.stringify(CATALOG),
      __confirmedNewIntent: 'true'
    }) as SetupDesignResult
    err(invalid, 'invalid_canvas')
  })

  test('无 __confirmedNewIntent → awaiting_new_intent_confirmation 信封（T91b 非错误路径）', () => {
    const { graph, figma } = setupToolTest()
    const brief = createBrief(figma)
    const before = expectDefined(graph.getNode(figma.currentPage.id)).childIds.length

    // T91b：args.__confirmedNewIntent 缺省 = 未确认 = 返 awaiting 信封
    // A3 B6：纯 general（无 profileId）已静默放行——改用专项 mode 维持「未确认仍拦」
    const result = setupDesignTool.execute(figma, {
      modeId: 'longform',
      briefId: brief.id,
      __catalog: JSON.stringify(CATALOG)
    }) as SetupDesignResult
    expect(result).toMatchObject({
      status: 'awaiting_new_intent_confirmation',
      proposed: { modeId: 'longform', briefId: brief.id }
    })
    expect(expectDefined(graph.getNode(figma.currentPage.id)).childIds.length).toBe(before)
  })

  test('A3 B6：纯 general（无 profileId）静默放行——无 awaiting 信封，无 __confirmedNewIntent 也建框', () => {
    const { graph, figma } = setupToolTest()
    const brief = createBrief(figma)
    const before = expectDefined(graph.getNode(figma.currentPage.id)).childIds.length

    const result = setupDesignTool.execute(figma, {
      modeId: 'general',
      briefId: brief.id,
      __catalog: JSON.stringify(CATALOG)
    }) as SetupDesignResult
    expect('error' in result).toBe(false)
    expect('status' in result).toBe(false)
    if ('rootId' in result) {
      expect(result.message).toBe('设计工作区已落图并成为当前设计目标——后续回合以它为工作区续作。')
    } else throw new Error('expected success')
    expect(expectDefined(graph.getNode(figma.currentPage.id)).childIds.length).toBe(before + 1)
  })

  test('无 __catalog：general 可用、非 general catalog_unavailable；畸形 JSON 按未注入', () => {
    const { figma } = setupToolTest()
    const brief = createBrief(figma)

    const general = setupDesignTool.execute(figma, {
      modeId: 'general',
      briefId: brief.id,
      __confirmedNewIntent: 'true'
    }) as SetupDesignResult
    expect('error' in general).toBe(false)

    const noCatalog = setupDesignTool.execute(figma, {
      modeId: 'longform',
      briefId: brief.id,
      __confirmedNewIntent: 'true'
    }) as SetupDesignResult
    err(noCatalog, 'catalog_unavailable')

    const malformed = setupDesignTool.execute(figma, {
      modeId: 'longform',
      briefId: brief.id,
      __catalog: '{not json',
      __confirmedNewIntent: 'true'
    }) as SetupDesignResult
    err(malformed, 'catalog_unavailable')
  })
})
