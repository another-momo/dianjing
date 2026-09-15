/**
 * T69（Phase 3 W3 / T-C3）golden 场景一：watercolor_poster_v2 最小 golden 测试。
 *
 * 形态裁决（T69-plan §B，实现 subagent 拍板，self-check 记录）：
 * **程序性断言可行，进 CI**——S2:132 后半「排版面程序性注入后可纯布局断言、
 * 零生图成本」成立。依据：prepare_hero_scaffold（T57）与 compose_backdrop（T58）
 * 的 core 均不依赖桥（setupToolTest 真 SceneGraph+FigmaAPI 直跑，既有
 * prepare-hero-scaffold.test.ts / compose-backdrop.test.ts 同基建实证）；
 * generate_image 的落图效果用「直接向 scaffold 写 IMAGE fill」等效模拟
 * （image_gen_commit 的本体效果即替换目标节点 fills，见 image-gen/apply.ts），
 * 生图本身（provider HTTP）不进 CI。
 *
 * golden 定义（S2:132，T62 后口径）：固定 brief + 固定尺寸预设（电商详情长图
 * 750x）→ 最小样板 + 评分量表（接缝可见性 / 标题可读性 / 节奏感）。
 *
 * CI 内覆盖（本文件断言）：brief 固定文案的标题版式字阶/错位堆叠（字阶上下限
 * 从真实 profile 文件正文正则提取——改 profile 字阶即改门禁）、scaffold 准备
 * 与几何记录、hero 几何（slot/underlap/过渡带）、背景三明治 z 序、HeroContent
 * 透明槽位与标题存活、颜色采样消费、跳步=显式失败（geometry_missing）、
 * 幂等重导（重采样原地换色）。
 *
 * CI 外手动流程（真生图样板的视觉跑分；需 image-gen API key 与成本，不进 CI）：
 *  1. 启动应用，新建设计，固定 brief：「端午节粽子礼盒电商详情长图，水彩风格」，
 *     尺寸预设选「电商详情长图 750x」，profile 选 水彩海报 v2。
 *  2. 走 hero-first 五阶段全程（方向提案 → hero 物化 → 结构与填充 → 终审），
 *     hero 标题固定两行「端午安康 / 粽叶飘香」，lockup 取 lower-third。
 *  3. 导出成品 PNG 归档（仓外 doc/golden/watercolor_poster_v2/），按量表打分：
 *     - 接缝可见性：0 = 接缝明显；1 = 细看可见；2 = 不可见。
 *     - 标题可读性：0 = 不可读；1 = 勉强可读；2 = 清晰可读。
 *     - 节奏感：    0 = 间距均匀如纱窗；1 = 部分呼吸感；2 = 疏密节奏明确。
 *  4. 改 profile 文件后先重跑本流程跑分（S2:132「改 profile 文件先跑分」），
 *     分数回写归档目录 README（手动维护）。
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SceneGraph, SceneNode } from '@open-pencil/core'

import {
  composeBackdrop,
  type ComposeBackdropError,
  type ComposeBackdropResult,
  type ComposeBackdropSuccess,
  type HeroColorSampler
} from '#core/tools/fork/marketing/compose-backdrop'
import {
  readHeroGeometry,
  type PrepareHeroScaffoldResult,
  type PrepareHeroScaffoldSuccess
} from '#core/tools/fork/marketing/hero-scaffold'
import { prepareHeroScaffoldTool } from '#core/tools/fork/marketing/hero-tools'

import { expectDefined } from '#tests/helpers/assert'
import { setupToolTest } from '#tests/helpers/tools'

// ── golden 固定量：brief 文案 + 750x 尺寸预设 ────────────────────────────────

/** 固定 brief 的锁定标题（CP1 锁标题后即生图参照与最终画面文字，S1 §3 阶段 1） */
const GOLDEN_TITLE_LINES = ['端午安康', '粽叶飘香'] as const
/** 固定尺寸预设：电商详情长图 750x（T65 sizes 清单首条 = 首选预设） */
const CANVAS_W = 750
/** v2 Hero treatment 节：hero height 默认 = W */
const HERO_H = 750
/** v2 Hero treatment 节：W=750 档 underlap/transition 均取 100 */
const UNDERLAP = 100
const ROOT_H = 2120

// P2-9（2026-09-07）：资产本体移至子目录，路径同步
const PROFILE_PATH = join(
  import.meta.dir,
  '../../../../src/app/ai/pi-backend/studio/profiles/watercolor_poster_v2/profile.md'
)

/** v2 Typography 节的 W=750 字阶档（从真实 profile 文件提取，改字阶即改门禁） */
interface Tier750 {
  hero: [number, number]
  section: [number, number]
  body: [number, number]
  caption: [number, number]
}

