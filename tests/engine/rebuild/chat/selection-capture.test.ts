/**
 * T70：画布选区采集——selection-capture 纯函数面 + 提交拼接格式钉扎。
 *
 * 验收映射（T70-plan §4 / 实现点 1-6）：
 *  - 采集（captureSelection/FromStore）：空选区 → null；单/多节点快照
 *    （id + 名称 + 类型，顺序保持）；选中 id 已失效 → 跳过
 *  - 扫描（scanSelectionTokens）：混排文本占位串定位（start/end 精确）；
 *    半删残串不识别
 *  - 原子删除（atomicTokenDeletionRange）：Backspace/Delete 光标紧邻完整
 *    占位串 → 整段区间；光标落中间/不紧邻 → null（走默认逐字删）
 *  - 清单（serializeSelectionManifest，§1.4 逐字钉扎）：单节点行 / 多节点
 *    ` + ` 连接 / 两 token 验收句「将「@画布选区-1」变成「@画布选区-2」的风格」
 *    / 已删节点标（已删除）/ 手打无登记占位串标「未采集的引用」/ 采集后改名
 *    以发送瞬间为准 / 同 token 重复引用一行 / 未引用登记条目不出现
 *  - 草稿状态：序号重置（reset）+ T27 快照-恢复往返（snapshot/restore）
 *  - 回填剥尾（stripSelectionManifest）：提交文本剥清单还原草稿；手打相似
 *    文本无「空行 + 全格式行」结构时不动
 */

import { describe, expect, test } from 'bun:test'

import { createEditorStore } from '@/app/editor/session'
import {
  atomicTokenDeletionRange,
  captureSelection,
  captureSelectionFromStore,
  createSelectionDraftState,
  removeSelectionToken,
  resetSelectionDraftState,
  restoreSelectionDraftState,
  scanSelectionTokens,
  segmentsFromText,
  segmentsToText,
  selectionTokenText,
  serializeSelectionManifest,
  snapshotSelectionDraftState,
  stripSelectionManifest,
  type SelectionNodeReader,
  type SelectionTokenRegistry
} from '@/components/assistant/selection-capture'

import { expectDefined } from '#tests/helpers/assert'

/** 纯 reader 假实现（不依赖 graph——格式钉扎用确定 id/名称/类型） */
function fakeReader(nodes: Record<string, { name: string; type: string }>): SelectionNodeReader {
  return { getNode: (id) => nodes[id] }
}

function makeRegistry(
  entries: Array<{ n: number; nodeIds: string[]; names?: string[]; types?: string[] }>
): SelectionTokenRegistry {
  const registry: SelectionTokenRegistry = new Map()
  for (const entry of entries) {
    registry.set(entry.n, {
      n: entry.n,
      pageId: '0:1',
      nodeIds: entry.nodeIds,
      snapshot: entry.nodeIds.map((nodeId, i) => ({
        nodeId,
        name: entry.names?.[i] ?? nodeId,
        type: entry.types?.[i] ?? 'FRAME'
      }))
    })
  }
  return registry
}

// ── 采集 ─────────────────────────────────────────────────────────────────────

describe('captureSelection（T70 实现点 1）', () => {
  test('空选区 → null（不产生 token）', () => {
    const store = createEditorStore()
    expect(store.state.selectedIds.size).toBe(0)
    expect(captureSelectionFromStore(store, 1)).toBeNull()
  })

  test('单节点：登记 pageId + nodeIds + 名称/类型快照', () => {
    const store = createEditorStore()
    const pageId = store.state.currentPageId
    const frame = store.graph.createNode('FRAME', pageId, {
      name: '主视觉',
      width: 100,
      height: 100
    })
    store.select([frame.id])

    const entry = captureSelectionFromStore(store, 1)
    expect(entry).not.toBeNull()
    expect(entry?.n).toBe(1)
    expect(entry?.pageId).toBe(pageId)
    expect(entry?.nodeIds).toEqual([frame.id])
    expect(entry?.snapshot).toEqual([{ nodeId: frame.id, name: '主视觉', type: 'FRAME' }])
  })

  test('多节点：选区顺序保持；选中 id 已失效 → 跳过', () => {
    const store = createEditorStore()
    const pageId = store.state.currentPageId
    const a = store.graph.createNode('FRAME', pageId, { name: 'A', width: 10, height: 10 })
    const b = store.graph.createNode('TEXT', pageId, { name: 'B', width: 10, height: 10 })
    store.select([a.id, 'missing:id', b.id])

    const entry = captureSelectionFromStore(store, 7)
    expect(entry?.nodeIds).toEqual([a.id, b.id])
    expect(entry?.snapshot.map((s) => s.type)).toEqual(['FRAME', 'TEXT'])
  })

  test('captureSelection 纯函数：全部选中 id 失效 → null', () => {
    const entry = captureSelection(
      { pageId: '0:1', selectedIds: ['gone:1', 'gone:2'] },
      fakeReader({}),
      1
    )
    expect(entry).toBeNull()
  })
})

