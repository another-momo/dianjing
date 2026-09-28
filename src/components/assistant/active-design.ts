/**
 * 选择器 UI 重做的共享前端助手——
 *
 *  - 批 2（2026-09-21 拍板③）：`[新建意图确认 …]` 用户消息首行信封**生产侧整段退役**
 *    ——后端已废剥离通道，确认参数只走 POST /api/pi/intent-confirm；继续塞信封
 *    只会让协议文本原样进 prompt 与气泡。
 *  - 2026-09-27 state-layering wave-2（帧无身份 + 单槽退役）：set_active_design
 *    同意卡族（解析/端点客户端/决定归档 part/切换回执 part）与 setup_design
 *    awaiting 信封解析族（全史扫描/卡态派生）整体摘除——落点写通道 = 落点
 *    拦截门 + 规制确认门（确认端点直写 page-state），agent 无改址工具，
 *    setup_design 落点页建根帧为静默操作。
 *  - 2026-09-27 意图确认卡退役（发送即物化批）：新建意图确认卡归档 part
 *    （NEW_INTENT_PART_TYPE / NewIntentPartData）随卡摘除——chip 武装态在
 *    ChatPanel actuallySend 开头经 postIntentConfirm 直写 page-state，
 *    不拦截、不弹卡、不产生归档 part；postIntentConfirm 保留为写通道。
 *  - 面板读画布通路：makeFigmaFromStore seam（automation/bridge）+ core
 *    brief-edit 读写原语（设计区列表段随单槽退役摘除——不再消费
 *    scanMarketingDesigns）。
 */

import { ref } from 'vue'

import { computeAllLayouts } from '@open-pencil/core/layout'
import { walkSubtree } from '@open-pencil/core/tools/fork/marketing/active-design'
import {
  BRIEF_ESTIMATED_HEIGHT,
  BRIEF_WIDTH,
  addBriefMaterialEntry,
  createBrief,
  isBrief
} from '@open-pencil/core/tools/fork/marketing/brief'
import {
  readBrief,
  removeBriefMaterial,
  updateBriefContent,
  updateMaterialCaption
} from '@open-pencil/core/tools/fork/marketing/brief-edit'
import type { BriefView } from '@open-pencil/core/tools/fork/marketing/brief-edit'
import { findPlacementPosition } from '@open-pencil/core/tools/fork/placement'

import { makeFigmaFromStore } from '@/app/bridge/figma-factory'
import { getWindowId } from '@/app/bridge/window-id'
import type { EditorStore } from '@/app/editor/active-store'
import { ensureGraphFonts } from '@/app/editor/fonts'

// ── 意图写通道（发送即物化） ─────────────────────────────────────────────────

/** T91b：POST /api/pi/intent-confirm——直写 page-state 标量（确认即物化）。
 *  2026-09-27 意图确认卡退役：触发方由确认卡按钮改为 ChatPanel 发送即物化
 *  通路（chip 武装态发消息时先行直写，失败 fail-closed 不发送）。 */
