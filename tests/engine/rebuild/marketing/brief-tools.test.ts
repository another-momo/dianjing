/**
 * T52（S4 W2 / T-B1）brief 三件套 ToolDef 契约测试（S3 §10 旧断言平移 + 新增）。
 *
 * 平移自 open-pencil tests/engine/tools/marketing/brief-tools.test.ts：
 * {brief:null} 正常态 / 内容·素材·结论回读 / 素材 imageNodeId 暴露 /
 * 幂等 {created:false} / 逐字转录 / 空文本拒绝 / 结论保序。
 * 新增（四区改造 + 歧义防护补齐）：双路歧义结构、显式 briefId 参数、
 * 设计归属分组（design_id）、mutates 标志钉扎、scrollAndZoomIntoView 行为断言。
 *
 * BRIEF_TOOLS 未注册进 FORK_TOOLS（fork/index.ts 是集成期主 agent 领土），
 * 故直接 import 定义而非走 getTool(ALL_TOOLS)。
 */

import { describe, expect, test } from 'bun:test'

import { BRIEF_TOOLS } from '#core/tools/fork/marketing'
import {
  addBriefMaterialEntry,
  createBrief,
  findBrief,
  type BriefCandidate
} from '#core/tools/fork/marketing/brief'

import { expectDefined } from '#tests/helpers/assert'
import { setupToolTest } from '#tests/helpers/tools'

interface ReadBriefResult {
  brief?: null
  ambiguous?: boolean
  candidates?: BriefCandidate[]
  error?: string
  note?: string
  briefId?: string
  boundDesigns?: Array<{ rootFrameId: string; name: string; page: string | null }>
  designs?: Array<{
    entryId: string | null
    designId: string
    name: string
    deleted: boolean
  }>
  content?: string
  materials?: Array<{
    entryId: string
    imageNodeId: string | null
    caption: string
    hasImage: boolean
  }>
  conclusions?: Array<{ text: string; designId: string | null; designName: string | null }>
}

interface CreateBriefResult {
  briefId?: string
  created: boolean
  ambiguous?: boolean
  candidates?: BriefCandidate[]
  note?: string
}

interface AppendConclusionResult {
  ok: boolean
  ambiguous?: boolean
  candidates?: BriefCandidate[]
  error?: string
  note?: string
}

function getBriefTool(name: string) {
  return expectDefined(
    BRIEF_TOOLS.find((tool) => tool.name === name),
    `tool ${name}`
  )
}

test('mutates 标志钉扎：read 只读，create/append 变更', () => {
  expect(getBriefTool('read_brief').mutates).toBe(false)
  expect(getBriefTool('create_brief').mutates).toBe(true)
  expect(getBriefTool('append_brief_conclusion').mutates).toBe(true)
})