// ── 占位串扫描 ───────────────────────────────────────────────────────────────

describe('scanSelectionTokens（T70 实现点 2/3）', () => {
  test('混排文本：start/end 精确定位（含前后文字）', () => {
    const text = `把${selectionTokenText(1)}变成${selectionTokenText(2)}的风格`
    const tokens = scanSelectionTokens(text)
    expect(tokens).toEqual([
      { n: 1, start: 1, end: 1 + selectionTokenText(1).length },
      { n: 2, start: 1 + selectionTokenText(1).length + 2, end: text.length - 3 }
    ])
    expect(text.slice(tokens[0].start, tokens[0].end)).toBe(selectionTokenText(1))
    expect(text.slice(tokens[1].start, tokens[1].end)).toBe(selectionTokenText(2))
  })

  test('半删残串不识别（缺角括号/缺序号都不是 token）', () => {
    expect(scanSelectionTokens('「@画布选区-1')).toEqual([])
    expect(scanSelectionTokens('@画布选区-1」')).toEqual([])
    expect(scanSelectionTokens('「@画布选区-」')).toEqual([])
    expect(scanSelectionTokens('「@画布选区-1」残「@画布选区-2」')).toHaveLength(2)
  })
})

// ── 原子删除区间 ─────────────────────────────────────────────────────────────

describe('atomicTokenDeletionRange（T70 实现点 3）', () => {
  const token = selectionTokenText(1)
  const text = `前${token}后`

  test('Backspace：光标紧邻 token 尾 → 整段区间', () => {
    const cursor = 1 + token.length
    expect(atomicTokenDeletionRange(text, cursor, 'backward')).toEqual({
      start: 1,
      end: cursor
    })
  })

  test('Delete：光标紧贴 token 头 → 整段区间', () => {
    expect(atomicTokenDeletionRange(text, 1, 'forward')).toEqual({
      start: 1,
      end: 1 + token.length
    })
  })

  test('光标落 token 中间/不紧邻 → null（默认逐字删）', () => {
    // token 中间（backward/forward 都不拦）
    expect(atomicTokenDeletionRange(text, 3, 'backward')).toBeNull()
    expect(atomicTokenDeletionRange(text, 3, 'forward')).toBeNull()
    // 紧邻 token 尾但方向反了（光标后是「后」字）
    expect(atomicTokenDeletionRange(text, 1 + token.length, 'forward')).toBeNull()
    // 紧邻 token 头但方向反了（光标前是「前」字）
    expect(atomicTokenDeletionRange(text, 1, 'backward')).toBeNull()
    // 文档起止边界
    expect(atomicTokenDeletionRange(token, 0, 'backward')).toBeNull()
    expect(atomicTokenDeletionRange(token, token.length, 'forward')).toBeNull()
  })

  test('token 在文末：Backspace 删整段后不留残串', () => {
    const tail = `文字${token}`
    const range = expectDefined(atomicTokenDeletionRange(tail, tail.length, 'backward'))
    expect(range).toEqual({ start: 2, end: tail.length })
    expect(tail.slice(0, range.start) + tail.slice(range.end)).toBe('文字')
  })
})

// ── 提交清单（§1.4 逐字钉扎） ────────────────────────────────────────────────