export async function postIntentConfirm(args: {
  modeId: string
  profileId?: string
}): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // T98-路由：windowId 随确认直传——多窗时桥调用按发起窗路由
    const res = await fetch('/api/pi/intent-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...args, windowId: getWindowId() })
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null
    if (res.ok && body?.ok === true) return { ok: true }
    return { ok: false, message: body?.message ?? `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// ── 面板读画布通路 ───────────────────────────────────────────────────────────

export interface BriefListEntry {
  briefId: string
  name: string
  /** T79 S1 B：brief 内容预览（截取首 ~40 字符，含内容 placeholder 时为空） */
  contentPreview?: string
}

const BRIEF_CONTENT_PREVIEW_MAX = 40

/** 需求单列表段：只扫当前页（T65 决策 D4 从全文档收回，与单槽同页口径一致；
 *  面板文案明示「当前页面」。T66 trigger 计数同口径——本函数即面板列表口径，
 *  全文档级 scanDocumentBriefs 在当前仓不存在（grep 零命中），无需过滤。） */
export function scanCurrentPageBriefs(store: EditorStore): BriefListEntry[] {
  const graph = store.graph
  const page = graph.getNode(store.state.currentPageId)
  if (!page) return []
  const figma = makeFigmaFromStore(store)
  const briefs: BriefListEntry[] = []
  walkSubtree(graph, page.childIds, (node) => {
    if (isBrief(node)) {
      const view = readBrief(figma, node.id)
      const content = view?.content ?? ''
      const trimmed = content.trim()
      let contentPreview: string | undefined
      if (trimmed !== '') {
        contentPreview =
          trimmed.length > BRIEF_CONTENT_PREVIEW_MAX
            ? `${trimmed.slice(0, BRIEF_CONTENT_PREVIEW_MAX)}…`
            : trimmed
      }
      briefs.push({
        briefId: node.id,
        name: node.name,
        contentPreview
      })
    }
    // brief 内部递归无害（结构内不会再嵌 brief；扫描不递归下钻）
    return undefined
  })
  return briefs
}

// ── 排版结算 + undo 登记（T66 决策②根因修复） ────────────────────────────────

/**
 * brief 变更的统一收尾（旧分支 feature/agent-backend brief-panel.ts applyMutation
 * 四件套在当前 EditorStore 表面的等效）：快照 → core 原语变更 → computeAllLayouts
 * 排版结算 → requestRender → pushUndoEntry。
 *
 * 根因（T66-plan ②定谳）：桥直调 core 原语只改图，不结算布局——文字节点停在
 * 未测量态，auto-layout 折叠/叠块（T65 新建需求单排版错乱即此）。undo 通路沿
 * tool-handlers.ts withAIUndo 先例（snapshotPage/pushUndoEntry）；失败回滚 before
 * 快照，不留半变更 brief。
 *
 * 注意：PageSnapshot 只覆盖页面节点，不含 graph.images 字节——撤销 add-material
 * 移除条目节点，图像字节留在内容寻址缓存里（无害，与旧分支同律）。
 */
async function applyBriefMutation(
  store: EditorStore,
  label: string,
  mutate: (figma: ReturnType<typeof makeFigmaFromStore>) => boolean
): Promise<boolean> {
  const before = store.snapshotPage()
  try {
    const figma = makeFigmaFromStore(store)
    if (!mutate(figma)) {
      store.restorePageFromSnapshot(before)
      return false
    }
    // T79 B2：ensureGraphFonts 必须在 computeAllLayouts 前跑——CJK fallback
    // 加载后清空 textPicture 才能让后续排版结算拿到正确字宽（tool-handlers.ts
    // :191-194 桥端同范式：mutates 后先 ensureGraphFonts 再 computeAllLayouts）
    const pageNode = store.graph.getNode(store.state.currentPageId)
    if (pageNode) await ensureGraphFonts(store.graph, pageNode.childIds, store.renderer)
    computeAllLayouts(store.graph, store.state.currentPageId)
    store.requestRender()
    const after = store.snapshotPage()
    store.pushUndoEntry({
      label,
      forward: () => store.restorePageFromSnapshot(after),
      inverse: () => store.restorePageFromSnapshot(before)
    })
    return true
  } catch (error) {
    console.error('[brief] mutation failed, rolled back:', error)
    store.restorePageFromSnapshot(before)
    return false
  }
}

/**
 * 新建需求单（T65 决策 D1）：core create_brief 原语经桥直调——只建 brief 节点
 * 落画布（不触发 setup_design；AI 后续语言认领）。放置走共享 findPlacementPosition
 * （页面内容右侧 +100，同 create_brief 工具）；返回新 briefId 供列表重扫。
 *
 * T66：收尾补齐排版结算四件套（旧分支 createBriefInStore 蓝本）——
 * computeAllLayouts（当前页 scope）→ select → zoomToSelection 定位展示 →
 * requestRender → undo 登记「新建需求单」。此前缺结算，新建 brief 文字节点
 * 未测量、auto-layout 折叠/叠块。
 */
export async function createBriefOnPage(store: EditorStore, content: string): Promise<string> {
  const before = store.snapshotPage()
  const figma = makeFigmaFromStore(store)
  const position = findPlacementPosition(figma, {
    width: BRIEF_WIDTH,
    height: BRIEF_ESTIMATED_HEIGHT
  })
  const brief = createBrief(figma, position.x, position.y)
  // T79 B1：空内容也调用 updateBriefContent——core 内部把 ContentExample 占位文本
  // 清空，留出空态输入位（不写内容时保持 ContentExample 占位给用户看）
  updateBriefContent(figma, brief.id, content.trim())
  // T79 B2：同 applyBriefMutation 收尾，确保字体加载在排版结算之前
  const pageNode = store.graph.getNode(store.state.currentPageId)
  if (pageNode) await ensureGraphFonts(store.graph, pageNode.childIds, store.renderer)
  computeAllLayouts(store.graph, store.state.currentPageId)
  store.select([brief.id])
  store.zoomToSelection()
  store.requestRender()
  const after = store.snapshotPage()
  store.pushUndoEntry({
    label: '新建需求单',
    forward: () => store.restorePageFromSnapshot(after),
    inverse: () => store.restorePageFromSnapshot(before)
  })
  return brief.id
}

/** 详情编辑视图读模型（结构不完整 → null，面板显式提示） */
export function readBriefView(store: EditorStore, briefId: string): BriefView | null {
  return readBrief(makeFigmaFromStore(store), briefId)
}

/** 需求单内容写回（core updateBriefContent 直改画布文本节点 + 排版结算 + undo） */
export async function saveBriefContent(
  store: EditorStore,
  briefId: string,
  text: string
): Promise<boolean> {
  return applyBriefMutation(store, '编辑需求内容', (figma) =>
    updateBriefContent(figma, briefId, text)
  )
}

/** 素材条目标题写回（+ 排版结算 + undo） */
export async function saveMaterialCaption(
  store: EditorStore,
  entryId: string,
  caption: string
): Promise<boolean> {
  return applyBriefMutation(store, '编辑素材备注', (figma) =>
    updateMaterialCaption(figma, entryId, caption)
  )
}

// ── 素材四能力（T66 决策②，ChatBriefDialog；旧分支 apply* 蓝本） ─────────────

/**
 * 上传图片入库 + 挂为素材条目：字节直接交给 core addBriefMaterialEntry——
 * 内部 figma.createImage(bytes) 走 computeImageHash + graph.images.set
 * （figma-api/index.ts:524 内容寻址入库通路），无需调用方单独入库。
 * 返回新条目 entryId（失败 null）。
 */
export async function addBriefMaterialFromUpload(
  store: EditorStore,
  briefId: string,
  bytes: Uint8Array
): Promise<string | null> {
  let entryId: string | null = null
  await applyBriefMutation(store, '添加素材', (figma) => {
    const result = addBriefMaterialEntry(figma, briefId, bytes, '')
    if ('error' in result) return false
    entryId = result.entryId
    return true
  })
  return entryId
}

/** 选区图像节点扫描（旧分支 getSelectionImageNodes 等效）：携带 IMAGE fill 的节点 → {nodeId, hash} */
export function findSelectionImageNodes(
  store: EditorStore,
  ids?: Iterable<string>
): Array<{ nodeId: string; hash: string }> {
  const targets: Array<{ nodeId: string; hash: string }> = []
  for (const id of ids ?? store.state.selectedIds) {
    const fill = store.graph.getNode(id)?.fills.find((f) => f.type === 'IMAGE' && f.imageHash)
    if (fill?.type === 'IMAGE' && fill.imageHash) targets.push({ nodeId: id, hash: fill.imageHash })
  }
  return targets
}

/**
 * 选区图像批量挂为素材条目（一次 undo 事务），返回成功条数。
 * T66 简化裁决：当前仓无移动语义对应的原语编排需求——一律复制（保留画布原节点），
 * 不做旧分支的 move/copy 选择器（self-check 已记录偏差）。
 */
export async function addBriefMaterialsFromSelection(
  store: EditorStore,
  briefId: string
): Promise<number> {
  const targets = findSelectionImageNodes(store)
  if (targets.length === 0) return 0
  let added = 0
  await applyBriefMutation(store, '添加素材', (figma) => {
    for (const { hash } of targets) {
      const result = addBriefMaterialEntry(figma, briefId, { hash }, '')
      if (!('error' in result)) added++
    }
    return added > 0
  })
  return added
}

/** 素材条目删除（core removeBriefMaterial + 排版结算 + undo） */
export async function removeBriefMaterialEntry(
  store: EditorStore,
  entryId: string
): Promise<boolean> {
  return applyBriefMutation(store, '删除素材', (figma) => removeBriefMaterial(figma, entryId))
}

// ── 需求单大面板开关状态（T66 决策②；模块级 ref，settings/dialog.ts 先例） ──

export const briefDialogOpen = ref(false)
/** dialog 目标 brief（打开时由列表条目指定；dialog 零自有事实源，只存 id） */
export const briefDialogBriefId = ref<string | null>(null)

export function openBriefDialog(briefId: string): void {
  briefDialogBriefId.value = briefId
  briefDialogOpen.value = true
}

export function closeBriefDialog(): void {
  briefDialogOpen.value = false
}
