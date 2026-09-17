/**
 * T57（S4 W2 / T-B6）prepare_hero_scaffold 契约测试（T57-plan §3 八项改写版）。
 *
 * 验收映射：
 * ① 无骨架可克隆（标题前置 source 直接成 scaffold，root 内无 HeroContent）；
 * ② 几何记录写入四字段 + readHeroGeometry 读回 / 缺记录与畸形记录 → null；
 * ③ 钳制断言（transition>underlap → clamp+clamped:true；缺省 100/100；
 *   非有限/负/超上限 → invalid_params 结构化错误且不建框）；
 * ④ 幂等 upsert（重调保 scaffold id + 刷新记录 + 重克隆 + 位置不右漂）；
 * ⑤ IMAGE fill 保留 / 非 IMAGE fill 重置白底；
 * ⑥ findPlacementPosition 集成（页面 bounds 右 +100、y 跟随 bounds 顶）；
 * ⑦ source/root 校验错误路径（缺 id/不存在/非 FRAME/无子节点/无自动布局）；
 * ⑧ 信封字段钉扎（note 仅事实，无 generate_image/compose_backdrop 指令链）。
 *
 * 旧测试拓扑平移（open-pencil tests/engine/tools/marketing/
 * prepare-hero-scaffold.test.ts 的 validation/geometry/idempotency/params 组），
 * 假 figma 换 setupToolTest() 真 SceneGraph+FigmaAPI。HERO_TOOLS 未注册进
 * FORK_TOOLS（fork/index.ts 是集成期主 agent 领土），直接 import 定义。
 */

import { describe, expect, test } from 'bun:test'

import type { SceneGraph } from '@open-pencil/core'

import { getSharedPluginData, setSharedPluginData } from '#core/figma-api/plugin-data'
import { BRIEF_PLUGIN_NAMESPACE } from '#core/tools/fork/marketing/brief'
import {
  HERO_GEOMETRY_KEY,
  HERO_TEXTS,
  readHeroGeometry,
  type HeroGeometry,
  type PrepareHeroScaffoldError,
  type PrepareHeroScaffoldErrorCode,
  type PrepareHeroScaffoldResult,
  type PrepareHeroScaffoldSuccess
} from '#core/tools/fork/marketing/hero-scaffold'
import { HERO_TOOLS, prepareHeroScaffoldTool } from '#core/tools/fork/marketing/hero-tools'
import { PLACEMENT_GAP } from '#core/tools/fork/placement'

import { childIdAt, expectDefined } from '#tests/helpers/assert'
import { setupToolTest, toolInputSchema } from '#tests/helpers/tools'

function makeRoot(graph: SceneGraph, pageId: string, position = { x: 200, y: 300 }) {
  return graph.createNode('FRAME', pageId, {
    name: '产品长图',
    x: position.x,
    y: position.y,
    width: 750,
    height: 2120,
    layoutMode: 'VERTICAL'
  })
}

/** 标题前置版式：页面级独立 frame（骨架/HeroContent 不存在也可作克隆源） */
function makeHeadlineSource(graph: SceneGraph, pageId: string, position = { x: 1000, y: 100 }) {
  const source = graph.createNode('FRAME', pageId, {
    name: '标题版式',
    x: position.x,
    y: position.y,
    width: 750,
    height: 750
  })
  graph.createNode('TEXT', source.id, {
    name: 'Title',
    x: 60,
    y: 120,
    width: 630,
    height: 120,
    text: '端午安康'
  })
  graph.createNode('TEXT', source.id, {
    name: 'Subtitle',
    x: 60,
    y: 280,
    width: 400,
    height: 40,
    text: '粽叶飘香'
  })
  return source
}

function makeImageFill() {
  return {
    type: 'IMAGE' as const,
    color: { r: 0, g: 0, b: 0, a: 0 },
    opacity: 1,
    visible: true,
    imageHash: 'deadbeef',
    imageScaleMode: 'FILL' as const
  }
}

function ok(result: PrepareHeroScaffoldResult): PrepareHeroScaffoldSuccess {
  if ('error' in result) throw new Error(`unexpected error: ${result.error} ${result.message}`)
  return result
}

