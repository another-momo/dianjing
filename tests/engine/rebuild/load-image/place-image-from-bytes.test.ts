/**
 * 2026-09-18 本地图片工具链（仓外 docs/202609151700-load-image-tool-research.md
 * §3.1）：core 桥工具 place_image_from_bytes 单测。
 *
 * 覆盖：
 *  - 光栅新建：真解码闸（注入假解码器）+ 4096 逻辑缩放 + 节点命名 +
 *    IMAGE fill 写图（graph.images 同 hash）+ 页级自动定位（右置页面内容）
 *  - 显式 x/y、parent_id（省略坐标 = 父左上角绝对原点）
 *  - 像素上限 64MP：超限拒绝并返实际宽高
 *  - 解码失败（损坏文件）→ 明确错误
 *  - replace_id：解码闸 + 像素上限后写 IMAGE fill；SVG replace 拒绝；
 *    节点不存在错误
 *  - SVG：矢量化建 FRAME（与手工「添加图片」同节点形态）；提取不到路径 →
 *    「无法矢量化」错误
 *
 * 测试纪律：不加载 canvaskit wasm——光栅解码一律注入假解码器
 * （compose-backdrop sampler 注入同款先例）；SVG 路径为纯 JS 解析
 * （xmldom/svgpath），可直接真跑。
 */
import { describe, expect, test } from 'bun:test'

import { FigmaAPI, SceneGraph } from '@open-pencil/core'
import { encodeBase64 } from '@open-pencil/core/bytes'
import {
  placeImageFromBytes,
  placeImageFromBytesTool,
  type PlaceImageFromBytesArgs
} from '@open-pencil/core/tools/fork/place-image-from-bytes'

const RASTER_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
const SVG_BYTES = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h24v24H0z"/></svg>'
)

function setup() {
  const graph = new SceneGraph()
  const figma = new FigmaAPI(graph)
  return { graph, figma, pageId: figma.currentPageId }
}

function rasterArgs(overrides: Partial<PlaceImageFromBytesArgs> = {}): PlaceImageFromBytesArgs {
  return {
    name: 'logo.png',
    image_data: encodeBase64(RASTER_BYTES),
    mime: 'image/png',
    ...overrides
  }
}

function fakeDecode(width: number, height: number) {
  return async () => ({ width, height })
}

const FAIL_DECODE = async () => null

