/**
 * T54：snapshotBeforeOverwrite 钉扎（验收锚 T54-plan §3.1）——
 * 仅 IMAGE fill 才快照；同 hash 去重；容器/条目标记与 isInImageHistory；
 * 克隆剥离外来标记。
 *
 * T66 ⑤（备份容器迁专用页）：容器落专用备份页「图片备份」（页身份由容器
 * 节点级 pluginData 标记派生 + 页名兜底），不再锚定设计页 marketing root；
 * 备份页/容器幂等复用；跨页目标快照落同一全局容器，读取按 source-target 标记一致。
 */
import { describe, expect, test } from 'bun:test'

import { FigmaAPI, SceneGraph } from '@open-pencil/core'
import {
  isInImageHistory,
  snapshotBeforeOverwrite
} from '@open-pencil/core/tools/fork/image-gen/history'
import { PLACEMENT_GAP } from '@open-pencil/core/tools/fork/placement'

import { expectDefined } from '#tests/helpers/assert'

function setup() {
  const graph = new SceneGraph()
  const figma = new FigmaAPI(graph)
  return { graph, figma, pageId: figma.currentPageId }
}

function imageFill(hash: string) {
  return {
    type: 'IMAGE' as const,
    color: { r: 1, g: 1, b: 1, a: 1 },
    opacity: 1,
    visible: true,
    imageHash: hash,
    imageScaleMode: 'FILL' as const
  }
}

function createTarget(graph: SceneGraph, pageId: string, hash = 'hash-1', name = 'hero') {
  graph.images.set(hash, new Uint8Array([1, 2, 3]))
  return graph.createNode('RECTANGLE', pageId, {
    name,
    x: 0,
    y: 0,
    width: 1024,
    height: 1024,
    fills: [imageFill(hash)]
  })
}

function markerOf(graph: SceneGraph, id: string, key: string): string | undefined {
  return graph
    .getNode(id)
    ?.pluginData.find((entry) => entry.pluginId === 'open-pencil-image-gen' && entry.key === key)
    ?.value
}

/** 页身份由容器节点标记派生（与 history.ts 查找口径一致）：找顶层子含历史容器的页 */
function backupPageOf(graph: SceneGraph) {
  return graph
    .getPages()
    .find((page) =>
      page.childIds.some(
        (childId) => markerOf(graph, childId, 'role') === 'image-history-container'
      )
    )
}