describe('read_brief tool', () => {
  test('无 brief → { brief: null } 正常态', () => {
    const { figma } = setupToolTest()
    const result = getBriefTool('read_brief').execute(figma, {}) as ReadBriefResult
    expect(result.brief).toBe(null)
    expect(result.briefId).toBeUndefined()
    expect(result.error).toBeUndefined()
  })

  test('回读内容、空素材、空结论、空关联设计区', () => {
    const { figma } = setupToolTest()
    const brief = createBrief(figma)

    const result = getBriefTool('read_brief').execute(figma, {}) as ReadBriefResult
    expect(result.brief).toBeUndefined()
    expect(result.briefId).toBe(brief.id)
    expect(result.content).toContain('XX奶茶')
    expect(result.materials).toEqual([])
    expect(result.conclusions).toEqual([])
    expect(result.designs).toEqual([])
  })

  test('素材条目暴露 imageNodeId / caption / hasImage', () => {
    const { graph, figma } = setupToolTest()
    const brief = createBrief(figma)
    const added = addBriefMaterialEntry(figma, brief.id, new Uint8Array([1, 2, 3]), '主视觉')
    if (!('entryId' in added)) throw new Error('expected entryId')

    const result = getBriefTool('read_brief').execute(figma, {}) as ReadBriefResult
    const material = expectDefined(result.materials?.[0])
    expect(material.entryId).toBe(added.entryId)
    expect(material.caption).toBe('主视觉')
    expect(material.hasImage).toBe(true)

    const imageNode = expectDefined(
      material.imageNodeId ? graph.getNode(material.imageNodeId) : undefined
    )
    expect(imageNode.name).toBe('图片位')
    expect(imageNode.fills[0]?.type).toBe('IMAGE')
  })

  test('多 brief 无 briefId → 歧义结构；显式 briefId 直接读', () => {
    const { figma } = setupToolTest()
    const first = createBrief(figma)
    const second = createBrief(figma)

    const ambiguous = getBriefTool('read_brief').execute(figma, {}) as ReadBriefResult
    expect(ambiguous.brief).toBe(null)
    expect(ambiguous.ambiguous).toBe(true)
    expect(ambiguous.candidates?.length).toBe(2)
    expect(ambiguous.note).toBeDefined()

    const explicit = getBriefTool('read_brief').execute(figma, {
      briefId: second.id
    }) as ReadBriefResult
    expect(explicit.briefId).toBe(second.id)
    expect(explicit.ambiguous).toBeUndefined()

    const other = getBriefTool('read_brief').execute(figma, {
      briefId: first.id
    }) as ReadBriefResult
    expect(other.briefId).toBe(first.id)
  })

  test('briefId 指向不存在的节点 → { brief: null, error }', () => {
    const { figma } = setupToolTest()
    const result = getBriefTool('read_brief').execute(figma, {
      briefId: 'nonexistent'
    }) as ReadBriefResult
    expect(result.brief).toBe(null)
    expect(result.error).toBeDefined()
  })
})

describe('create_brief tool', () => {
  test('空页创建（created:true），落原点', () => {
    const { graph, figma } = setupToolTest()
    const result = getBriefTool('create_brief').execute(figma, {}) as CreateBriefResult
    expect(result.created).toBe(true)
    const brief = expectDefined(graph.getNode(expectDefined(result.briefId)))
    expect(brief.x).toBe(0)
    expect(brief.y).toBe(0)
    const resolution = findBrief(figma)
    expect(resolution.status === 'ok' && resolution.brief.id).toBe(result.briefId)
  })

  test('幂等：页上已有唯一 brief → { created:false } 且不新建', () => {
    const { figma } = setupToolTest()
    const first = getBriefTool('create_brief').execute(figma, {}) as CreateBriefResult
    const second = getBriefTool('create_brief').execute(figma, {}) as CreateBriefResult
    expect(second.created).toBe(false)
    expect(second.briefId).toBe(first.briefId)
    expect(findBrief(figma).status).toBe('ok')
  })

  test('initial_content 逐字转录进内容区', () => {
    const { figma } = setupToolTest()
    const verbatim = '做一个「如何用AI做长图」的讲座邀请长图'
    const result = getBriefTool('create_brief').execute(figma, {
      initial_content: verbatim
    }) as CreateBriefResult
    expect(result.created).toBe(true)

    const view = getBriefTool('read_brief').execute(figma, {}) as ReadBriefResult
    expect(view.content).toBe(verbatim)
  })

  test('多 brief 无定位依据 → { created:false, ambiguous:true, candidates }，不再新建', () => {
    const { figma } = setupToolTest()
    createBrief(figma)
    createBrief(figma)

    const result = getBriefTool('create_brief').execute(figma, {}) as CreateBriefResult
    expect(result.created).toBe(false)
    expect(result.ambiguous).toBe(true)
    expect(result.candidates?.length).toBe(2)
    // 没有静默新建第三个
    const resolution = findBrief(figma)
    expect(resolution.status === 'ambiguous' && resolution.candidates.length).toBe(2)
  })

  test('创建后 scrollAndZoomIntoView：viewport 中心移到 brief 包围盒中心', () => {
    const { graph, figma } = setupToolTest()
    // 前置态：默认 viewport 中心 (0,0)
    expect(figma.viewport.center).toEqual({ x: 0, y: 0 })

    const result = getBriefTool('create_brief').execute(figma, {}) as CreateBriefResult
    const brief = expectDefined(graph.getNode(expectDefined(result.briefId)))

    expect(figma.viewport.center.x).toBe(brief.x + brief.width / 2)
    expect(figma.viewport.center.y).toBe(brief.y + brief.height / 2)
    expect(figma.viewport.zoom).toBeLessThanOrEqual(1)
    expect(figma.viewport.zoom).toBeGreaterThan(0)
  })
})