describe('光栅新建路径', () => {
  test('解码闸通过 → RECTANGLE + IMAGE fill（graph.images 同 hash）+ 节点名去扩展名', async () => {
    const { graph, figma, pageId } = setup()
    const result = (await placeImageFromBytes(figma, rasterArgs(), {
      decodeRaster: fakeDecode(800, 600)
    })) as { id: string; width: number; height: number; imageHash: string }

    const node = graph.getNode(result.id)
    expect(node?.type).toBe('RECTANGLE')
    expect(node?.parentId).toBe(pageId)
    expect(node?.name).toBe('logo')
    expect(node?.width).toBe(800)
    expect(node?.height).toBe(600)
    const fill = node?.fills[0]
    expect(fill?.type).toBe('IMAGE')
    expect(result.imageHash).toBeTruthy()
    expect(graph.images.get(result.imageHash)).toBeDefined()
    expect([...(graph.images.get(result.imageHash) ?? [])]).toEqual([...RASTER_BYTES])
  })

  test('4096 逻辑缩放：8000x4000 → 4096x2048（返回值即节点逻辑尺寸）', async () => {
    const { graph, figma } = setup()
    const result = (await placeImageFromBytes(figma, rasterArgs(), {
      decodeRaster: fakeDecode(8000, 4000)
    })) as { id: string; width: number; height: number }
    expect(result.width).toBe(4096)
    expect(result.height).toBe(2048)
    const node = graph.getNode(result.id)
    expect(node?.width).toBe(4096)
    expect(node?.height).toBe(2048)
  })

  test('页级自动定位：新节点落在既有内容右侧（findPlacementPosition 语义）', async () => {
    const { graph, figma, pageId } = setup()
    graph.createNode('RECTANGLE', pageId, { name: 'existing', x: 0, y: 0, width: 100, height: 100 })
    const result = (await placeImageFromBytes(figma, rasterArgs(), {
      decodeRaster: fakeDecode(800, 600)
    })) as { id: string }
    const node = graph.getNode(result.id)
    expect(node?.x).toBe(200) // 0 + 100 + PLACEMENT_GAP(100)
    expect(node?.y).toBe(0)
  })

  test('显式 x/y 生效', async () => {
    const { graph, figma } = setup()
    const result = (await placeImageFromBytes(figma, rasterArgs({ x: 50, y: 70 }), {
      decodeRaster: fakeDecode(800, 600)
    })) as { id: string }
    const node = graph.getNode(result.id)
    expect(node?.x).toBe(50)
    expect(node?.y).toBe(70)
  })

  test('parent_id 省略坐标 → 父左上角（绝对原点对齐，appendChild 保绝对坐标）', async () => {
    const { graph, figma, pageId } = setup()
    const parent = graph.createNode('FRAME', pageId, {
      name: 'p',
      x: 100,
      y: 200,
      width: 400,
      height: 400
    })
    const result = (await placeImageFromBytes(figma, rasterArgs({ parent_id: parent.id }), {
      decodeRaster: fakeDecode(800, 600)
    })) as { id: string }
    const node = graph.getNode(result.id)
    expect(node?.parentId).toBe(parent.id)
    expect(figma.graph.getAbsolutePosition(result.id)).toEqual({ x: 100, y: 200 })
  })

  test('parent_id 不存在 → Node not found', async () => {
    const { figma } = setup()
    const result = (await placeImageFromBytes(figma, rasterArgs({ parent_id: '9:9' }), {
      decodeRaster: fakeDecode(800, 600)
    })) as { error?: string }
    expect(result.error).toBe('Node "9:9" not found')
  })

  test('像素上限 64MP：9000x8000=72MP 拒绝并返实际宽高', async () => {
    const { figma } = setup()
    const result = (await placeImageFromBytes(figma, rasterArgs(), {
      decodeRaster: fakeDecode(9000, 8000)
    })) as { error?: string }
    expect(result.error).toContain('9000x8000')
    expect(result.error).toContain('64MP')
  })

  test('解码失败（损坏文件）→ 明确错误', async () => {
    const { figma } = setup()
    const result = (await placeImageFromBytes(figma, rasterArgs(), {
      decodeRaster: FAIL_DECODE
    })) as { error?: string }
    expect(result.error).toBe('File is corrupted or not a valid image.')
  })
})

describe('replace_id 路径', () => {
  test('写 IMAGE fill（set_image_fill 同款）+ 返回实际像素宽高', async () => {
    const { graph, figma, pageId } = setup()
    const target = graph.createNode('RECTANGLE', pageId, {
      name: 't',
      width: 100,
      height: 100,
      fills: []
    })
    const result = (await placeImageFromBytes(figma, rasterArgs({ replace_id: target.id }), {
      decodeRaster: fakeDecode(1024, 512)
    })) as { id: string; width: number; height: number; imageHash: string }
    expect(result.id).toBe(target.id)
    expect(result.width).toBe(1024)
    expect(result.height).toBe(512)
    const node = graph.getNode(target.id)
    expect(node?.fills[0]?.type).toBe('IMAGE')
    expect(graph.images.get(result.imageHash)).toBeDefined()
  })

  test('replace 路径同受像素上限闸', async () => {
    const { graph, figma, pageId } = setup()
    const target = graph.createNode('RECTANGLE', pageId, { name: 't', width: 100, height: 100 })
    const result = (await placeImageFromBytes(figma, rasterArgs({ replace_id: target.id }), {
      decodeRaster: fakeDecode(9000, 8000)
    })) as { error?: string }
    expect(result.error).toContain('64MP')
    // 拒绝不写 fill
    expect(graph.getNode(target.id)?.fills).toHaveLength(0)
  })

  test('replace_id 节点不存在 → Node not found', async () => {
    const { figma } = setup()
    const result = (await placeImageFromBytes(figma, rasterArgs({ replace_id: '9:9' }), {
      decodeRaster: fakeDecode(100, 100)
    })) as { error?: string }
    expect(result.error).toBe('Node "9:9" not found')
  })

  test('SVG + replace_id → 拒绝（矢量结果无法作 IMAGE fill）', async () => {
    const { graph, figma, pageId } = setup()
    const target = graph.createNode('RECTANGLE', pageId, { name: 't', width: 100, height: 100 })
    const result = (await placeImageFromBytes(figma, {
      name: 'icon.svg',
      image_data: encodeBase64(SVG_BYTES),
      mime: 'image/svg+xml',
      replace_id: target.id
    })) as { error?: string }
    expect(result.error).toContain('SVG')
  })
})

