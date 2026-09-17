/**
 * generate_image 输出尺寸分流钉扎（2026-09-17 长图实测问题 6 回归）：
 * 新建节点按 agent 原始请求尺寸创建——16px 对齐/钳制是 provider/API 约束，
 * 只作用于 begin 返回的 API size（width/height），不得泄露为画布节点尺寸
 * （canvasWidth/canvasHeight）。曾发 bug：hero 候选 B 请求 750x950，节点
 * 落成归一值 752x944，偏离脚手架槽位网格。
 */
import { describe, expect, test } from 'bun:test'

import { FigmaAPI, SceneGraph } from '@open-pencil/core'
import { beginImageGen } from '@open-pencil/core/tools/fork/image-gen/apply'

function setup() {
  const graph = new SceneGraph()
  const figma = new FigmaAPI(graph)
  return { graph, figma, pageId: figma.currentPageId }
}

describe('beginImageGen 输出尺寸分流（节点 = 原始请求值，API size = 归一值）', () => {
  test('新帧按原始请求尺寸 750x950 创建，API size 归一为 752x944', async () => {
    const { graph, figma } = setup()
    const result = await beginImageGen(figma, { prompt: 'hero', width: 750, height: 950 })
    const node = graph.getNode(result.targetId)
    expect(result.replaced).toBe(false)
    expect(node?.width).toBe(750)
    expect(node?.height).toBe(950)
    expect(result.canvasWidth).toBe(750)
    expect(result.canvasHeight).toBe(950)
    expect(result.width).toBe(752)
    expect(result.height).toBe(944)
  })

  test('replace 路径节点尺寸不动；无显式尺寸时 API size 取目标节点归一值', async () => {
    const { graph, figma, pageId } = setup()
    const target = graph.createNode('FRAME', pageId, { name: 'slot', width: 750, height: 950 })
    const result = await beginImageGen(figma, { prompt: 'hero', replaceId: target.id })
    expect(result.replaced).toBe(true)
    expect(result.canvasWidth).toBe(750)
    expect(result.canvasHeight).toBe(950)
    expect(result.width).toBe(752)
    expect(result.height).toBe(944)
    expect(graph.getNode(target.id)?.width).toBe(750)
    expect(graph.getNode(target.id)?.height).toBe(950)
  })

  test('replace + 显式尺寸：节点仍保持原尺寸，API size 取显式请求归一值', async () => {
    const { graph, figma, pageId } = setup()
    const target = graph.createNode('FRAME', pageId, { name: 'slot', width: 800, height: 600 })
    const result = await beginImageGen(figma, {
      prompt: 'hero',
      replaceId: target.id,
      width: 750,
      height: 950
    })
    expect(result.canvasWidth).toBe(800)
    expect(result.canvasHeight).toBe(600)
    expect(result.width).toBe(752)
    expect(result.height).toBe(944)
  })
})