describe('append_brief_conclusion tool', () => {
  test('无 brief → { ok:false }', () => {
    const { figma } = setupToolTest()
    const result = getBriefTool('append_brief_conclusion').execute(figma, {
      text: '方向A：水彩萌趣'
    }) as AppendConclusionResult
    expect(result.ok).toBe(false)
  })

  test('追加可被 read_brief 回读，调用次序保序', () => {
    const { figma } = setupToolTest()
    createBrief(figma)

    const tool = getBriefTool('append_brief_conclusion')
    expect((tool.execute(figma, { text: '方向A：水彩萌趣' }) as AppendConclusionResult).ok).toBe(
      true
    )
    expect(
      (tool.execute(figma, { text: '字体：Alibaba PuHuiTi' }) as AppendConclusionResult).ok
    ).toBe(true)

    const view = getBriefTool('read_brief').execute(figma, {}) as ReadBriefResult
    expect(view.conclusions).toEqual([
      { text: '方向A：水彩萌趣', designId: null, designName: null },
      { text: '字体：Alibaba PuHuiTi', designId: null, designName: null }
    ])
  })

  test('空文本拒绝且不碰 brief', () => {
    const { figma } = setupToolTest()
    createBrief(figma)

    const result = getBriefTool('append_brief_conclusion').execute(figma, {
      text: '   '
    }) as AppendConclusionResult
    expect(result.ok).toBe(false)

    const view = getBriefTool('read_brief').execute(figma, {}) as ReadBriefResult
    expect(view.conclusions).toEqual([])
  })

  test('多 brief 无 briefId → { ok:false, ambiguous:true, candidates }；显式 briefId 追加成功', () => {
    const { figma } = setupToolTest()
    const first = createBrief(figma)
    createBrief(figma)

    const tool = getBriefTool('append_brief_conclusion')
    const ambiguous = tool.execute(figma, { text: '方向A' }) as AppendConclusionResult
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.ambiguous).toBe(true)
    expect(ambiguous.candidates?.length).toBe(2)

    const targeted = tool.execute(figma, {
      text: '方向A',
      briefId: first.id
    }) as AppendConclusionResult
    expect(targeted.ok).toBe(true)

    const view = getBriefTool('read_brief').execute(figma, { briefId: first.id }) as ReadBriefResult
    expect(view.conclusions?.map((line) => line.text)).toEqual(['方向A'])
  })

  test('design_id 归组：结论带设计名称 + id 归属', () => {
    const { graph, figma } = setupToolTest()
    createBrief(figma)
    const design = graph.createNode('FRAME', figma.currentPage.id, { name: '产品长图' })

    const result = getBriefTool('append_brief_conclusion').execute(figma, {
      text: '方向B：活力几何',
      design_id: design.id
    }) as AppendConclusionResult
    expect(result.ok).toBe(true)

    const view = getBriefTool('read_brief').execute(figma, {}) as ReadBriefResult
    expect(view.conclusions).toEqual([
      { text: '方向B：活力几何', designId: design.id, designName: '产品长图' }
    ])
  })
})