describe('SVG 新建路径（真实矢量化，无 canvaskit 依赖）', () => {
  test('矢量化建 FRAME + 子形状节点 + imageHash=null', async () => {
    const { graph, figma, pageId } = setup()
    const result = (await placeImageFromBytes(figma, {
      name: 'icon.svg',
      image_data: encodeBase64(SVG_BYTES),
      mime: 'image/svg+xml'
    })) as { id: string; width: number; height: number; imageHash: string | null }
    const node = graph.getNode(result.id)
    expect(node?.type).toBe('FRAME')
    expect(node?.parentId).toBe(pageId)
    expect(node?.name).toBe('icon')
    expect(result.width).toBe(24)
    expect(result.height).toBe(24)
    expect(result.imageHash).toBeNull()
    expect(graph.getChildren(result.id).length).toBeGreaterThan(0)
  })

  // 2026-09-19 件 1 后行为翻转：纯 text SVG 不再判「无法矢量化」——<text>
  // 映射为可编辑 TEXT 节点（曾为静默丢弃实证样本）；完全无内容才报错
  test('纯 text 元素 → TEXT 节点导入（不再误判无法矢量化）', async () => {
    const { graph, figma } = setup()
    const textOnly = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><text x="0" y="12">hi</text></svg>'
    )
    const result = (await placeImageFromBytes(figma, {
      name: 'text.svg',
      image_data: encodeBase64(textOnly),
      mime: 'image/svg+xml'
    })) as { id?: string; error?: string }
    expect(result.error).toBeUndefined()
    const children = graph.getChildren(result.id ?? '')
    expect(children).toHaveLength(1)
    expect(children[0]?.type).toBe('TEXT')
    expect(children[0]?.text).toBe('hi')
  })

  test('完全无内容的 SVG → 无法矢量化错误', async () => {
    const { figma } = setup()
    const empty = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"></svg>'
    )
    const result = (await placeImageFromBytes(figma, {
      name: 'empty.svg',
      image_data: encodeBase64(empty),
      mime: 'image/svg+xml'
    })) as { error?: string }
    expect(result.error).toContain('vectorized')
  })
})

describe('工具壳（valibot 校验 + 桥执行面形态）', () => {
  test('placeImageFromBytesTool 登记名 + 三面 exposure 关断', () => {
    expect(placeImageFromBytesTool.name).toBe('place_image_from_bytes')
    expect(placeImageFromBytesTool.exposure).toEqual({ ai: false, mcp: false, webmcp: false })
  })

  test('非法参数（缺 image_data）在 schema 层抛错', () => {
    const { figma } = setup()
    // defineTool.execute 内 v.parse 同步抛（非 Promise rejection）
    expect(() =>
      placeImageFromBytesTool.execute(figma, { name: 'a.png', mime: 'image/png' })
    ).toThrow()
  })
})