describe('snapshotBeforeOverwrite', () => {
  test('IMAGE fill 目标 → 克隆进历史容器（标记齐全，容器落专用备份页）', () => {
    const { graph, pageId } = setup()
    const target = createTarget(graph, pageId)
    const snapshot = expectDefined(snapshotBeforeOverwrite(graph, target.id), 'snapshot')

    const clone = expectDefined(graph.getNode(snapshot.id), 'clone node')
    expect(clone.name).toBe('hero · v1')
    expect(markerOf(graph, clone.id, 'role')).toBe('image-history-entry')
    expect(markerOf(graph, clone.id, 'source-target')).toBe(target.id)
    expect(markerOf(graph, clone.id, 'source-hash')).toBe('hash-1')
    expect(markerOf(graph, clone.id, 'version')).toBe('1')

    const container = expectDefined(graph.getNode(clone.parentId ?? ''), 'container')
    expect(container.name).toBe('历史图片备份')
    expect(markerOf(graph, container.id, 'role')).toBe('image-history-container')

    // T66 ⑤：容器落专用备份页「图片备份」（标记幂等查找），不与设计页同页
    const backupPage = expectDefined(backupPageOf(graph), 'backup page')
    expect(backupPage.name).toBe('图片备份')
    expect(backupPage.id).not.toBe(pageId)
    expect(container.parentId).toBe(backupPage.id)
    expect(graph.getNode(pageId)?.childIds ?? []).not.toContain(container.id)

    // isInImageHistory：容器、条目、条目后代均为 true；普通节点 false
    expect(isInImageHistory(graph, container.id)).toBe(true)
    expect(isInImageHistory(graph, clone.id)).toBe(true)
    expect(isInImageHistory(graph, target.id)).toBe(false)
  })

  test('非 IMAGE fill（纯色）→ 不快照（也不创建备份页）', () => {
    const { graph, pageId } = setup()
    const node = graph.createNode('RECTANGLE', pageId, {
      name: 'solid',
      width: 100,
      height: 100,
      fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }]
    })
    expect(snapshotBeforeOverwrite(graph, node.id)).toBeUndefined()
    // T66 ⑤：无可备份内容时不新建备份页（懒创建）
    expect(backupPageOf(graph)).toBeUndefined()
  })

  test('同 hash 去重：连续两次快照同一未变图像 → 第二次 no-op', () => {
    const { graph, pageId } = setup()
    const target = createTarget(graph, pageId)
    expect(snapshotBeforeOverwrite(graph, target.id)).toBeDefined()
    expect(snapshotBeforeOverwrite(graph, target.id)).toBeUndefined()
  })

  test('hash 变化 → 新版本 v2', () => {
    const { graph, pageId } = setup()
    const target = createTarget(graph, pageId)
    snapshotBeforeOverwrite(graph, target.id)
    graph.images.set('hash-2', new Uint8Array([4, 5, 6]))
    graph.updateNode(target.id, { fills: [imageFill('hash-2')] })
    const second = expectDefined(snapshotBeforeOverwrite(graph, target.id), 'v2 snapshot')
    expect(markerOf(graph, second.id, 'version')).toBe('2')
    expect(second.name).toBe('hero · v2')
  })

  test('克隆剥离外来 pluginData 标记', () => {
    const { graph, pageId } = setup()
    const target = createTarget(graph, pageId)
    graph.updateNode(target.id, {
      pluginData: [{ pluginId: 'open-pencil-marketing', key: 'role', value: 'marketing-root' }]
    })
    const snapshot = expectDefined(snapshotBeforeOverwrite(graph, target.id), 'snapshot')
    const clone = expectDefined(graph.getNode(snapshot.id), 'clone')
    expect(
      clone.pluginData.find((entry) => entry.pluginId === 'open-pencil-marketing')
    ).toBeUndefined()
  })

  test('T66 ⑤：有 marketing root 也不锚定——容器落备份页（空页原点），设计页零新增', () => {
    const { graph, pageId } = setup()
    const root = graph.createNode('FRAME', pageId, {
      name: 'root',
      x: 1000,
      y: 200,
      width: 1080,
      height: 5000
    })
    graph.updateNode(root.id, {
      pluginData: [{ pluginId: 'open-pencil-marketing', key: 'role', value: 'marketing-root' }]
    })
    const target = graph.createNode('RECTANGLE', root.id, {
      name: 'hero',
      x: 0,
      y: 0,
      width: 1024,
      height: 1024,
      fills: [imageFill('hash-1')]
    })
    graph.images.set('hash-1', new Uint8Array([1]))
    const snapshot = expectDefined(snapshotBeforeOverwrite(graph, target.id), 'snapshot')
    const container = expectDefined(
      graph.getNode(graph.getNode(snapshot.id)?.parentId ?? ''),
      'container'
    )
    // 不再锚定 marketing root 右侧（旧：x = 1000+1080+100, y = 200 在设计页）
    const backupPage = expectDefined(backupPageOf(graph), 'backup page')
    expect(container.parentId).toBe(backupPage.id)
    expect(container.x).toBe(0)
    expect(container.y).toBe(0)
    // 设计页顶层只有 root，无容器新增
    expect(graph.getNode(pageId)?.childIds).toEqual([root.id])
  })

  test('T66 ⑤ 幂等：二次快照复用同一备份页与同一容器（不新建 page）', () => {
    const { graph, pageId } = setup()
    const a = createTarget(graph, pageId, 'hash-a', 'a')
    const b = createTarget(graph, pageId, 'hash-b', 'b')

    const snapA = expectDefined(snapshotBeforeOverwrite(graph, a.id), 'snapshot A')
    const pagesAfterFirst = graph.getPages().length
    expect(pagesAfterFirst).toBe(2) // Page 1 + 图片备份

    const snapB = expectDefined(snapshotBeforeOverwrite(graph, b.id), 'snapshot B')
    expect(graph.getPages().length).toBe(pagesAfterFirst)
    expect(graph.getPages().filter((p) => p.name === '图片备份')).toHaveLength(1)

    const containerA = graph.getNode(snapA.id)?.parentId
    const containerB = graph.getNode(snapB.id)?.parentId
    expect(containerA).toBeDefined()
    expect(containerB).toBe(containerA)
  })

  test('备份页改名后仍命中（容器节点标记派生，rename-proof），且不写页级标记', () => {
    const { graph, pageId } = setup()
    const a = createTarget(graph, pageId, 'hash-a', 'a')
    expectDefined(snapshotBeforeOverwrite(graph, a.id), 'snapshot A')

    const backupPage = expectDefined(backupPageOf(graph), 'backup page')
    // 页级 pluginData 不再写入（page 级映射已退役，身份由容器标记派生）
    expect(markerOf(graph, backupPage.id, 'role')).toBeUndefined()

    // 用户改名后第二次快照：仍经容器标记找到同一页，不新建
    graph.updateNode(backupPage.id, { name: '我的归档' })
    const pagesAfterRename = graph.getPages().length
    const b = createTarget(graph, pageId, 'hash-b', 'b')
    expectDefined(snapshotBeforeOverwrite(graph, b.id), 'snapshot B')
    expect(graph.getPages().length).toBe(pagesAfterRename)
    expect(backupPageOf(graph)?.id).toBe(backupPage.id)
  })

  test('T66 ⑤ 跨页：不同页目标快照落同一全局容器，source-target 标记各自键定', () => {
    const { graph, pageId } = setup()
    const page2 = graph.addPage('Page 2')
    const targetOnPage1 = createTarget(graph, pageId, 'hash-p1', 'p1-hero')
    const targetOnPage2 = createTarget(graph, page2.id, 'hash-p2', 'p2-hero')

    const snap1 = expectDefined(snapshotBeforeOverwrite(graph, targetOnPage1.id), 'snapshot p1')
    const snap2 = expectDefined(snapshotBeforeOverwrite(graph, targetOnPage2.id), 'snapshot p2')

    // 同一备份页、同一容器（全局单容器，entry 以 source-target 区分来源）
    const backupPage = expectDefined(backupPageOf(graph), 'backup page')
    const container1 = expectDefined(graph.getNode(snap1.id)?.parentId, 'container of snap1')
    const container2 = graph.getNode(snap2.id)?.parentId
    expect(container2).toBe(container1)
    expect(graph.getNode(container1)?.parentId).toBe(backupPage.id)

    // 跨页恢复读取一致性：按 source-target 标记各回各源，isInImageHistory 正确判定
    expect(markerOf(graph, snap1.id, 'source-target')).toBe(targetOnPage1.id)
    expect(markerOf(graph, snap2.id, 'source-target')).toBe(targetOnPage2.id)
    expect(isInImageHistory(graph, snap1.id)).toBe(true)
    expect(isInImageHistory(graph, snap2.id)).toBe(true)
    expect(isInImageHistory(graph, targetOnPage1.id)).toBe(false)
    expect(isInImageHistory(graph, targetOnPage2.id)).toBe(false)
  })

  test('T66 ⑤ 放置：备份页已有内容时容器走统一放置策略（bounds 右侧 + GAP）', () => {
    const { graph, pageId } = setup()
    // 预造名为「图片备份」的既有页（无容器、无页级标记）——走页名兜底路径
    const backup = graph.addPage('图片备份')
    graph.createNode('FRAME', backup.id, {
      name: 'existing',
      x: 40,
      y: 20,
      width: 300,
      height: 100
    })

    const target = createTarget(graph, pageId)
    const snapshot = expectDefined(snapshotBeforeOverwrite(graph, target.id), 'snapshot')
    const container = expectDefined(
      graph.getNode(graph.getNode(snapshot.id)?.parentId ?? ''),
      'container'
    )
    expect(container.parentId).toBe(backup.id)
    // 统一放置策略：bounds(40,20,300,100) 右侧 + PLACEMENT_GAP，y 跟随 bounds 顶
    expect(container.x).toBe(40 + 300 + PLACEMENT_GAP)
    expect(container.y).toBe(20)
  })
})
