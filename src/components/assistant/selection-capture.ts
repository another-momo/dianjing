/**
 * T70：画布选区采集——内联 token「@画布选区-N」的文本模型纯函数面
 * （T70-plan §1.2/§1.3/§1.4 定稿）。
 *
 *  - 占位串契约：token 在文本模型里是字面串 `「@画布选区-N」`（含中文角括号——
 *    与正文混排时的原子边界；overlay backdrop 把它渲染成高亮块，载体是路线 A =
 *    高亮 textarea，不引入 contenteditable）。N = 当前草稿内采集序号（从 1 递增，
 *    发送成功后归 1），序号作用域 = 草稿，与消息尾清单同生命周期。
 *  - 旁挂草稿期 token 登记表（Map N → {pageId, nodeIds, 名称/类型快照}）：
 *    快照服务 tooltip 与「已删除」标注；清单节点的名称/类型以**发送瞬间**的
 *    graph 状态为准（采集后改名/删除如实反映）。
 *  - 一致性纪律：清单以提交时**文本流实扫**到的占位串为准——用户手删占位串 =
 *    token 失效（登记表残留条目不进清单）；手打无登记占位串 → 清单行标
 *    「未采集的引用」（诚实告知 agent，不假装有节点）。
 *  - 消息尾清单格式（§1.4，追加在用户文本之后、空行分隔，与 longform-hero-kv-first `[画布选区]`
 *    纪律同前缀）：
 *
 *      [画布选区]
 *      @画布选区-1 = 节点 1:23「主标题」(TEXT)
 *      @画布选区-2 = 节点 4:56「主视觉」(FRAME) + 节点 4:57「装饰」(VECTOR)
 *
 *  - T27 回填：提交失败时父级把**含清单**的提交文本原样喂回 restoreDraft——
 *    stripSelectionManifest 负责剥掉尾部清单还原草稿文本（登记表快照由
 *    ChatInput 侧持有/恢复）。
 *
 * 读选区先例：active-design.ts findSelectionImageNodes（store.state.selectedIds +
 * graph.getNode）——本文件采集广义节点（不限 IMAGE fill），读取面相同但独立成
 * 文件（active-design 已是 400+ 行大文件，T70-plan §2 定稿）。
 */

import type { EditorStore } from '@/app/editor/active-store'

// ── 占位串契约 ───────────────────────────────────────────────────────────────

/** 占位串字面量：`「@画布选区-N」`（角括号是字面量的一部分，混排原子边界） */
const TOKEN_PATTERN_SOURCE = '「@画布选区-(\\d+)」'

/** 全局扫描用（matchAll 要求 g flag；每次新建实例避免 lastIndex 串扰） */
const TOKEN_PATTERN_GLOBAL = new RegExp(TOKEN_PATTERN_SOURCE, 'g')

/** 清单头字面量——选区清单的序列化契约：前端以此前缀产出清单块，prompt 侧按此前缀识别（改动需与 prompt 资产同步） */
export const SELECTION_MANIFEST_HEADER = '[画布选区]'

/** 生成占位串字面量 */
export function selectionTokenText(n: number): string {
  return `「@画布选区-${n}」`
}

// ── token 登记表 ─────────────────────────────────────────────────────────────

/** 采集瞬间的节点快照（名称/类型——tooltip 与「已删除」标注用） */
export interface SelectionTokenNodeSnapshot {
  nodeId: string
  name: string
  type: string
}

export interface SelectionTokenEntry {
  /** 草稿期序号（从 1 递增；发送后归 1） */
  n: number
  pageId: string
  nodeIds: string[]
  snapshot: SelectionTokenNodeSnapshot[]
}

export type SelectionTokenRegistry = Map<number, SelectionTokenEntry>

/**
 * 最小节点读取面（store.graph 结构满足）——纯函数测试用假 reader，
 * 组件侧直传 store.graph（结构型匹配，同 findSelectionImageNodes 读图面）。
 */
export interface SelectionNodeReader {
  getNode(id: string): { name: string; type: string } | undefined
}