describe('serializeSelectionManifest（T70 实现点 4）', () => {
  test('无 token → 原文返回（不追加清单）', () => {
    const result = serializeSelectionManifest('普通消息', new Map(), fakeReader({}))
    expect(result.text).toBe('普通消息')
    expect(result.referencedNs).toEqual([])
    expect(result.uncollectedNs).toEqual([])
  })

  test('单 token 单节点：逐字格式（空行 + [画布选区] 头 + 清单行）', () => {
    const registry = makeRegistry([{ n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] }])
    const reader = fakeReader({ '1:23': { name: '主标题', type: 'TEXT' } })
    const result = serializeSelectionManifest(
      `参考${selectionTokenText(1)}改一版`,
      registry,
      reader
    )
    expect(result.text).toBe(
      `参考${selectionTokenText(1)}改一版\n\n[画布选区]\n@画布选区-1 = 节点 1:23「主标题」(TEXT)`
    )
    expect(result.referencedNs).toEqual([1])
    expect(result.uncollectedNs).toEqual([])
  })

  test('多节点 token：一行内 ` + ` 连接（§1.4 第二行形态）', () => {
    const registry = makeRegistry([
      { n: 2, nodeIds: ['4:56', '4:57'], names: ['主视觉', '装饰'], types: ['FRAME', 'VECTOR'] }
    ])
    const reader = fakeReader({
      '4:56': { name: '主视觉', type: 'FRAME' },
      '4:57': { name: '装饰', type: 'VECTOR' }
    })
    const result = serializeSelectionManifest(selectionTokenText(2), registry, reader)
    expect(result.text).toBe(
      `${selectionTokenText(2)}\n\n[画布选区]\n@画布选区-2 = 节点 4:56「主视觉」(FRAME) + 节点 4:57「装饰」(VECTOR)`
    )
  })

  test('两 token 验收句：「将@画布选区-1变成@画布选区-2的风格」→ 尾部两行', () => {
    const registry = makeRegistry([
      { n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] },
      { n: 2, nodeIds: ['4:56'], names: ['主视觉'], types: ['FRAME'] }
    ])
    const reader = fakeReader({
      '1:23': { name: '主标题', type: 'TEXT' },
      '4:56': { name: '主视觉', type: 'FRAME' }
    })
    const draft = `将${selectionTokenText(1)}变成${selectionTokenText(2)}的风格`
    const result = serializeSelectionManifest(draft, registry, reader)
    expect(result.text).toBe(
      `${draft}\n\n[画布选区]\n@画布选区-1 = 节点 1:23「主标题」(TEXT)\n@画布选区-2 = 节点 4:56「主视觉」(FRAME)`
    )
    expect(result.referencedNs).toEqual([1, 2])
  })

  test('采集后删除节点 → 清单标（已删除），名称回落采集快照', () => {
    const registry = makeRegistry([{ n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] }])
    const result = serializeSelectionManifest(selectionTokenText(1), registry, fakeReader({}))
    expect(result.text).toBe(
      `${selectionTokenText(1)}\n\n[画布选区]\n@画布选区-1 = 节点 1:23「主标题」(已删除)`
    )
  })

  test('采集后改名 → 清单以发送瞬间 graph 状态为准（新名 + 新类型）', () => {
    const registry = makeRegistry([{ n: 1, nodeIds: ['1:23'], names: ['旧名'], types: ['TEXT'] }])
    const reader = fakeReader({ '1:23': { name: '改名后', type: 'TEXT' } })
    const result = serializeSelectionManifest(selectionTokenText(1), registry, reader)
    expect(result.text).toContain('节点 1:23「改名后」(TEXT)')
    expect(result.text).not.toContain('旧名')
  })

  test('手打无登记占位串 → 清单标「未采集的引用」+ uncollectedNs', () => {
    const result = serializeSelectionManifest(
      `看看${selectionTokenText(9)}`,
      new Map(),
      fakeReader({})
    )
    expect(result.text).toBe(
      `看看${selectionTokenText(9)}\n\n[画布选区]\n@画布选区-9 = 未采集的引用`
    )
    expect(result.uncollectedNs).toEqual([9])
  })

  test('同 token 文中重复引用 → 清单只出一行；未引用登记条目不出现', () => {
    const registry = makeRegistry([
      { n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] },
      { n: 2, nodeIds: ['4:56'], names: ['未被引用的'], types: ['FRAME'] }
    ])
    const reader = fakeReader({ '1:23': { name: '主标题', type: 'TEXT' } })
    const draft = `${selectionTokenText(1)}再提一次${selectionTokenText(1)}`
    const result = serializeSelectionManifest(draft, registry, reader)
    expect(result.text).toBe(`${draft}\n\n[画布选区]\n@画布选区-1 = 节点 1:23「主标题」(TEXT)`)
  })

  test('清单行序 = token 首现序（非序号大小序）', () => {
    const registry = makeRegistry([
      { n: 1, nodeIds: ['1:23'], names: ['一'], types: ['TEXT'] },
      { n: 2, nodeIds: ['4:56'], names: ['二'], types: ['FRAME'] }
    ])
    const reader = fakeReader({
      '1:23': { name: '一', type: 'TEXT' },
      '4:56': { name: '二', type: 'FRAME' }
    })
    const draft = `${selectionTokenText(2)}先于${selectionTokenText(1)}`
    const result = serializeSelectionManifest(draft, registry, reader)
    expect(result.referencedNs).toEqual([2, 1])
    const lines = result.text.split('\n')
    // [draft, '', '[画布选区]', 行1, 行2]——空行占位
    expect(lines[3]).toBe('@画布选区-2 = 节点 4:56「二」(FRAME)')
    expect(lines[4]).toBe('@画布选区-1 = 节点 1:23「一」(TEXT)')
  })

  // ── manifest v2（§8 选区跨页引用）：清单行补页标注 ────────────────────────
  //
  // 数据现成（entry.pageId 已含）；页名由 reader 提供。
  // 页未知兼容：reader 缺页信息 → 优雅省略标注（与旧消息回放 / 单测 fakeReader
  // 默认形态共存），不破坏 T70 既有用例。

  test('manifest v2：reader 知道页名 → 清单行追加 ` @页「<名>」`', () => {
    const registry = makeRegistry([{ n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] }])
    const reader = fakeReader({
      '1:23': { name: '主标题', type: 'TEXT' },
      // fakeReader 的 `getNode` 同时承担页查找——传页 id 入映射即可。
      '0:1': { name: '封面', type: 'CANVAS' }
    })
    const result = serializeSelectionManifest(selectionTokenText(1), registry, reader)
    expect(result.text).toBe(
      `${selectionTokenText(1)}\n\n[画布选区]\n@画布选区-1 = 节点 1:23「主标题」(TEXT) @页「封面」`
    )
  })

  test('manifest v2：reader 缺页信息 → 不加标注（页未知兼容）', () => {
    // fakeReader 默认映射只含节点 id，pageId '0:1' 查不到 → 标注省略。
    const registry = makeRegistry([{ n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] }])
    const reader = fakeReader({ '1:23': { name: '主标题', type: 'TEXT' } })
    const result = serializeSelectionManifest(selectionTokenText(1), registry, reader)
    expect(result.text).toBe(
      `${selectionTokenText(1)}\n\n[画布选区]\n@画布选区-1 = 节点 1:23「主标题」(TEXT)`
    )
  })

  test('manifest v2：已删节点仍带页标注（页 = 采集时已知，节点死活无关）', () => {
    const registry = makeRegistry([{ n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] }])
    const reader = fakeReader({
      // 节点已删，reader 只剩页映射
      '0:1': { name: '封面', type: 'CANVAS' }
    })
    const result = serializeSelectionManifest(selectionTokenText(1), registry, reader)
    expect(result.text).toBe(
      `${selectionTokenText(1)}\n\n[画布选区]\n@画布选区-1 = 节点 1:23「主标题」(已删除) @页「封面」`
    )
  })

  test('manifest v2：未采集引用行不加页标注（无 entry → 无 pageId）', () => {
    const result = serializeSelectionManifest(selectionTokenText(9), new Map(), fakeReader({}))
    expect(result.text).toBe(`${selectionTokenText(9)}\n\n[画布选区]\n@画布选区-9 = 未采集的引用`)
  })

  test('store 端到端：采集 → 删除节点 → 清单标（已删除）', () => {
    const store = createEditorStore()
    const pageId = store.state.currentPageId
    const frame = store.graph.createNode('FRAME', pageId, {
      name: '主视觉',
      width: 100,
      height: 100
    })
    store.select([frame.id])
    const entry = expectDefined(captureSelectionFromStore(store, 1))
    const registry: SelectionTokenRegistry = new Map([[entry.n, entry]])

    store.graph.updateNode(frame.id, { name: '主视觉 v2' })
    const live = serializeSelectionManifest(selectionTokenText(1), registry, store.graph)
    expect(live.text).toContain(`节点 ${frame.id}「主视觉 v2」(FRAME)`)

    store.graph.deleteNode(frame.id)
    const gone = serializeSelectionManifest(selectionTokenText(1), registry, store.graph)
    expect(gone.text).toContain(`节点 ${frame.id}「主视觉」(已删除)`)
  })
})