function err(
  result: PrepareHeroScaffoldResult,
  code: PrepareHeroScaffoldErrorCode
): PrepareHeroScaffoldError {
  if (!('error' in result)) throw new Error(`expected error ${code}, got success`)
  expect(result.error).toBe(code)
  expect(result.message).toBeTruthy()
  // 结构化错误面钉扎：仅 { error, message } 两键
  expect(Object.keys(result).sort()).toEqual(['error', 'message'])
  return result
}

/** 一页一根（自动布局、无 HeroContent 子节点）+ 一标题版式源的标准前置 */
function setupPage() {
  const { graph, figma } = setupToolTest()
  const pageId = figma.currentPage.id
  const root = makeRoot(graph, pageId)
  const source = makeHeadlineSource(graph, pageId)
  const run = (extra: Record<string, unknown> = {}) =>
    prepareHeroScaffoldTool.execute(figma, {
      root_id: root.id,
      source_node_id: source.id,
      ...extra
    }) as PrepareHeroScaffoldResult
  return { graph, figma, pageId, root, source, run }
}

test('工具定义钉扎：name/mutates/input + HERO_TOOLS 交付面', () => {
  expect(prepareHeroScaffoldTool.name).toBe('prepare_hero_scaffold')
  expect(prepareHeroScaffoldTool.mutates).toBe(true)
  // PR697 后钉扎 wire contract（LLM 可见的 JSON Schema）而非内部 ParamDef
  const schema = toolInputSchema(prepareHeroScaffoldTool)
  expect(schema.required).toEqual(['root_id', 'source_node_id'])
  expect(schema.properties.underlap_px?.default).toBe(100)
  expect(schema.properties.underlap_px?.minimum).toBe(0)
  expect(schema.properties.underlap_px?.maximum).toBe(1000)
  expect(schema.properties.transition_zone_px?.default).toBe(100)
  expect(schema.properties.transition_zone_px?.minimum).toBe(0)
  expect(HERO_TOOLS.map((tool) => tool.name)).toEqual(['prepare_hero_scaffold'])
  expect(HERO_GEOMETRY_KEY).toBe('hero-geometry')
  expect(BRIEF_PLUGIN_NAMESPACE).toBe('open-pencil-marketing')
  expect(HERO_TEXTS.scaffoldName).toBe('Hero生成参考')
})

describe('⑦ 校验错误路径', () => {
  test('root_id / source_node_id 空串 → invalid_params', () => {
    const { run } = setupPage()
    const missingRoot = err(run({ root_id: '' }), 'invalid_params')
    expect(missingRoot.message).toContain('root_id')
    const missingSource = err(run({ source_node_id: '' }), 'invalid_params')
    expect(missingSource.message).toContain('source_node_id')
  })

  test('root 不存在 / 非 FRAME / 无自动布局', () => {
    const { graph, pageId, run } = setupPage()
    err(run({ root_id: 'missing' }), 'root_not_found')

    const notFrame = err(run({ root_id: pageId }), 'root_not_frame')
    expect(notFrame.message).toContain('CANVAS')
    const textNode = graph.createNode('TEXT', pageId, { name: 'LooseText', text: '散文本' })
    err(run({ root_id: textNode.id }), 'root_not_frame')

    const freeRoot = graph.createNode('FRAME', pageId, {
      name: 'FreeRoot',
      width: 750,
      height: 2120,
      layoutMode: 'NONE'
    })
    const noAutoLayout = err(run({ root_id: freeRoot.id }), 'root_not_auto_layout')
    expect(noAutoLayout.message).toContain('自动布局')
  })

  test('source 不存在 / 非 FRAME / 无子节点', () => {
    const { graph, pageId, run } = setupPage()
    err(run({ source_node_id: 'missing' }), 'source_not_found')

    const textNode = graph.createNode('TEXT', pageId, { name: 'LooseText2', text: '散文本' })
    err(run({ source_node_id: textNode.id }), 'source_not_frame')

    const emptyFrame = graph.createNode('FRAME', pageId, {
      name: '空版式',
      width: 750,
      height: 750
    })
    err(run({ source_node_id: emptyFrame.id }), 'source_empty')
  })

  test('校验失败不建框：页面顶层节点数不变', () => {
    const { graph, pageId, run } = setupPage()
    const before = graph.getNode(pageId)?.childIds.length
    // PR697：schema 级违规（负值）由 v.parse 前置抛错，不进工具体
    expect(() => run({ underlap_px: -5 })).toThrow()
    expect(graph.getNode(pageId)?.childIds.length).toBe(before)
  })
})