// ── 采集 ─────────────────────────────────────────────────────────────────────

/**
 * 采集当前选区为一条 token 条目；空选区（或选中 id 全部已不在图里）→ null
 * （调用方据此给轻提示，不产生 token）。
 */
export function captureSelection(
  source: { pageId: string; selectedIds: Iterable<string> },
  reader: SelectionNodeReader,
  n: number
): SelectionTokenEntry | null {
  const nodeIds: string[] = []
  const snapshot: SelectionTokenNodeSnapshot[] = []
  for (const id of source.selectedIds) {
    const node = reader.getNode(id)
    if (!node) continue
    nodeIds.push(id)
    snapshot.push({ nodeId: id, name: node.name, type: node.type })
  }
  if (nodeIds.length === 0) return null
  return { n, pageId: source.pageId, nodeIds, snapshot }
}

/** EditorStore 适配（当前页 selectedIds；同 findSelectionImageNodes 读图面） */
export function captureSelectionFromStore(
  store: EditorStore,
  n: number
): SelectionTokenEntry | null {
  return captureSelection(
    { pageId: store.state.currentPageId, selectedIds: store.state.selectedIds },
    store.graph,
    n
  )
}

// ── 草稿期 token 状态（登记表 + 序号；T27 快照/恢复） ────────────────────────

/**
 * 草稿期 token 状态：登记表 + 单调递增序号（作用域 = 当前草稿）。
 * 刻意做成纯数据 + 纯函数（不走响应式）：组件渲染只依赖文本实扫，
 * 状态仅在采集/提交/回填时读写；序号重置/快照往返因此可单测钉扎。
 */
export interface SelectionDraftState {
  registry: SelectionTokenRegistry
  /** 下一个采集序号（从 1 起；发送成功/清空草稿后归 1） */
  nextSeq: number
}

export function createSelectionDraftState(): SelectionDraftState {
  return { registry: new Map(), nextSeq: 1 }
}

/** 发送成功/清空草稿：登记表清空 + 序号归 1（T70-plan §1.2 序号生命周期） */
export function resetSelectionDraftState(state: SelectionDraftState): void {
  state.registry.clear()
  state.nextSeq = 1
}

/** T27 提交前快照（深拷贝——提交后 state 即被 reset，快照独立存活） */
export function snapshotSelectionDraftState(state: SelectionDraftState): SelectionDraftState {
  const registry: SelectionTokenRegistry = new Map()
  for (const [n, entry] of state.registry) {
    registry.set(n, {
      n: entry.n,
      pageId: entry.pageId,
      nodeIds: [...entry.nodeIds],
      snapshot: entry.snapshot.map((node) => ({ ...node }))
    })
  }
  return { registry, nextSeq: state.nextSeq }
}

/** T27 失败回填：快照整体写回 state（调用方保证文本已先回填——占位串与
 *  登记表重新对上） */
export function restoreSelectionDraftState(
  state: SelectionDraftState,
  snapshot: SelectionDraftState
): void {
  state.registry.clear()
  for (const [n, entry] of snapshot.registry) state.registry.set(n, entry)
  state.nextSeq = snapshot.nextSeq
}

// ── 文本流扫描（backdrop 高亮分段 + 提交实扫共用） ───────────────────────────

export interface ScannedSelectionToken {
  n: number
  start: number
  end: number
}

/** 文本流内全部完整占位串（按出现顺序；半删的残串不识别） */
export function scanSelectionTokens(text: string): ScannedSelectionToken[] {
  const tokens: ScannedSelectionToken[] = []
  for (const match of text.matchAll(TOKEN_PATTERN_GLOBAL)) {
    tokens.push({
      n: Number(match[1]),
      start: match.index,
      end: match.index + match[0].length
    })
  }
  return tokens
}