// ── 草稿状态（序号生命周期 + T27 快照往返） ──────────────────────────────────

describe('草稿期 token 状态（T70 实现点 1/5）', () => {
  test('序号从 1 递增；reset 后归 1（发送后重置纪律）', () => {
    const state = createSelectionDraftState()
    expect(state.nextSeq).toBe(1)
    state.registry.set(state.nextSeq, { n: 1, pageId: '0:1', nodeIds: ['1:1'], snapshot: [] })
    state.nextSeq += 1
    state.registry.set(state.nextSeq, { n: 2, pageId: '0:1', nodeIds: ['1:2'], snapshot: [] })
    state.nextSeq += 1
    expect(state.nextSeq).toBe(3)

    resetSelectionDraftState(state)
    expect(state.nextSeq).toBe(1)
    expect(state.registry.size).toBe(0)
  })

  test('T27 快照-恢复往返：提交前快照 → reset → 恢复后登记表/序号原样', () => {
    const state = createSelectionDraftState()
    const reader = fakeReader({ '1:23': { name: '主标题', type: 'TEXT' } })
    const entry = expectDefined(
      captureSelection({ pageId: '0:1', selectedIds: ['1:23'] }, reader, state.nextSeq)
    )
    state.registry.set(entry.n, entry)
    state.nextSeq += 1

    const snapshot = snapshotSelectionDraftState(state)
    resetSelectionDraftState(state)
    expect(state.registry.size).toBe(0)
    expect(state.nextSeq).toBe(1)

    restoreSelectionDraftState(state, snapshot)
    expect(state.nextSeq).toBe(2)
    expect(state.registry.get(1)).toEqual(entry)
  })

  test('快照深拷贝独立：提交后原地改 state 不污染快照', () => {
    const state = createSelectionDraftState()
    state.registry.set(1, {
      n: 1,
      pageId: '0:1',
      nodeIds: ['1:23'],
      snapshot: [{ nodeId: '1:23', name: '主标题', type: 'TEXT' }]
    })
    const snapshot = snapshotSelectionDraftState(state)
    state.registry.get(1)?.nodeIds.push('9:99')
    state.registry.get(1)?.snapshot.push({ nodeId: '9:99', name: 'X', type: 'FRAME' })
    expect(snapshot.registry.get(1)?.nodeIds).toEqual(['1:23'])
    expect(snapshot.registry.get(1)?.snapshot).toHaveLength(1)
  })
})