function readTier750(): Tier750 {
  const text = readFileSync(PROFILE_PATH, 'utf8')
  // 2026-09-15 调优版 Typography 节改按要素逐行表述（hero title/section titles/
  // body/captions 四行各带 750 与 1080 两档）——按行提取 750 档数值，行结构改写
  // 即抛错守门（与旧单句正则同语义：字阶表述改写需人工核对门禁）
  const grab = (label: string): [number, number] => {
    const m = new RegExp(`\\*\\*${label}\\*\\*[^\\n]*?(\\d+)–(\\d+)px`).exec(text)
    if (!m) throw new Error(`profile 的 ${label} 750 档字阶行未匹配——Typography 节字阶表述被改写？`)
    return [Number(m[1]), Number(m[2])]
  }
  return {
    hero: grab('Hero title'),
    section: grab('Section titles'),
    body: grab('Body'),
    caption: grab('Captions')
  }
}

// ── fixture ──────────────────────────────────────────────────────────────────

function ok<T extends object>(result: T | ComposeBackdropError): T {
  if ('error' in result) throw new Error(`unexpected error: ${result.error} ${result.message}`)
  return result
}

function fakeSampler(hex: string): HeroColorSampler {
  return async () => ({ hex })
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

/**
 * 按 v2 配方 step 1 搭 HeroContent 标题前置版式：root 首流式子节点、透明、
 * w=W h=hero pick；标题两行错落堆叠（x 偏移不同、左对齐、final 字号/位置）。
 * lower-third lockup：堆叠压在槽位下三分之一。
 */
function makeGoldenHero(graph: SceneGraph, pageId: string, tier: Tier750) {
  const root = graph.createNode('FRAME', pageId, {
    name: '端午粽子礼盒详情长图',
    x: 200,
    y: 300,
    width: CANVAS_W,
    height: ROOT_H,
    layoutMode: 'VERTICAL'
  })
  const hero = graph.createNode('FRAME', root.id, {
    name: 'HeroContent',
    x: 0,
    y: 0,
    width: CANVAS_W,
    height: HERO_H,
    layoutMode: 'NONE',
    clipsContent: false,
    fills: []
  })
  // 字号取档内代表值 96（须在 profile 提取的 hero 字阶内）；错落：第二行右移
  const fontSize = 96
  const line1 = graph.createNode('TEXT', hero.id, {
    name: 'Title-1',
    x: 60,
    y: 470,
    width: 500,
    height: 110,
    text: GOLDEN_TITLE_LINES[0],
    fontSize
  })
  const line2 = graph.createNode('TEXT', hero.id, {
    name: 'Title-2',
    x: 108,
    y: 590,
    width: 500,
    height: 110,
    text: GOLDEN_TITLE_LINES[1],
    fontSize
  })
  return { root, hero, lines: [line1, line2], tier }
}

function prepare(
  figma: ReturnType<typeof setupToolTest>['figma'],
  rootId: string,
  sourceId: string
): PrepareHeroScaffoldSuccess {
  const result = prepareHeroScaffoldTool.execute(figma, {
    root_id: rootId,
    source_node_id: sourceId,
    underlap_px: UNDERLAP,
    transition_zone_px: UNDERLAP
  }) as PrepareHeroScaffoldResult
  if ('error' in result) throw new Error(`prepare failed: ${result.error} ${result.message}`)
  return result
}

function childByName(graph: SceneGraph, parent: SceneNode, name: string): SceneNode {
  return expectDefined(
    parent.childIds.map((id) => graph.getNode(id)).find((node) => node?.name === name),
    `child ${name}`
  )
}

// ── profile 文件钉扎（七必改的文件级门禁） ────────────────────────────────────

test('golden-0 profile 钉扎：六设计要素节齐全、Recipe 已迁出、frontmatter modes 双 longform', () => {
  const text = readFileSync(PROFILE_PATH, 'utf8')
  // P2-1（2026-09-07）：profile 由 by 行为类别重组为 by 设计要素——六节名称钉扎
  for (const section of ['Typography', 'Color', 'Layout', 'Hero treatment', 'Forbidden', 'Tone']) {
    expect(text).toContain(`## ${section}`)
  }
  // Recipe 节已迁出到 workflow；profile 不再承载工序
  expect(text).not.toContain('## Recipe')
  expect(text).not.toContain('Fixed system')
  expect(text).not.toContain('Variable system')
  expect(text).not.toContain('Anti-identity')
  // P2-4（2026-09-07）：frontmatter 钉扎（id/label/version 维持；modes 扩到双 longform workflow 共享）
  expect(
    text.startsWith(
      '---\nid: watercolor_poster_v2\nlabel: 水彩海报 v2\nmodes: [longform-hero-kv-first, longform-structure-first]\nversion: 2\n---'
    )
  ).toBe(true)
  expect(text).not.toContain('hero_composition')
  // canvas_width 散参绝迹（已在 v2 重写前清除）
  expect(text).not.toContain('canvas_width')
  // profile 不再谈 prepare_hero_scaffold / generate_image / compose_backdrop 工具链顺序——
  // 工序归 workflow 侧；profile 只留设计意图
  expect(text).not.toContain('prepare_hero_scaffold(')
  expect(text).not.toContain('generate_image')
  expect(text).not.toContain('compose_backdrop({')
  // 旧阶段名绝迹（hero 物化 / 结构与填充 / Phase 2.* 已在 Recipe 中——Recipe 已迁）
  expect(text).not.toContain('hero 物化')
  expect(text).not.toContain('结构与填充')
  expect(text).not.toContain('Phase 2 skeleton')
  expect(text).not.toContain('Phase 2.5')
  // P2-4：modes 无 type 提法（T62 后 type 层级删除）
  expect(text).not.toMatch(/modes[^\n]*type/i)
})

// ── golden 管线：固定 brief + 750x 预设的确定性断言 ──────────────────────────

test('golden-1 字阶与版式：标题堆叠满足 v2 750 档全部排版面规则（字阶取自真实 profile）', () => {
  const tier = readTier750()
  const { graph, figma } = setupToolTest()
  const { lines } = makeGoldenHero(graph, figma.currentPage.id, tier)

  // 行数 2–3（固定 brief 取 2 行），每行 3–5 字
  expect(lines.length).toBeGreaterThanOrEqual(2)
  expect(lines.length).toBeLessThanOrEqual(3)
  for (const line of lines) {
    const chars = [...(line.text ?? '')].length
    expect(chars).toBeGreaterThanOrEqual(3)
    expect(chars).toBeLessThanOrEqual(5)
    // 字号落在 profile 提取的 750 档 hero 字阶内
    expect(line.fontSize).toBeGreaterThanOrEqual(tier.hero[0])
    expect(line.fontSize).toBeLessThanOrEqual(tier.hero[1])
  }
  // 错落堆叠：逐行水平偏移互不相同，且整体左对齐（不是居中 slab）
  const xs = lines.map((line) => line.x)
  expect(new Set(xs).size).toBe(xs.length)
  expect(Math.min(...xs)).toBeLessThan(CANVAS_W / 4)
})

test('golden-2 hero 物化→背景合成全链：几何记录 / 三明治 z 序 / 采样消费 / 标题存活', async () => {
  const tier = readTier750()
  const { graph, figma } = setupToolTest()
  const pageId = figma.currentPage.id
  const { root, hero, lines } = makeGoldenHero(graph, pageId, tier)

  // step 2：prepare_hero_scaffold —— 克隆标题前置版式 + 几何记录落盘
  const scaffold = prepare(figma, root.id, hero.id)
  expect(scaffold.width).toBe(CANVAS_W)
  expect(scaffold.height).toBe(HERO_H + UNDERLAP)
  expect(scaffold.underlap_px).toBe(UNDERLAP)
  expect(scaffold.transition_zone_px).toBe(UNDERLAP)
  expect(scaffold.clamped).toBe(false)
  expect(scaffold.cloned_children).toBe(lines.length)
  const scaffoldNode = expectDefined(graph.getNode(scaffold.scaffold_id))
  // scaffold = root 的页面级兄弟（绝不进 root——HUG 根高不被撑大）
  expect(scaffoldNode.parentId).toBe(pageId)
  expect(readHeroGeometry(graph, scaffoldNode)).toEqual({
    width: CANVAS_W,
    height: HERO_H + UNDERLAP,
    underlapPx: UNDERLAP,
    transitionZonePx: UNDERLAP
  })

  // step 3（CI 等效）：generate_image 落图效果 = scaffold 带上 IMAGE fill
  graph.updateNode(scaffold.scaffold_id, { fills: [makeImageFill()] })

  // step 4：compose_backdrop({ root_id, scaffold_id })——canvas_height 省略跟随根高
  const composed = ok<ComposeBackdropSuccess>(
    await composeBackdrop(
      figma,
      { rootId: root.id, scaffoldId: scaffold.scaffold_id },
      fakeSampler('#A9C7B2')
    )
  )
  // hero 几何断言：slot = 记录高 − underlap；HeroImg = 记录高；过渡带 = 记录 transition
  expect(composed.hero_height).toBe(HERO_H)
  expect(composed.underlap_px).toBe(UNDERLAP)
  expect(composed.overlap_px).toBe(UNDERLAP)
  expect(composed.overlay_position).toEqual({
    x: 0,
    y: HERO_H + UNDERLAP - UNDERLAP,
    width: CANVAS_W,
    height: ROOT_H - HERO_H
  })
  // 颜色消费点：自动采样 Hero 底部过渡带（假采样器钉住 hex 与 source）
  expect(composed.color_source).toBe('sampled')
  expect(composed.hero_color).toBe('#A9C7B2')

  // 三明治 z 序：BackgroundLayer 在 root index 0，内部 BaseWash < HeroImg < BackdropOverlay
  const rootFresh = expectDefined(graph.getNode(root.id))
  const layer = childByName(graph, rootFresh, 'BackgroundLayer')
  expect(rootFresh.childIds[0]).toBe(layer.id)
  expect(rootFresh.childIds[1]).toBe(composed.hero_content_id)
  const layerNames = layer.childIds.map((id) => graph.getNode(id)?.name)
  expect(layerNames).toEqual(['BaseWash', 'HeroImg', 'BackdropOverlay'])
  const heroImg = childByName(graph, layer, 'HeroImg')
  expect(heroImg.width).toBe(CANVAS_W)
  expect(heroImg.height).toBe(HERO_H + UNDERLAP)
  expect(heroImg.fills.some((fill) => fill.type === 'IMAGE')).toBe(true)

  // HeroContent 透明槽位：标题存活（fills 强制透明、尺寸同步到 slot、子节点不动）
  const heroFresh = expectDefined(graph.getNode(composed.hero_content_id))
  expect(heroFresh.fills).toEqual([])
  expect(heroFresh.width).toBe(CANVAS_W)
  expect(heroFresh.height).toBe(HERO_H)
  expect(heroFresh.childIds).toEqual(lines.map((line) => line.id))
})

test('golden-3 跳步=显式失败：无几何记录的 scaffold → geometry_missing', async () => {
  const tier = readTier750()
  const { graph, figma } = setupToolTest()
  const pageId = figma.currentPage.id
  const { root } = makeGoldenHero(graph, pageId, tier)

  // 手工伪造一个无几何记录的「scaffold」（跳过 prepare_hero_scaffold 的形状）
  const fakeScaffold = graph.createNode('FRAME', pageId, {
    name: 'Hero生成参考',
    x: 2000,
    y: 100,
    width: CANVAS_W,
    height: HERO_H + UNDERLAP,
    layoutMode: 'NONE',
    fills: [makeImageFill()]
  })
  const result = (await composeBackdrop(
    figma,
    { rootId: root.id, scaffoldId: fakeScaffold.id },
    fakeSampler('#A9C7B2')
  )) as ComposeBackdropResult
  if (!('error' in result)) throw new Error('expected geometry_missing, got success')
  expect(result.error).toBe('geometry_missing')
  expect(result.message).toContain('prepare_hero_scaffold')
})

test('golden-4 幂等重导：hero 重生后同参重调 compose_backdrop → 原地重采样换色', async () => {
  const tier = readTier750()
  const { graph, figma } = setupToolTest()
  const { root, hero } = makeGoldenHero(graph, figma.currentPage.id, tier)
  const scaffold = prepare(figma, root.id, hero.id)
  graph.updateNode(scaffold.scaffold_id, { fills: [makeImageFill()] })

  const first = ok<ComposeBackdropSuccess>(
    await composeBackdrop(
      figma,
      { rootId: root.id, scaffoldId: scaffold.scaffold_id },
      fakeSampler('#A9C7B2')
    )
  )
  // 同参重调（换采样结果 = hero 重生后的新底带色）：id 稳定、原地换色
  const second = ok<ComposeBackdropSuccess>(
    await composeBackdrop(
      figma,
      { rootId: root.id, scaffoldId: scaffold.scaffold_id },
      fakeSampler('#D8B26E')
    )
  )
  expect(second.background_layer_id).toBe(first.background_layer_id)
  expect(second.hero_img_id).toBe(first.hero_img_id)
  expect(second.hero_content_id).toBe(first.hero_content_id)
  expect(second.hero_color).toBe('#D8B26E')
  expect(second.color_source).toBe('sampled')
  expect(second.hero_height).toBe(HERO_H)
  // 标题在重导后仍然存活且槽位透明
  const heroFresh = expectDefined(graph.getNode(second.hero_content_id))
  expect(heroFresh.fills).toEqual([])
  expect(heroFresh.childIds.length).toBe(2)
})
