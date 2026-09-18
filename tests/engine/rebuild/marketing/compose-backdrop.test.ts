/**
 * T58（Phase 3 W3 / T-B8）compose_backdrop 契约测试（T58-plan §3 清单）。
 *
 * 验收映射：
 * ① 工具定义钉扎（散参 canvas_width/hero_height/hero_bleed 删除）；
 * ② 校验错误路径（root 缺失/非 FRAME/无自动布局/尺寸越界/hex 拒收进 note）；
 * ③ 几何消费（记录读出/缺记录报错/畸形报错/canvas_height 缺省=root.height）；
 * ④ 拓扑 z 序三钉扎 + HeroContent flow slot + fills=[] 强制；
 * ⑤ 渐变契约（BaseWash 5%→白、Overlay 三段 + 竖直 transform）；
 * ⑥ 颜色管线三级降级 + 采样失败白兜底（注入假采样器）+ 采样带 =
 *    transitionZonePx + 缺省真采样器 seam（字节未加载，不触 CanvasKit）；
 * ⑦ hero_image_from fill transfer + 幂等不重复转移 + 外部来源语义分支；
 * ⑧ 新报错（HeroContent 含图未指定来源 → hero_content_has_image；
 *    discard_hero:true 显式丢弃）；隐式收养/stray 断言全删；
 * ⑨ 幂等重调（尺寸跟随新记录、fill 保留、z 序重钉）；
 * ⑩ note 信封字段钉扎（只事实 + WARNING，无指令链）。
 *
 * 旧测试拓扑平移（open-pencil tests/engine/tools/marketing/
 * compose-backdrop.test.ts 734 行），假 figma 换 setupToolTest() 真
 * SceneGraph+FigmaAPI，几何 fixture 走真 prepare_hero_scaffold（T57 集成）。
 * COMPOSE_TOOLS 已注册进 FORK_TOOLS（T58 集成期主 agent 接线）；测试仍
 * 直接 import 定义（与 prepare-hero-scaffold.test.ts 同基建）。
 */

import { describe, expect, test } from 'bun:test'

import type { Fill, SceneGraph } from '@open-pencil/core'

import { setSharedPluginData } from '#core/figma-api/plugin-data'
import { BRIEF_PLUGIN_NAMESPACE } from '#core/tools/fork/marketing/brief'
import {
  averageRegion,
  bandColorToHex,
  bottomBandRegion,
  COMPOSE_TEXTS,
  composeBackdrop,
  type ComposeBackdropArgs,
  type ComposeBackdropError,
  type ComposeBackdropErrorCode,
  type ComposeBackdropResult,
  type ComposeBackdropSuccess,
  type HeroColorSampler
} from '#core/tools/fork/marketing/compose-backdrop'
import { COMPOSE_TOOLS, composeBackdropTool } from '#core/tools/fork/marketing/compose-tools'
import {
  HERO_GEOMETRY_KEY,
  type PrepareHeroScaffoldResult,
  type PrepareHeroScaffoldSuccess
} from '#core/tools/fork/marketing/hero-scaffold'
import { prepareHeroScaffoldTool } from '#core/tools/fork/marketing/hero-tools'

import { expectDefined } from '#tests/helpers/assert'
import { setupToolTest, toolInputSchema } from '#tests/helpers/tools'

// ── fixture ──────────────────────────────────────────────────────────────────

function makeRoot(graph: SceneGraph, pageId: string, height = 2120) {
  return graph.createNode('FRAME', pageId, {
    name: '产品长图',
    x: 200,
    y: 300,
    width: 750,
    height,
    layoutMode: 'VERTICAL'
  })
}