// ── 回填剥尾 ─────────────────────────────────────────────────────────────────

describe('stripSelectionManifest（T70 实现点 5，T27 回填）', () => {
  test('含清单的提交文本 → 剥尾还原草稿（占位串保留）', () => {
    const draft = `将${selectionTokenText(1)}变成${selectionTokenText(2)}的风格`
    const registry = makeRegistry([
      { n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] },
      { n: 2, nodeIds: ['4:56'], names: ['主视觉'], types: ['FRAME'] }
    ])
    const reader = fakeReader({
      '1:23': { name: '主标题', type: 'TEXT' },
      '4:56': { name: '主视觉', type: 'FRAME' }
    })
    const submitted = serializeSelectionManifest(draft, registry, reader).text
    expect(stripSelectionManifest(submitted)).toBe(draft)
  })

  test('无清单原文不动；手打相似文本（无空行分隔结构）不动', () => {
    expect(stripSelectionManifest('普通消息')).toBe('普通消息')
    const handTyped = '[画布选区]\n@画布选区-1 = 节点 1:23「主标题」(TEXT)'
    expect(stripSelectionManifest(handTyped)).toBe(handTyped)
  })
})

// ── chip 行 X 移除（Batch 2g+：缩略图 chip 显示层替换） ─────────────────────
//
// chip 是选区在输入框里的视觉代理；点 X = 视觉代理消失 = 文本流里该 n 的
// 全部占位串同步删掉。payload 不变（serializeSelectionManifest 仍按文本
// 流实扫——少一条占位串 = 清单少一行，与用户手删占位串同路径）。