/**
 * 按 n 删除文本中所有该序号对应的占位串（全部出现位置；不区分首末）。
 *
 * 用法：缩略图 chip 上的 X 按钮——视觉代理消失 = 文本里占位串同步删掉。
 * 不主动清理占位串前后的空白：相邻内容若是用户有意留的标点/空格，原样保留，
 * 仅去掉 token 字面。占位串之外的内容（含其他 token）完全不动。
 *
 * payload 语义不变：提交时 serializeSelectionManifest 还是按文本流实扫——少一个
 * 占位串就少一条清单行，等价于用户手删了占位串（本来就走的这条路径）。
 */
export function removeSelectionToken(text: string, n: number): string {
  const pattern = new RegExp(TOKEN_PATTERN_SOURCE, 'g')
  return text.replace(pattern, (match, captured) => (Number(captured) === n ? '' : match))
}

// ── T89：Skill 内联 token（`「/skill:<name>」`）── 已退役（T91p）────────────
//
// T89 的文本内 skill token（backdrop 高亮范式）在 T91p 被 chip 化取代：
// owner 决议 skill 是命令不是引用——恒钉消息最前、单例、新选覆盖旧选，
// 且文本态 token 可被光标进入逐字编辑观感怪异。新机制见
// src/components/assistant/skill-chip.ts（compose/extract 纯函数）+ ChatInput
// pinnedSkill 覆盖层。本文件不再承载任何 skill token 逻辑。

// ── 分段模型（contenteditable 内嵌 chip 的双向桥） ───────────────────────────
//
// 路线 A（textarea + backdrop 对齐层）退役后，输入控件改为 contenteditable
// div + 分段模型。模型 = 有序段数组：纯文本段 | 选区 token 段（含 n 序号）；
// token 段在 contenteditable DOM 里渲染为 contenteditable="false" 的原子
// chip 元素，**不进可编辑文本流**——chip 是 DOM 节点不是字符。但线上 payload
// 必须与现状逐字节一致：序列化时 token 段 → 字面 `「@画布选区-N」`，再走
// 既有 serializeSelectionManifest 路径。所以这里提供两条纯函数：
//   1. segmentsFromText(text)：文本串 → 分段数组（用 scanSelectionTokens 切
//      「@画布选区-N」字面，剩余为文本段；半删残串归到相邻文本段）。
//   2. segmentsToText(segments)：分段数组 → 文本串（token 段 → 字面）。
// 双向 roundtrip 是测试钉扎重点——保证内嵌 chip UI 与旧 textarea 路径产出
// 完全一致的序列化结果。

/** 分段模型：有序段，文本段或 token 段（二选一） */
export type InputSegment = { kind: 'text'; text: string } | { kind: 'token'; n: number }

/** 文本串 → 分段数组。半删残串（非完整 `「@画布选区-N」`）不切，归并到
 *  相邻文本段里；这与 scanSelectionTokens 的「只识别完整占位串」一致——
 *  切 chip 时只切完整 token，残串一律当普通文本。 */
export function segmentsFromText(text: string): InputSegment[] {
  const segments: InputSegment[] = []
  const tokens = scanSelectionTokens(text)
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, token.start) })
    }
    segments.push({ kind: 'token', n: token.n })
    cursor = token.end
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }
  return segments
}

/** 分段数组 → 文本串（token 段 → `「@画布选区-N」`）。空文本段不输出，
 *  连续文本段自然合并——segmentsFromText 已经是这个形状，反向也无损。 */
export function segmentsToText(segments: InputSegment[]): string {
  let out = ''
  for (const seg of segments) {
    if (seg.kind === 'text') {
      out += seg.text
    } else {
      out += selectionTokenText(seg.n)
    }
  }
  return out
}

// ── 原子删除区间（路线 A keydown 拦截） ─────────────────────────────────────

/**
 * 光标紧邻完整占位串时的整段删除区间：
 *  - backward（Backspace）：光标紧随占位串尾 → [tokenStart, cursor)
 *  - forward（Delete）：光标紧贴占位串头 → [cursor, tokenEnd)
 * 光标落在占位串中间/不紧邻 → null（走默认逐字删除——用户手删占位串即
 * token 失效纪律的一部分）。
 */