describe('③ 几何参数校验与钳制', () => {
  test('缺省 100/100：不钳制，envelope 与记录一致', () => {
    const { graph, run } = setupPage()
    const built = ok(run())
    expect(built.underlap_px).toBe(100)
    expect(built.transition_zone_px).toBe(100)
    expect(built.clamped).toBe(false)
    expect(built.height).toBe(850)
    const record = readHeroGeometry(graph, expectDefined(graph.getNode(built.scaffold_id)))
    expect(record).toEqual({ width: 750, height: 850, underlapPx: 100, transitionZonePx: 100 })
  })

  test('transition > underlap → 钳到 underlap 且 clamped:true（记录存钳后值）', () => {
    const { graph, run } = setupPage()
    const built = ok(run({ transition_zone_px: 250 }))
    expect(built.transition_zone_px).toBe(100)
    expect(built.clamped).toBe(true)
    expect(built.note).toContain('clamped')
    const record = readHeroGeometry(graph, expectDefined(graph.getNode(built.scaffold_id)))
    expect(record?.transitionZonePx).toBe(100)
  })

  test('transition < underlap → 不钳制；underlap 0 边界合法且 transition 钳到 0', () => {
    const { graph, run } = setupPage()
    const below = ok(run({ transition_zone_px: 50 }))
    expect(below.transition_zone_px).toBe(50)
    expect(below.clamped).toBe(false)

    const zeroUnderlap = ok(run({ underlap_px: 0 }))
    expect(zeroUnderlap.underlap_px).toBe(0)
    expect(zeroUnderlap.transition_zone_px).toBe(0)
    expect(zeroUnderlap.clamped).toBe(true)
    expect(zeroUnderlap.height).toBe(750)
    expect(graph.getNode(zeroUnderlap.scaffold_id)?.height).toBe(750)
  })

  test('非有限/负/超上限 → schema 前置拒绝（v.parse 抛错）', () => {
    // PR697：数值域违规全部由 input schema 的 minValue/maxValue 前置拦截，
    // 不再进工具体的 invalid_params 信封路径
    const { run } = setupPage()
    expect(() => run({ underlap_px: -5 })).toThrow()
    expect(() => run({ underlap_px: 5000 })).toThrow()
    expect(() => run({ underlap_px: Number.NaN })).toThrow()
    expect(() => run({ underlap_px: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => run({ transition_zone_px: -1 })).toThrow()
    expect(() => run({ transition_zone_px: Number.NaN })).toThrow()
  })
})

describe('①②⑥ 几何与拓扑（无骨架直克隆 + 记录 + 放置）', () => {
  test('① 无 HeroContent/骨架：标题前置源直接克隆成页面级 scaffold', () => {
    const { graph, pageId, root, source, run } = setupPage()
    // 前置钉扎：root 内无任何子节点（骨架不存在）
    expect(root.childIds.length).toBe(0)

    const built = ok(run())

    const scaffold = expectDefined(graph.getNode(built.scaffold_id), 'scaffold')
    expect(scaffold.name).toBe('Hero生成参考')
    // 页面级兄弟——不做 root 子节点（HUG 高根 frame 不得被 scaffold 撑高）
    expect(scaffold.parentId).toBe(pageId)
    expect(root.childIds).not.toContain(scaffold.id)
    expect(scaffold.layoutMode).toBe('NONE')
    expect(scaffold.clipsContent).toBe(true)
    expect(scaffold.fills[0]).toMatchObject({ type: 'SOLID', color: { r: 1, g: 1, b: 1 } })

    expect(built.width).toBe(750)
    expect(built.height).toBe(850)
    expect(built.cloned_children).toBe(2)
    expect(scaffold.childIds.length).toBe(2)

    // 坐标原样拷贝 + ABSOLUTE：版式占 scaffold 顶部 750px，无需换算
    const title = expectDefined(graph.getNode(childIdAt(scaffold, 0)), 'title clone')
    expect(title.name).toBe('Title')
    expect(title.x).toBe(60)
    expect(title.y).toBe(120)
    expect(title.width).toBe(630)
    expect(title.height).toBe(120)
    expect(title.text).toBe('端午安康')
    expect(title.layoutPositioning).toBe('ABSOLUTE')
    const subtitle = expectDefined(graph.getNode(childIdAt(scaffold, 1)), 'subtitle clone')
    expect(subtitle.y).toBe(280)
    // 克隆 ≠ 引用：源子节点仍在源上
    expect(source.childIds.length).toBe(2)
  })

  test('② 几何记录写入四字段并可读回；缺记录/畸形记录 → null', () => {
    const { graph, root, run } = setupPage()
    const built = ok(run())
    const scaffold = expectDefined(graph.getNode(built.scaffold_id), 'scaffold')

    const raw = getSharedPluginData(scaffold, BRIEF_PLUGIN_NAMESPACE, HERO_GEOMETRY_KEY)
    expect(raw).not.toBe('')
    const parsed = JSON.parse(raw) as HeroGeometry
    expect(Object.keys(parsed).sort()).toEqual([
      'height',
      'transitionZonePx',
      'underlapPx',
      'width'
    ])
    expect(parsed).toEqual({ width: 750, height: 850, underlapPx: 100, transitionZonePx: 100 })

    // readHeroGeometry 读回同值（T58 消费口）
    expect(readHeroGeometry(graph, scaffold)).toEqual(parsed)
    // 缺记录 → null（不静默默认）
    expect(readHeroGeometry(graph, root)).toBe(null)
    // 畸形记录 → null
    setSharedPluginData(graph, scaffold, BRIEF_PLUGIN_NAMESPACE, HERO_GEOMETRY_KEY, 'not-json')
    expect(readHeroGeometry(graph, scaffold)).toBe(null)
  })

  test('⑥ findPlacementPosition：页面 bounds 右侧 +100，y 跟随 bounds 顶', () => {
    const { graph, run } = setupPage()
    // root (200,300,750×2120) ∪ source (1000,100,750×750)
    // → bounds x 200..1750, y 100..2420
    const built = ok(run())
    const scaffold = expectDefined(graph.getNode(built.scaffold_id), 'scaffold')
    expect(scaffold.x).toBe(1750 + PLACEMENT_GAP)
    expect(scaffold.y).toBe(100)
  })

  test('⑥ 内容贴原点时 y = 0（空页原点语义由 placement.test.ts 钉扎）', () => {
    const { graph, figma } = setupToolTest()
    const pageId = figma.currentPage.id
    const root = makeRoot(graph, pageId, { x: 0, y: 0 })
    const source = makeHeadlineSource(graph, pageId, { x: 0, y: 0 })
    const built = ok(
      prepareHeroScaffoldTool.execute(figma, {
        root_id: root.id,
        source_node_id: source.id
      }) as PrepareHeroScaffoldResult
    )
    const scaffold = expectDefined(graph.getNode(built.scaffold_id), 'scaffold')
    expect(scaffold.x).toBe(750 + PLACEMENT_GAP)
    expect(scaffold.y).toBe(0)
  })
})

describe('④⑤ 幂等重调', () => {
  test('④ 重调保 scaffold id + 刷新几何记录 + 重克隆（旧克隆整体替换）+ 位置不右漂', () => {
    const { graph, source, run } = setupPage()

    const first = ok(run())
    const firstScaffold = expectDefined(graph.getNode(first.scaffold_id), 'scaffold')
    const firstCloneIds = [...firstScaffold.childIds]

    // 文案变更：源加 Logo、源 Title 移位改字；用户挪动过旧克隆
    graph.createNode('TEXT', source.id, { name: 'Logo', x: 60, y: 40, width: 80, height: 80 })
    graph.updateNode(childIdAt(firstScaffold, 0), { y: 999 })
    const sourceTitleId = childIdAt(source, 0)
    graph.updateNode(sourceTitleId, { y: 140, text: '端午安康·2026' })
    // 源整体右移：若重调走重定位，scaffold 会随之右漂——钉扎不动
    graph.updateNode(source.id, { x: 2000 })

    const second = ok(run({ underlap_px: 250 }))

    expect(second.scaffold_id).toBe(first.scaffold_id)
    expect(second.height).toBe(1000)
    expect(second.cloned_children).toBe(3)
    const scaffold = expectDefined(graph.getNode(second.scaffold_id), 'scaffold')
    expect(scaffold.x).toBe(firstScaffold.x)
    expect(scaffold.y).toBe(firstScaffold.y)
    expect(scaffold.childIds.length).toBe(3)
    // 旧克隆整体删除（替换而非修补）
    for (const staleId of firstCloneIds) {
      expect(graph.getNode(staleId)).toBeUndefined()
    }
    const names = scaffold.childIds.map((id) => graph.getNode(id)?.name)
    expect(names).toEqual(['Title', 'Subtitle', 'Logo'])
    const title = expectDefined(graph.getNode(childIdAt(scaffold, 0)), 'refreshed title clone')
    expect(title.y).toBe(140)
    expect(title.text).toBe('端午安康·2026')

    // 几何记录刷新（height = 750 + 250）
    const record = readHeroGeometry(graph, scaffold)
    expect(record).toEqual({ width: 750, height: 1000, underlapPx: 250, transitionZonePx: 100 })

    // 按名寻址幂等：页上仍只有一个 Hero生成参考
    const page = expectDefined(graph.getNode(scaffold.parentId ?? ''), 'page')
    const scaffolds = page.childIds.filter(
      (id) => graph.getNode(id)?.name === HERO_TEXTS.scaffoldName
    )
    expect(scaffolds.length).toBe(1)
  })

  test('⑤ 既有 IMAGE fill 保留（hero 已生成），只刷新幽灵文案层', () => {
    const { graph, run } = setupPage()
    const first = ok(run())
    graph.updateNode(first.scaffold_id, { fills: [makeImageFill()] })

    const second = ok(run())

    const scaffold = expectDefined(graph.getNode(second.scaffold_id), 'scaffold')
    expect(scaffold.fills[0]?.type).toBe('IMAGE')
    expect(scaffold.fills[0]?.imageHash).toBe('deadbeef')
    expect(scaffold.childIds.length).toBe(2)
  })

  test('⑤ 非 IMAGE fill 重调时重置白底', () => {
    const { graph, run } = setupPage()
    const first = ok(run())
    graph.updateNode(first.scaffold_id, {
      fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }]
    })

    const second = ok(run())

    const fill = expectDefined(graph.getNode(second.scaffold_id)?.fills[0], 'scaffold fill')
    expect(fill.type).toBe('SOLID')
    expect(fill.color).toEqual({ r: 1, g: 1, b: 1, a: 1 })
  })
})

describe('⑧ 信封钉扎', () => {
  test('成功信封恰为八字段；note 仅事实（源 id/克隆数/钳制），无指令链', () => {
    const { source, run } = setupPage()
    const built = ok(run())
    expect(Object.keys(built).sort()).toEqual([
      'clamped',
      'cloned_children',
      'height',
      'note',
      'scaffold_id',
      'transition_zone_px',
      'underlap_px',
      'width'
    ])
    expect(built.note).toContain(source.id)
    expect(built.note).toContain('2')
    expect(built.note).not.toContain('clamped')
    // 旧 buildNote 指令链不移植
    expect(built.note).not.toContain('generate_image')
    expect(built.note).not.toContain('compose_backdrop')
    expect(built.note).not.toContain('replace_id')
  })
})