describe('removeSelectionToken（chip X 移除）', () => {
  test('单出现 → 整段占位串删除，前文/后文保留', () => {
    const text = `改一下${selectionTokenText(1)}的颜色`
    expect(removeSelectionToken(text, 1)).toBe('改一下的颜色')
  })

  test('多出现：同 n 全部删除；其他 n 保留', () => {
    const text = `把${selectionTokenText(1)}复刻到${selectionTokenText(1)}，再叠${selectionTokenText(2)}`
    expect(removeSelectionToken(text, 1)).toBe('把复刻到，再叠「@画布选区-2」')
  })

  test('不存在的 n → 文本不动', () => {
    const text = `改一下${selectionTokenText(1)}的颜色`
    expect(removeSelectionToken(text, 9)).toBe(text)
  })

  test('前后空格/标点不动（最小侵入，只剥占位串字面）', () => {
    const text = `  ${selectionTokenText(3)}  `
    expect(removeSelectionToken(text, 3)).toBe('    ')
  })

  test('无 token 文本不动', () => {
    expect(removeSelectionToken('普通消息', 1)).toBe('普通消息')
  })

  test('手打半删残串不识别（占位串契约的原子边界）', () => {
    expect(removeSelectionToken('「@画布选区-1', 1)).toBe('「@画布选区-1')
  })

  test('payload 语义不变：删除后 serializeSelectionManifest 实扫少一行', () => {
    const draft = `改一下${selectionTokenText(1)}和${selectionTokenText(2)}的颜色`
    const trimmed = removeSelectionToken(draft, 1)
    const registry = makeRegistry([
      { n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] },
      { n: 2, nodeIds: ['4:56'], names: ['主视觉'], types: ['FRAME'] }
    ])
    const reader = fakeReader({
      '1:23': { name: '主标题', type: 'TEXT' },
      '4:56': { name: '主视觉', type: 'FRAME' }
    })
    const out = serializeSelectionManifest(trimmed, registry, reader)
    expect(out.referencedNs).toEqual([2])
    expect(out.text).not.toContain('@画布选区-1')
    expect(out.text).toContain('@画布选区-2')
  })
})

// ── 分段模型（contenteditable 内嵌 chip 双向桥） ─────────────────────────────
//
// 内嵌 chip UI 把选区 token 渲成 contenteditable=false 的原子节点（不进可
// 编辑文本流）。序列化时仍要产出与旧 textarea 路径**逐字节一致**的 payload：
// 分段 → 字面 `「@画布选区-N」` → 既有 serializeSelectionManifest。
// segmentsFromText / segmentsToText 是这条桥的纯函数面。钉扎：
//   - 多 token 在文首/文中/文尾都正确切分
//   - 普通文本不含 token → 单文本段
//   - 连续两个 token 中间无文本 → 不产空文本段
//   - 半删残串归到相邻文本段（不切）
//   - 双向 roundtrip = 原文
//   - 走 segmentsToText → serializeSelectionManifest 与旧路径字节等价