export function atomicTokenDeletionRange(
  text: string,
  cursor: number,
  direction: 'backward' | 'forward'
): { start: number; end: number } | null {
  if (direction === 'backward') {
    const match = new RegExp(`${TOKEN_PATTERN_SOURCE}$`).exec(text.slice(0, cursor))
    if (!match) return null
    return { start: cursor - match[0].length, end: cursor }
  }
  const match = new RegExp(`^${TOKEN_PATTERN_SOURCE}`).exec(text.slice(cursor))
  if (!match) return null
  return { start: cursor, end: cursor + match[0].length }
}

// ── 提交序列化（消息尾清单） ────────────────────────────────────────────────

export interface SerializedSelectionSubmission {
  /** 提交文本（有 token 时尾部追加 [画布选区] 清单；无 token = 原文） */
  text: string
  /** 文本流实扫到的 token 序号（首现序去重） */
  referencedNs: number[]
  /** 无登记表条目的序号（清单行已标「未采集的引用」） */
  uncollectedNs: number[]
}

/** 节点名防御：换行会破坏清单行结构（一行一节点），压平为空格 */
function manifestSafeName(name: string): string {
  return name.replace(/\s*\n\s*/g, ' ')
}

/**
 * 提交文本序列化：文本流实扫占位串 → 尾部追加清单。
 * 节点名称/类型以调用瞬间的 reader（= graph 实况）为准；已删节点用采集快照
 * 名称 + 「(已删除)」标注；无登记条目 → 「未采集的引用」。登记表里未被文本
 * 引用的条目直接丢弃（不进清单）。
 */
export function serializeSelectionManifest(
  text: string,
  registry: SelectionTokenRegistry,
  reader: SelectionNodeReader
): SerializedSelectionSubmission {
  const referencedNs: number[] = []
  for (const token of scanSelectionTokens(text)) {
    if (!referencedNs.includes(token.n)) referencedNs.push(token.n)
  }
  if (referencedNs.length === 0) return { text, referencedNs, uncollectedNs: [] }

  const lines: string[] = []
  const uncollectedNs: number[] = []
  for (const n of referencedNs) {
    const entry = registry.get(n)
    if (!entry) {
      uncollectedNs.push(n)
      lines.push(`@画布选区-${n} = 未采集的引用`)
      continue
    }
    const parts: string[] = []
    for (let i = 0; i < entry.nodeIds.length; i++) {
      const nodeId = entry.nodeIds[i]
      const live = reader.getNode(nodeId)
      if (live) {
        parts.push(`节点 ${nodeId}「${manifestSafeName(live.name)}」(${live.type})`)
      } else {
        const snapshotName = entry.snapshot[i]?.name
        const label = snapshotName ? `「${manifestSafeName(snapshotName)}」` : ''
        parts.push(`节点 ${nodeId}${label}(已删除)`)
      }
    }
    lines.push(`@画布选区-${n} = ${parts.join(' + ')}`)
  }
  return {
    text: `${text}\n\n${SELECTION_MANIFEST_HEADER}\n${lines.join('\n')}`,
    referencedNs,
    uncollectedNs
  }
}

// ── T27 回填：剥掉尾部清单 ──────────────────────────────────────────────────

/**
 * 提交文本尾部清单的精确形态（空行分隔 + 头 + 每行 `@画布选区-N = …`）——
 * 只剥我们自己拼上去的尾巴；手打的相似文本没有「空行 + 全格式行」结构时不动。
 */
const MANIFEST_TAIL_PATTERN = /\n\n\[画布选区\]\n(?:@画布选区-\d+ = [^\n]*(?:\n|$))+$/

/**
 * restoreDraft 用：父级回填的是含清单的提交文本，剥掉尾部清单还原草稿
 * （占位串本体留在文本里，与恢复的登记表重新对上）。剥完为空 = 文本本体
 * 就是清单（手打），不动原文。
 */
export function stripSelectionManifest(text: string): string {
  const match = MANIFEST_TAIL_PATTERN.exec(text)
  if (!match) return text
  const stripped = text.slice(0, match.index)
  return stripped.trim() === '' ? text : stripped
}