/** 标题前置版式（T57 克隆源），默认 750×750 → 几何记录 {750, 850, 100, 100} */
function makeHeadlineSource(graph: SceneGraph, pageId: string, width = 750, height = 750) {
  const source = graph.createNode('FRAME', pageId, {
    name: '标题版式',
    x: 2000,
    y: 100,
    width,
    height
  })
  graph.createNode('TEXT', source.id, {
    name: 'Title',
    x: 60,
    y: 120,
    width: 630,
    height: 120,
    text: '端午安康'
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

function fakeSampler(hex: string): HeroColorSampler {
  return async () => ({ hex })
}

const failingSampler: HeroColorSampler = async () => ({ error: 'boom: no pixels' })

interface SamplerSeen {
  calls: number
  bandSize?: number
}

function recordingSampler(hex: string, seen: SamplerSeen): HeroColorSampler {
  return async (_graph: SceneGraph, _fill: Fill, bandSize: number) => {
    seen.calls++
    seen.bandSize = bandSize
    return { hex }
  }
}

function ok(result: ComposeBackdropResult): ComposeBackdropSuccess {
  if ('error' in result) throw new Error(`unexpected error: ${result.error} ${result.message}`)
  return result
}

function err(result: ComposeBackdropResult, code: ComposeBackdropErrorCode): ComposeBackdropError {
  if (!('error' in result)) throw new Error(`expected error ${code}, got success`)
  expect(result.error).toBe(code)
  expect(result.message).toBeTruthy()
  // 结构化错误面钉扎：仅 { error, message } 两键
  expect(Object.keys(result).sort()).toEqual(['error', 'message'])
  return result
}

function prepareScaffold(
  figma: ReturnType<typeof setupToolTest>['figma'],
  rootId: string,
  sourceId: string,
  extra: Record<string, unknown> = {}
): PrepareHeroScaffoldSuccess {
  const result = prepareHeroScaffoldTool.execute(figma, {
    root_id: rootId,
    source_node_id: sourceId,
    ...extra
  }) as PrepareHeroScaffoldResult
  if ('error' in result) throw new Error(`prepare failed: ${result.error} ${result.message}`)
  return result
}

/** 一页一根（750×rootHeight 自动布局）+ 标题版式源 + 默认几何记录的 scaffold */
function setupPipeline(rootHeight = 2120) {
  const { graph, figma } = setupToolTest()
  const pageId = figma.currentPage.id
  const root = makeRoot(graph, pageId, rootHeight)
  const source = makeHeadlineSource(graph, pageId)
  const scaffold = prepareScaffold(figma, root.id, source.id)
  const compose = (extra: Partial<ComposeBackdropArgs> = {}, sampler?: HeroColorSampler) =>
    composeBackdrop(
      figma,
      { rootId: root.id, scaffoldId: scaffold.scaffold_id, ...extra },
      sampler ?? fakeSampler('#5A7F5B')
    )
  return { graph, figma, pageId, root, source, scaffold, compose }
}

// ① 工具定义钉扎 ─────────────────────────────────────────────────────────────

test('① 工具定义钉扎：name/mutates/input + COMPOSE_TOOLS 交付面 + 散参删除', () => {
  expect(composeBackdropTool.name).toBe('compose_backdrop')
  expect(composeBackdropTool.mutates).toBe(true)
  // PR697 后钉扎 wire contract（LLM 可见的 JSON Schema）而非内部 ParamDef
  const schema = toolInputSchema(composeBackdropTool)
  expect(schema.required).toEqual(['root_id'])
  expect(Object.keys(schema.properties)).toEqual([
    'root_id',
    'scaffold_id',
    'hero_image_from',
    'discard_hero',
    'canvas_height',
    'hero_color'
  ])
  expect(schema.properties.discard_hero.default).toBe(false)
  expect(schema.properties.canvas_height.minimum).toBe(200)
  expect(schema.properties.canvas_height.maximum).toBe(20000)
  expect(COMPOSE_TOOLS.map((tool) => tool.name)).toEqual(['compose_backdrop'])
  expect(COMPOSE_TEXTS.layerName).toBe('BackgroundLayer')
  expect(COMPOSE_TEXTS.heroContentName).toBe('HeroContent')
})

test('① ToolDef execute 透传 snake_case 参数到 core', async () => {
  const { figma, root, scaffold } = setupPipeline()
  const missing = (await composeBackdropTool.execute(figma, {
    root_id: '',
    scaffold_id: scaffold.scaffold_id
  })) as ComposeBackdropResult
  expect('error' in missing && missing.error === 'invalid_params').toBe(true)

  const piped = (await composeBackdropTool.execute(figma, {
    root_id: root.id,
    scaffold_id: scaffold.scaffold_id,
    hero_color: '#5A7F5BFF'
  })) as ComposeBackdropResult
  const built = ok(piped)
  expect(built.hero_color).toBe('#5A7F5BFF')
  expect(built.color_source).toBe('explicit')
})

// ② 校验错误路径 ─────────────────────────────────────────────────────────────

describe('② 校验错误路径', () => {
  test('root_id 空串 / scaffold_id 与 hero_image_from 双缺 → invalid_params', async () => {
    const { compose } = setupPipeline()
    const missingRoot = err(await compose({ rootId: '' }), 'invalid_params')
    expect(missingRoot.message).toContain('root_id')
    const missingSource = err(await compose({ scaffoldId: undefined }), 'invalid_params')
    expect(missingSource.message).toContain('scaffold_id')
    expect(missingSource.message).toContain('hero_image_from')
  })

  test('discard_hero 与 hero_image_from 互斥 → invalid_params', async () => {
    const { compose } = setupPipeline()
    err(await compose({ heroImageFrom: 'some-node', discardHero: true }), 'invalid_params')
  })

  test('canvas_height 非有限 → invalid_params', async () => {
    const { compose } = setupPipeline()
    err(await compose({ canvasHeight: Number.NaN }), 'invalid_params')
  })

  test('root 不存在 / 非 FRAME / 无自动布局', async () => {
    const { graph, pageId, compose } = setupPipeline()
    err(await compose({ rootId: 'missing' }), 'root_not_found')

    const notFrame = err(await compose({ rootId: pageId }), 'root_not_frame')
    expect(notFrame.message).toContain('CANVAS')

    const freeRoot = graph.createNode('FRAME', pageId, {
      name: 'FreeRoot',
      width: 750,
      height: 2120,
      layoutMode: 'NONE'
    })
    const noAutoLayout = err(await compose({ rootId: freeRoot.id }), 'root_not_auto_layout')
    expect(noAutoLayout.message).toContain('自动布局')
  })

  test('尺寸越界：记录宽 50 → 过小；记录宽 9000 / canvas_height 99999 → 过大', async () => {
    const { graph, figma, pageId, root, compose } = setupPipeline()
    const tinySource = makeHeadlineSource(graph, pageId, 50, 750)
    const tinyScaffold = prepareScaffold(figma, root.id, tinySource.id)
    const tooSmall = err(
      await compose({ scaffoldId: tinyScaffold.scaffold_id }),
      'invalid_geometry'
    )
    expect(tooSmall.message).toContain('50')

    const wideScaffold = prepareScaffold(figma, root.id, makeHeadlineSource(graph, pageId).id)
    const wideNode = expectDefined(graph.getNode(wideScaffold.scaffold_id))
    setSharedPluginData(
      graph,
      wideNode,
      BRIEF_PLUGIN_NAMESPACE,
      HERO_GEOMETRY_KEY,
      JSON.stringify({ width: 9000, height: 850, underlapPx: 100, transitionZonePx: 100 })
    )
    const tooWide = err(await compose({ scaffoldId: wideScaffold.scaffold_id }), 'invalid_geometry')
    expect(tooWide.message).toContain('9000')

    err(await compose({ canvasHeight: 99999 }), 'invalid_geometry')
  })

  test('hero 槽高越界（记录 height − underlap < 100 / heroImg ≥ canvas）→ invalid_geometry', async () => {
    const { graph, compose, scaffold } = setupPipeline()
    const scaffoldNode = expectDefined(graph.getNode(scaffold.scaffold_id))
    setSharedPluginData(
      graph,
      scaffoldNode,
      BRIEF_PLUGIN_NAMESPACE,
      HERO_GEOMETRY_KEY,
      JSON.stringify({ width: 750, height: 90, underlapPx: 100, transitionZonePx: 100 })
    )
    const badSlot = err(await compose(), 'invalid_geometry')
    expect(badSlot.message).toContain('-10')

    setSharedPluginData(
      graph,
      scaffoldNode,
      BRIEF_PLUGIN_NAMESPACE,
      HERO_GEOMETRY_KEY,
      JSON.stringify({ width: 750, height: 850, underlapPx: 100, transitionZonePx: 100 })
    )
    const tooTall = err(await compose({ canvasHeight: 800 }), 'invalid_geometry')
    expect(tooTall.message).toContain('850')
  })
})

// ③ 几何消费 ─────────────────────────────────────────────────────────────────

describe('③ 几何消费（几何记录为唯一来源）', () => {
  test('记录读出：hero_height = height − underlapPx，HeroImg = 记录 height，过渡带 = transitionZonePx', async () => {
    const { graph, compose } = setupPipeline()
    const built = ok(await compose({ heroColor: '#5A7F5BFF' }))

    expect(built.hero_height).toBe(750)
    expect(built.underlap_px).toBe(100)
    expect(built.overlap_px).toBe(100)
    expect(graph.getNode(built.hero_img_id)?.height).toBe(850)
    expect(graph.getNode(built.hero_content_id)?.height).toBe(750)
    expect(built.overlay_position).toEqual({ x: 0, y: 750, width: 750, height: 1370 })
  })

  test('scaffold 不存在 → scaffold_not_found，message 引导 prepare_hero_scaffold', async () => {
    const { compose } = setupPipeline()
    const missing = err(await compose({ scaffoldId: 'missing-scaffold' }), 'scaffold_not_found')
    expect(missing.message).toContain('prepare_hero_scaffold')
  })

  test('scaffold 缺几何记录 → geometry_missing（跳步 = 显式失败）', async () => {
    const { graph, pageId, compose } = setupPipeline()
    const plain = graph.createNode('FRAME', pageId, {
      name: '裸 frame',
      width: 750,
      height: 850
    })
    const missing = err(await compose({ scaffoldId: plain.id }), 'geometry_missing')
    expect(missing.message).toContain('prepare_hero_scaffold')
  })

  test('畸形几何记录 → geometry_missing', async () => {
    const { graph, compose, scaffold } = setupPipeline()
    const scaffoldNode = expectDefined(graph.getNode(scaffold.scaffold_id))
    setSharedPluginData(graph, scaffoldNode, BRIEF_PLUGIN_NAMESPACE, HERO_GEOMETRY_KEY, 'not-json')
    err(await compose(), 'geometry_missing')
  })

  test('canvas_height 缺省 = 根 frame 当前高度；显式传值优先', async () => {
    const { compose } = setupPipeline(3000)
    const defaulted = ok(await compose({ heroColor: '#5A7F5BFF' }))
    expect(defaulted.overlay_position).toEqual({ x: 0, y: 750, width: 750, height: 2250 })
    expect(defaulted.note).toContain("root frame's current height (3000px)")

    const explicit = ok(await compose({ heroColor: '#5A7F5BFF', canvasHeight: 2500 }))
    expect(explicit.overlay_position.height).toBe(1750)
    expect(explicit.note).not.toContain('current height')
  })
})

// ④ 拓扑 ────────────────────────────────────────────────────────────────────

describe('④ 拓扑 z 序', () => {
  test('BackgroundLayer [0] / HeroContent [1]；层内 BaseWash < HeroImg < BackdropOverlay', async () => {
    const { graph, root, compose } = setupPipeline()
    const built = ok(await compose({ heroColor: '#5A7F5BFF' }))

    expect(root.childIds[0]).toBe(built.background_layer_id)
    expect(root.childIds[1]).toBe(built.hero_content_id)

    const layer = expectDefined(graph.getNode(built.background_layer_id), 'layer')
    expect(layer.layoutPositioning).toBe('ABSOLUTE')
    expect(layer.childIds).toEqual([
      built.base_wash_id,
      built.hero_img_id,
      built.backdrop_overlay_id
    ])

    const heroContent = expectDefined(graph.getNode(built.hero_content_id), 'hero content')
    expect(heroContent.layoutPositioning).toBe('AUTO')
    expect(heroContent.height).toBe(750)
    expect(heroContent.fills).toEqual([])

    const heroImg = expectDefined(graph.getNode(built.hero_img_id), 'hero img')
    expect(heroImg.height).toBe(850)
  })

  test('既有内容分区保留在 HeroContent 之后的流式顺序里', async () => {
    const { graph, root, compose } = setupPipeline()
    const part2 = graph.createNode('FRAME', root.id, {
      name: 'Part2',
      width: 750,
      height: 400
    })
    const built = ok(await compose({ heroColor: '#5A7F5BFF' }))

    expect(root.childIds).toEqual([built.background_layer_id, built.hero_content_id, part2.id])
    expect(graph.getNode(part2.id)?.layoutPositioning).toBe('AUTO')
  })
})

// ⑤ 渐变契约 ─────────────────────────────────────────────────────────────────

describe('⑤ 渐变契约', () => {
  test('BaseWash：顶部 5% 淡染 → 底部不透明白', async () => {
    const { graph, compose } = setupPipeline()
    const built = ok(await compose({ heroColor: '#5A7F5BFF' }))

    const fill = expectDefined(graph.getNode(built.base_wash_id)?.fills[0], 'basewash fill')
    const stops = expectDefined(fill.gradientStops, 'basewash stops')
    expect(stops.length).toBe(2)
    const [top, bottom] = stops
    expect(top.color.a).toBeCloseTo(0.05, 10)
    expect(top.color.r).toBeCloseTo(90 / 255, 5)
    expect(bottom.color).toEqual({ r: 1, g: 1, b: 1, a: 1 })
    expect(bottom.position).toBe(1)
  })

  test('BackdropOverlay 三段渐变 + 竖直 transform + middle stop 落在 Hero 底边', async () => {
    const { graph, compose } = setupPipeline()
    const built = ok(await compose({ heroColor: '#5A7F5BFF' }))

    const overlay = expectDefined(graph.getNode(built.backdrop_overlay_id), 'overlay')
    const overlayFill = expectDefined(overlay.fills[0], 'overlay fill')
    const stops = expectDefined(overlayFill.gradientStops, 'overlay stops')
    expect(stops.length).toBe(3)
    const [top, middle, bottom] = stops
    // 顶部 stop：THEME 色 alpha 0——纯 alpha 渐变，Hero 底带融进自身色相
    expect(top.color.r).toBeCloseTo(90 / 255, 5)
    expect(top.color.g).toBeCloseTo(127 / 255, 5)
    expect(top.color.b).toBeCloseTo(91 / 255, 5)
    expect(top.color.a).toBe(0)
    expect(top.position).toBe(0)
    expect(middle.color.r).toBeCloseTo(90 / 255, 5)
    expect(middle.color.a).toBe(1)
    // middle stop 恰好落在 Hero 图像底边：100/1370
    expect(middle.position).toBeCloseTo(100 / 1370, 10)
    expect(bottom.color).toEqual({ r: 1, g: 1, b: 1, a: 1 })
    expect(bottom.position).toBe(1)
    expect(overlayFill.gradientTransform).toEqual({
      m00: 0,
      m01: 1,
      m02: 0,
      m10: -1,
      m11: 0,
      m12: 1
    })
  })

  test('白兜底时顶部 stop 退化为旧透明白', async () => {
    const { graph, compose } = setupPipeline()
    const built = ok(await compose({ discardHero: true }))

    const overlay = expectDefined(graph.getNode(built.backdrop_overlay_id), 'overlay')
    const stops = expectDefined(overlay.fills[0]?.gradientStops, 'overlay stops')
    expect(stops[0].color).toEqual({ r: 1, g: 1, b: 1, a: 0 })
  })
})

// ⑥ 颜色管线 ─────────────────────────────────────────────────────────────────

describe('⑥ 颜色管线（显式 > 采样 > 白兜底）', () => {
  test('显式 hero_color → color_source: explicit，不触采样器', async () => {
    const { graph, compose, scaffold } = setupPipeline()
    graph.updateNode(scaffold.scaffold_id, { fills: [makeImageFill()] })
    const seen: SamplerSeen = { calls: 0 }
    const built = ok(await compose({ heroColor: '#5A7F5BFF' }, recordingSampler('#112233', seen)))
    expect(built.hero_color).toBe('#5A7F5BFF')
    expect(built.color_source).toBe('explicit')
    expect(seen.calls).toBe(0)
  })

  test('采样路径：假采样器 hex 落进 overlay middle stop，bandSize = transitionZonePx', async () => {
    const { graph, compose, scaffold } = setupPipeline()
    graph.updateNode(scaffold.scaffold_id, { fills: [makeImageFill()] })
    const seen: SamplerSeen = { calls: 0 }
    const built = ok(await compose({}, recordingSampler('#112233', seen)))

    expect(built.color_source).toBe('sampled')
    expect(built.hero_color).toBe('#112233')
    expect(seen.calls).toBe(1)
    expect(seen.bandSize).toBe(100)
    const stops = expectDefined(
      graph.getNode(built.backdrop_overlay_id)?.fills[0]?.gradientStops,
      'overlay stops'
    )
    expect(stops[1].color.r).toBeCloseTo(0x11 / 255, 5)
  })

  test('transitionZonePx=50 的记录：bandSize 50 且 middle stop 位置跟随', async () => {
    const { graph, figma, root, source, compose } = setupPipeline()
    const scaffold50 = prepareScaffold(figma, root.id, source.id, { transition_zone_px: 50 })
    graph.updateNode(scaffold50.scaffold_id, { fills: [makeImageFill()] })
    const seen: SamplerSeen = { calls: 0 }
    const built = ok(
      await compose({ scaffoldId: scaffold50.scaffold_id }, recordingSampler('#112233', seen))
    )

    expect(built.overlap_px).toBe(50)
    expect(seen.bandSize).toBe(50)
    // overlayY = 850 − 50 = 800；middle = 50 / (2120 − 800)
    expect(built.overlay_position).toEqual({ x: 0, y: 800, width: 750, height: 1320 })
    const stops = expectDefined(
      graph.getNode(built.backdrop_overlay_id)?.fills[0]?.gradientStops,
      'overlay stops'
    )
    expect(stops[1].position).toBeCloseTo(50 / 1320, 10)
  })

  test('采样失败 → 白兜底 + note 带 sampleError 事实（结构不因像素失败）', async () => {
    const { graph, compose, scaffold } = setupPipeline()
    graph.updateNode(scaffold.scaffold_id, { fills: [makeImageFill()] })
    const built = ok(await compose({}, failingSampler))

    expect(built.color_source).toBe('fallback')
    expect(built.hero_color).toBe('#FFFFFFFF')
    expect(built.note).toContain('boom: no pixels')
    expect(built.note).toContain('white')
    // 结构与转移不受影响
    expect(graph.getNode(built.hero_img_id)?.fills[0]?.type).toBe('IMAGE')
  })

  test('无 Hero 图像（discard_hero / 空 scaffold）→ 白兜底，不触采样器', async () => {
    const { compose } = setupPipeline()
    const seen: SamplerSeen = { calls: 0 }
    const discarded = ok(await compose({ discardHero: true }, recordingSampler('#112233', seen)))
    expect(discarded.color_source).toBe('fallback')
    expect(discarded.hero_color).toBe('#FFFFFFFF')
    expect(discarded.note).toContain('No hero image')
    expect(seen.calls).toBe(0)

    // 空 scaffold（图像尚未生成）容忍：白兜底不报错
    const empty = ok(await compose({}, recordingSampler('#112233', seen)))
    expect(empty.color_source).toBe('fallback')
    expect(seen.calls).toBe(0)
  })

  test('hex 拒收 → note WARNING 且穿透到采样', async () => {
    const { graph, compose, scaffold } = setupPipeline()
    graph.updateNode(scaffold.scaffold_id, { fills: [makeImageFill()] })
    const built = ok(await compose({ heroColor: 'not-a-hex' }, fakeSampler('#112233')))

    expect(built.color_source).toBe('sampled')
    expect(built.hero_color).toBe('#112233')
    expect(built.note).toContain('WARNING')
    expect(built.note).toContain('"not-a-hex"')
    expect(built.note).toContain('ignored')
  })

  test('未传 hero_color 且无警告时 note 不含 WARNING', async () => {
    const { compose } = setupPipeline()
    const built = ok(await compose({ discardHero: true, canvasHeight: 2120 }))
    expect(built.note).not.toContain('WARNING')
  })

  test('缺省真采样器 seam：图像字节未加载 → 白兜底（不触 CanvasKit）', async () => {
    const { figma, graph, root, scaffold } = setupPipeline()
    graph.updateNode(scaffold.scaffold_id, { fills: [makeImageFill()] })
    // 不传 sampler：走缺省 sampleHeroBottomBand——graph.images 无字节，
    // 在 lazy import CanvasKit 之前就返回 error
    const built = ok(
      await composeBackdrop(figma, { rootId: root.id, scaffoldId: scaffold.scaffold_id })
    )
    expect(built.color_source).toBe('fallback')
    expect(built.hero_color).toBe('#FFFFFFFF')
    expect(built.note).toContain('not loaded')
  })
})

// ⑦ 来源与填充转移 ───────────────────────────────────────────────────────────

describe('⑦ hero_image_from 填充转移', () => {
  test('管线内：scaffold 的 IMAGE fill 复制进 HeroImg，scaffold 本身不动', async () => {
    const { graph, compose, scaffold } = setupPipeline()
    graph.updateNode(scaffold.scaffold_id, { fills: [makeImageFill()] })
    const built = ok(await compose())

    expect(graph.getNode(built.hero_img_id)?.fills[0]?.type).toBe('IMAGE')
    expect(graph.getNode(scaffold.scaffold_id)?.fills[0]?.type).toBe('IMAGE')
    expect(built.note).toContain('copied')
    expect(built.note).toContain('left untouched')
    expect(built.note).not.toContain('moved')
  })

  test('hero_image_from = HeroContent → 转移并清空 HeroContent', async () => {
    const { graph, root, compose } = setupPipeline()
    const hero = graph.createNode('FRAME', root.id, {
      name: 'HeroContent',
      width: 750,
      height: 750,
      fills: [makeImageFill()]
    })

    const built = ok(await compose({ heroImageFrom: hero.id }))

    expect(graph.getNode(built.hero_img_id)?.fills[0]?.type).toBe('IMAGE')
    expect(graph.getNode(hero.id)?.fills).toEqual([])
    expect(built.hero_content_id).toBe(hero.id)
    expect(built.note).toContain('copied')
    expect(built.note).toContain('cleared')
  })

  test('幂等重调不重复转移：来源已清空时容忍（fill 已在 HeroImg）', async () => {
    const { graph, root, compose } = setupPipeline()
    const hero = graph.createNode('FRAME', root.id, {
      name: 'HeroContent',
      width: 750,
      height: 750,
      fills: [makeImageFill()]
    })

    const first = ok(await compose({ heroImageFrom: hero.id }))
    const second = ok(await compose({ heroImageFrom: hero.id }))

    expect(second.hero_img_id).toBe(first.hero_img_id)
    expect(graph.getNode(second.hero_img_id)?.fills[0]?.type).toBe('IMAGE')
  })

  test('外部来源：来源高度即 Hero 显示高度，槽位短 100，画布宽取根宽', async () => {
    const { graph, pageId, compose } = setupPipeline()
    const asset = graph.createNode('RECTANGLE', pageId, {
      name: '用户照片',
      width: 750,
      height: 600,
      fills: [makeImageFill()]
    })

    const built = ok(await compose({ scaffoldId: undefined, heroImageFrom: asset.id }))

    expect(graph.getNode(built.hero_img_id)?.height).toBe(600)
    expect(built.hero_height).toBe(500)
    expect(graph.getNode(built.hero_content_id)?.height).toBe(500)
    expect(built.underlap_px).toBe(100)
    expect(built.overlap_px).toBe(100)
    expect(built.overlay_position).toEqual({ x: 0, y: 500, width: 750, height: 1620 })
    // 外部来源不清空
    expect(graph.getNode(asset.id)?.fills[0]?.type).toBe('IMAGE')
    expect(built.note).toContain('left untouched')
  })

  test('外部来源过矮（减去 underlap 后不足 100）→ invalid_geometry', async () => {
    const { graph, pageId, compose } = setupPipeline()
    const tiny = graph.createNode('RECTANGLE', pageId, {
      name: 'TinyPhoto',
      width: 750,
      height: 150,
      fills: [makeImageFill()]
    })
    const result = err(
      await compose({ scaffoldId: undefined, heroImageFrom: tiny.id }),
      'invalid_geometry'
    )
    expect(result.message).toContain('50')
  })

  test('外部来源无 IMAGE fill 且 HeroImg 无图 → source_no_image', async () => {
    const { graph, pageId, compose } = setupPipeline()
    const empty = graph.createNode('FRAME', pageId, {
      name: '空素材',
      width: 750,
      height: 600
    })
    const result = err(
      await compose({ scaffoldId: undefined, heroImageFrom: empty.id }),
      'source_no_image'
    )
    expect(result.message).toContain('空素材')
  })

  test('hero_image_from 指向不存在的节点 → source_not_found', async () => {
    const { compose } = setupPipeline()
    err(await compose({ heroImageFrom: 'missing-node' }), 'source_not_found')
    err(await compose({ scaffoldId: undefined, heroImageFrom: 'missing-node' }), 'source_not_found')
  })

  test('仅名为 HeroContent 的嵌套节点按外部来源处理（identity 而非 name）', async () => {
    const { graph, root, compose } = setupPipeline()
    const section = graph.createNode('FRAME', root.id, {
      name: 'Section',
      width: 750,
      height: 900
    })
    const nested = graph.createNode('FRAME', section.id, {
      name: 'HeroContent',
      width: 750,
      height: 864,
      fills: [makeImageFill()]
    })

    const built = ok(await compose({ scaffoldId: undefined, heroImageFrom: nested.id }))

    expect(built.hero_height).toBe(764)
    expect(graph.getNode(built.hero_img_id)?.height).toBe(864)
    // 嵌套来源保留填充（不是根槽位 → 不清空）
    expect(graph.getNode(nested.id)?.fills[0]?.type).toBe('IMAGE')
    // 根下新建了真正的 HeroContent 槽位
    expect(built.hero_content_id).not.toBe(nested.id)
    expect(graph.getNode(built.hero_content_id)?.height).toBe(764)
  })
})

// ⑧ HeroContent 图像新报错（隐式收养删除）─────────────────────────────────────

describe('⑧ HeroContent 含图未指定来源 → 结构化报错 / discard_hero 显式丢弃', () => {
  test('hero_content_has_image：报错引导指定来源或 discard_hero，且不建任何节点', async () => {
    const { graph, root, compose } = setupPipeline()
    const hero = graph.createNode('FRAME', root.id, {
      name: 'HeroContent',
      width: 750,
      height: 750,
      fills: [makeImageFill()]
    })
    const before = [...root.childIds]

    const result = err(await compose(), 'hero_content_has_image')
    expect(result.message).toContain('hero_image_from')
    expect(result.message).toContain('discard_hero:true')
    // 显式失败无副作用：根子节点不变，HeroContent 填充未被静清
    expect(root.childIds).toEqual(before)
    expect(graph.getNode(hero.id)?.fills[0]?.type).toBe('IMAGE')
  })

  test('discard_hero:true 显式丢弃 → 成功，HeroContent 清空，无图像转移', async () => {
    const { graph, root, compose } = setupPipeline()
    const hero = graph.createNode('FRAME', root.id, {
      name: 'HeroContent',
      width: 750,
      height: 750,
      fills: [makeImageFill()]
    })

    const built = ok(await compose({ discardHero: true }))

    expect(built.hero_content_id).toBe(hero.id)
    expect(graph.getNode(hero.id)?.fills).toEqual([])
    expect(graph.getNode(built.hero_img_id)?.fills[0]?.type).not.toBe('IMAGE')
    expect(built.color_source).toBe('fallback')
    expect(built.note).toContain('discard_hero confirmed')
  })
})

// ⑨ 幂等重调 ─────────────────────────────────────────────────────────────────

describe('⑨ 幂等重调', () => {
  test('原位更新不复制节点（换色路径）+ z 序重钉', async () => {
    const { graph, root, compose } = setupPipeline()
    const first = ok(await compose({ heroColor: '#5A7F5BFF' }))
    const childCount = root.childIds.length
    const layer = expectDefined(graph.getNode(first.background_layer_id), 'layer')
    const layerChildCount = layer.childIds.length

    const second = ok(await compose({ heroColor: '#A04030FF' }))

    expect(second.background_layer_id).toBe(first.background_layer_id)
    expect(second.hero_img_id).toBe(first.hero_img_id)
    expect(second.hero_content_id).toBe(first.hero_content_id)
    expect(second.backdrop_overlay_id).toBe(first.backdrop_overlay_id)
    expect(root.childIds.length).toBe(childCount)
    expect(layer.childIds.length).toBe(layerChildCount)

    const stops = expectDefined(
      graph.getNode(second.backdrop_overlay_id)?.fills[0]?.gradientStops,
      'overlay stops'
    )
    expect(stops[1].color.r).toBeCloseTo(160 / 255, 5)

    expect(root.childIds[0]).toBe(second.background_layer_id)
    expect(root.childIds[1]).toBe(second.hero_content_id)
  })

  test('尺寸跟随新几何记录（prepare 重调 underlap 250 → HeroImg 1000）', async () => {
    const { graph, figma, root, source, compose } = setupPipeline()
    const first = ok(await compose({ heroColor: '#5A7F5BFF' }))
    expect(graph.getNode(first.hero_img_id)?.height).toBe(850)

    // T57 重调刷新几何记录：height = 750 + 250 = 1000；槽高恒为 1000 − 250 = 750
    prepareScaffold(figma, root.id, source.id, { underlap_px: 250 })

    const second = ok(await compose({ heroColor: '#5A7F5BFF' }))
    expect(second.hero_img_id).toBe(first.hero_img_id)
    expect(second.hero_height).toBe(750)
    expect(second.underlap_px).toBe(250)
    expect(graph.getNode(second.hero_img_id)?.height).toBe(1000)
    expect(graph.getNode(second.hero_content_id)?.height).toBe(750)
    expect(second.overlay_position.y).toBe(900)
  })

  test('HeroImg 既有 IMAGE fill 挺过重调（来源填充已消失也不报错）', async () => {
    const { graph, compose, scaffold } = setupPipeline()
    graph.updateNode(scaffold.scaffold_id, { fills: [makeImageFill()] })
    const first = ok(await compose())
    expect(graph.getNode(first.hero_img_id)?.fills[0]?.type).toBe('IMAGE')

    // scaffold 填充消失（假设用户移除了），HeroImg 的图必须保留
    graph.updateNode(scaffold.scaffold_id, { fills: [] })
    const second = ok(await compose())
    expect(graph.getNode(second.hero_img_id)?.fills[0]?.type).toBe('IMAGE')
  })

  test('HeroContent 被误涂后重调强制回 fills=[]', async () => {
    const { graph, compose } = setupPipeline()
    const first = ok(await compose({ heroColor: '#5A7F5BFF' }))
    graph.updateNode(first.hero_content_id, {
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }]
    })

    const second = ok(await compose({ heroColor: '#5A7F5BFF' }))
    expect(graph.getNode(second.hero_content_id)?.fills).toEqual([])
  })

  test('canvas_height 缺省跟随 HUG 后的根实际高度', async () => {
    const { graph, root, compose } = setupPipeline()
    const first = ok(await compose({ heroColor: '#5A7F5BFF', canvasHeight: 2120 }))
    expect(first.overlay_position.height).toBe(1370)

    graph.updateNode(root.id, { height: 2600 })
    const second = ok(await compose({ heroColor: '#5A7F5BFF' }))

    expect(second.overlay_position).toEqual({ x: 0, y: 750, width: 750, height: 1850 })
    expect(second.backdrop_overlay_id).toBe(first.backdrop_overlay_id)
  })
})

// ⑩ 信封钉扎 ─────────────────────────────────────────────────────────────────

describe('⑩ 信封钉扎', () => {
  test('成功信封恰为 13 字段；note 只事实无指令链', async () => {
    const { compose } = setupPipeline()
    const built = ok(await compose({ heroColor: '#5A7F5BFF' }))
    expect(Object.keys(built).sort()).toEqual([
      'backdrop_overlay_id',
      'background_layer_id',
      'base_wash_id',
      'color_source',
      'hero_color',
      'hero_content_id',
      'hero_height',
      'hero_img_id',
      'note',
      'overlap_px',
      'overlay_position',
      'root_id',
      'underlap_px'
    ])
    expect(built.note).toContain('Backdrop composed under root')
    expect(built.note).toContain('BaseWash < HeroImg < BackdropOverlay')
    // 旧指令链不移植（归 workflow Fix Playbook）
    expect(built.note).not.toContain('Re-call')
    expect(built.note).not.toContain('Verify with look')
    expect(built.note).not.toContain('generate_image')
    expect(built.note).not.toContain('prepare_hero_scaffold')
  })

  test('根宽与记录宽不一致 → note WARNING（不报错）', async () => {
    const { graph, root, compose } = setupPipeline()
    graph.updateNode(root.id, { width: 700 })
    const built = ok(await compose({ heroColor: '#5A7F5BFF' }))
    expect(built.note).toContain('WARNING')
    expect(built.note).toContain('750')
    expect(built.note).toContain('700')
    // 背景按记录宽建造
    expect(built.overlay_position.width).toBe(750)
  })
})

// 采样纯函数（随迁锚）─────────────────────────────────────────────────────────

describe('采样纯函数（sample-color-pure 随迁）', () => {
  test('bottomBandRegion 取图像底部带并 clamp 到图像高度', () => {
    expect(bottomBandRegion(100, 200, 50)).toEqual({ x: 0, y: 150, width: 100, height: 50 })
    expect(bottomBandRegion(100, 200, 500)).toEqual({ x: 0, y: 0, width: 100, height: 200 })
  })

  test('averageRegion 平均 RGBA_8888 区域像素（忽略 alpha）', () => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128])
    expect(averageRegion(pixels, 2, 0, 0, 2, 1)).toEqual({ r: 128, g: 0, b: 128, samples: 2 })
  })

  test('bandColorToHex 输出大写 hex', () => {
    expect(bandColorToHex({ r: 90, g: 127, b: 91 })).toBe('#5A7F5B')
  })
})