describe('segmentsFromText / segmentsToText（contenteditable chip 双向桥）', () => {
  test('普通文本不含 token → 单文本段', () => {
    expect(segmentsFromText('普通消息')).toEqual([{ kind: 'text', text: '普通消息' }])
    // 空串 → 空段数组（无 token 可切、无字符可承载；双向 roundtrip = 空串）
    expect(segmentsFromText('')).toEqual([])
  })

  test('单 token 在文末 → 文本段 + token 段', () => {
    const text = `改一下${selectionTokenText(1)}的颜色`
    expect(segmentsFromText(text)).toEqual([
      { kind: 'text', text: '改一下' },
      { kind: 'token', n: 1 },
      { kind: 'text', text: '的颜色' }
    ])
  })

  test('单 token 在文首 → token 段 + 文本段', () => {
    const text = `${selectionTokenText(1)}这里改一版`
    expect(segmentsFromText(text)).toEqual([
      { kind: 'token', n: 1 },
      { kind: 'text', text: '这里改一版' }
    ])
  })

  test('单 token 在文中 → 文本段 + token 段 + 文本段', () => {
    const text = `前面${selectionTokenText(2)}后面`
    expect(segmentsFromText(text)).toEqual([
      { kind: 'text', text: '前面' },
      { kind: 'token', n: 2 },
      { kind: 'text', text: '后面' }
    ])
  })

  test('多 token：每 token 独立 token 段，文本段按出现位置切分', () => {
    const text = `将${selectionTokenText(1)}变成${selectionTokenText(2)}的风格`
    expect(segmentsFromText(text)).toEqual([
      { kind: 'text', text: '将' },
      { kind: 'token', n: 1 },
      { kind: 'text', text: '变成' },
      { kind: 'token', n: 2 },
      { kind: 'text', text: '的风格' }
    ])
  })

  test('连续两个 token 中间无文本 → 不产空文本段', () => {
    const text = `${selectionTokenText(1)}${selectionTokenText(2)}`
    expect(segmentsFromText(text)).toEqual([
      { kind: 'token', n: 1 },
      { kind: 'token', n: 2 }
    ])
  })

  test('半删残串不切，归到相邻文本段（与 scanSelectionTokens 同口径）', () => {
    expect(segmentsFromText('「@画布选区-1')).toEqual([{ kind: 'text', text: '「@画布选区-1' }])
    expect(segmentsFromText('@画布选区-1」')).toEqual([{ kind: 'text', text: '@画布选区-1」' }])
    expect(segmentsFromText(`残${selectionTokenText(1)}串`)).toEqual([
      { kind: 'text', text: '残' },
      { kind: 'token', n: 1 },
      { kind: 'text', text: '串' }
    ])
  })

  test('segmentsToText：token 段 → 字面 `「@画布选区-N」`', () => {
    expect(
      segmentsToText([
        { kind: 'text', text: '将' },
        { kind: 'token', n: 1 },
        { kind: 'text', text: '变成' },
        { kind: 'token', n: 2 },
        { kind: 'text', text: '的风格' }
      ])
    ).toBe(`将${selectionTokenText(1)}变成${selectionTokenText(2)}的风格`)
  })

  test('双向 roundtrip：从文本起经两个函数回到原文', () => {
    const cases = [
      '普通消息',
      '',
      `改一下${selectionTokenText(1)}的颜色`,
      `${selectionTokenText(1)}这里改一版`,
      `前面${selectionTokenText(2)}后面`,
      `将${selectionTokenText(1)}变成${selectionTokenText(2)}的风格`,
      `${selectionTokenText(1)}${selectionTokenText(2)}`,
      `首${selectionTokenText(1)}中${selectionTokenText(2)}末`
    ]
    for (const original of cases) {
      const segments = segmentsFromText(original)
      const restored = segmentsToText(segments)
      expect(restored).toBe(original)
    }
  })

  test('payload 逐字节等价：segmentsToText → serialize 与旧路径产出一致', () => {
    const draft = `将${selectionTokenText(1)}变成${selectionTokenText(2)}的风格`
    const segments = segmentsFromText(draft)
    // 段模型 → 字面串（与原 draft 字节等价）
    expect(segmentsToText(segments)).toBe(draft)
    // 序列化结果与旧路径完全一致
    const registry = makeRegistry([
      { n: 1, nodeIds: ['1:23'], names: ['主标题'], types: ['TEXT'] },
      { n: 2, nodeIds: ['4:56'], names: ['主视觉'], types: ['FRAME'] }
    ])
    const reader = fakeReader({
      '1:23': { name: '主标题', type: 'TEXT' },
      '4:56': { name: '主视觉', type: 'FRAME' }
    })
    const expected = serializeSelectionManifest(draft, registry, reader).text
    const actual = serializeSelectionManifest(segmentsToText(segments), registry, reader).text
    expect(actual).toBe(expected)
  })

  test('段模型 + removeSelectionToken 等价：从段里删 n 后还原文本与原路径字节等价', () => {
    const draft = `改一下${selectionTokenText(1)}和${selectionTokenText(2)}的颜色`
    const segments = segmentsFromText(draft)
    const filtered = segments.filter((s) => !(s.kind === 'token' && s.n === 1))
    const restored = segmentsToText(filtered)
    const expected = removeSelectionToken(draft, 1)
    expect(restored).toBe(expected)
  })
})
