/**
 * T22 session↔file 绑定（方案定稿 2026-08-23，docs/archive/rebuild-campaign/tasks/T22-plan.md §1.2）：
 *
 *  - 文档身份：docUuid 惰性铸造进根节点 sharedPluginData
 *    （{pluginId:'openpencil.ai', key:'openpencil.ai/docId'}，与
 *    packages/core/src/figma-api/plugin-data.ts:68-82 setSharedPluginData 同语义——
 *    该 helper 未出 core barrel，这里直接操作 pluginData 数组）。
 *    副作用已 recon 实证（T22-self-check §2.5-12/13）：不进 undo 栈；触发
 *    sceneVersion++ → autosave/recovery 顺带把 docId 持久化进 .fig（往返闭环
 *    对本地文件与云文档同一条 exportFigFile 管线成立）。
 *  - sessionId 三段式：`doc-<sha1(docUuid)>-<yyyyMMddTHHmmssZ>`。哈希前缀 =
 *    文件会话族谱身份；时间戳后缀 = 族内第 N 会话（clear 上下文 = 铸新后缀，
 *    旧会话在后端 index.json 归档保留）。
 *  - 历史回填：loadPiChatHistory 在 Chat 创建且本地无消息时被 transports.ts
 *    调用，采用后端解析出的族内最新 sessionId。
 *
 * 铸造时机 = 首次发送（getPiRequestContext），**不是** Chat 创建时：
 * import 元数据应用（packages/core/src/kiwi/fig/import.ts:50-60）会整体重写
 * 根节点 pluginData 数组——加载窗口内铸造的 docId 会被后到的导入冲掉
 * （T22 实施实测）。因此历史回填路径只读不铸；前缀也不按 store 缓存，
 * 每次发送读当时根节点，躲开图替换/导入覆盖的时序窗。
 *
 * 会话缓存为 per-store WeakMap（运行期语义，与旧 ToolLoop 的 currentChatMessages
 * 同生命周期）；持久化事实源 = 后端 index.json 前缀族谱。
 */

import type { UIMessage } from 'ai'

import type { EditorStore } from '@/app/editor/active-store'

import type { PiSessionSummary } from './session/summary'

/** T23 族谱清单条目：单一事实源在 ./session/summary（type-only，构建期擦除） */
export type { PiSessionSummary }

const PI_DOC_NAMESPACE = 'openpencil.ai'
const PI_DOC_ID_KEY = 'docId'
const PI_DOC_ENTRY_KEY = `${PI_DOC_NAMESPACE}/${PI_DOC_ID_KEY}`

const storeSessions = new WeakMap<EditorStore, string>()

export type PiRequestContext = {
  sessionId: string
  documentId?: string
  // T61：chatMode/pickedProfileId 出列（T24 链退役）——模式身份由宿主按
  // active_design 单槽读穿（T60），不再随请求走
}

function findDocIdEntry(store: EditorStore): string | null {
  const root = store.graph.getNode(store.graph.rootId)
  return (
    root?.pluginData.find(
      (entry) => entry.pluginId === PI_DOC_NAMESPACE && entry.key === PI_DOC_ENTRY_KEY
    )?.value ?? null
  )
}

/** 读/铸文档 UUID（无则铸入根节点 pluginData，随下次 autosave/保存落盘） */
export function ensurePiDocUuid(store: EditorStore): string {
  const existing = findDocIdEntry(store)
  if (existing) return existing

  const uuid = crypto.randomUUID()
  const root = store.graph.getNode(store.graph.rootId)
  store.graph.updateNode(store.graph.rootId, {
    pluginData: [
      ...(root?.pluginData ?? []).filter(
        (entry) => !(entry.pluginId === PI_DOC_NAMESPACE && entry.key === PI_DOC_ENTRY_KEY)
      ),
      { pluginId: PI_DOC_NAMESPACE, key: PI_DOC_ENTRY_KEY, value: uuid }
    ]
  })
  return uuid
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 文件会话族谱前缀（读当时根节点，不按 store 缓存——见模块头注释） */
export async function getPiDocKeyPrefix(store: EditorStore): Promise<string> {
  return `doc-${await sha1Hex(ensurePiDocUuid(store))}`
}

/** UTC 时间戳后缀，定长字典序可排（20260823T123045Z） */
function sessionTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

/** 铸新会话（clear 上下文 / 族内无历史时的首条） */
export async function mintPiSessionId(store: EditorStore): Promise<string> {
  const sessionId = `${await getPiDocKeyPrefix(store)}-${sessionTimestamp()}`
  storeSessions.set(store, sessionId)
  return sessionId
}

/** 当前会话 id：缓存命中且前缀仍匹配当前 docId 即用，否则铸新（自愈：
 * 导入覆盖窗口丢 docId 后重铸 uuid → 前缀漂移 → 缓存放逐、开新会话族） */
export async function resolvePiSessionId(store: EditorStore): Promise<string> {
  const prefix = await getPiDocKeyPrefix(store)
  const cached = storeSessions.get(store)
  if (cached?.startsWith(`${prefix}-`)) return cached
  const sessionId = `${prefix}-${sessionTimestamp()}`
  storeSessions.set(store, sessionId)
  return sessionId
}

/**
 * 历史回填：后端按 docKey 前缀解析族内最新会话。命中则采用其 sessionId 并
 * 返回消息（空数组视为无历史）；未命中/出错返回 undefined（前端按全新会话处理）。
 * 文档尚无 docId（从未 AI 交互过）时直接 undefined——不铸造（防导入覆盖窗口）。
 * 本地已铸同前缀会话（clear 上下文后的新后缀）时同样 undefined——否则空态重取
 * 会把刚清掉的族内旧会话复活、并冲掉新铸的 sessionId（A6）。
 */
export async function loadPiChatHistory(store: EditorStore): Promise<UIMessage[] | undefined> {
  try {
    const uuid = findDocIdEntry(store)
    if (!uuid) return undefined
    const prefix = `doc-${await sha1Hex(uuid)}`
    if (storeSessions.get(store)?.startsWith(`${prefix}-`)) return undefined
    const res = await fetch(`/api/pi/history?docKey=${encodeURIComponent(prefix)}`)
    if (!res.ok) return undefined
    const body = (await res.json()) as {
      sessionId: string | null
      messages: UIMessage[]
    }
    if (!body.sessionId || body.messages.length === 0) return undefined
    storeSessions.set(store, body.sessionId)
    return body.messages
  } catch {
    return undefined
  }
}

/**
 * 每次发送时解析请求上下文：sessionId 取当前会话（无则此时铸造 docId +
 * 铸新会话——发送时刻图已稳定）；documentId 取当前活动 tab.id（运行期值
 * 随发随取，T22-plan D4；动态 import 避免 tabs ↔ ai 环依赖）。
 * T61：chatMode/pickedProfileId 消费删除（T24 链退役）。
 */
export async function getPiRequestContext(store: EditorStore): Promise<PiRequestContext> {
  const sessionId = await resolvePiSessionId(store)
  try {
    const { getActiveTabId } = await import('@/app/tabs')
    return { sessionId, documentId: getActiveTabId() }
  } catch {
    return { sessionId }
  }
}

/** T23：当前文档是否已有 docId（只读）——会话栏可用态判定 */
export function hasPiDocId(store: EditorStore): boolean {
  return findDocIdEntry(store) !== null
}

/**
 * T23：当前文档族谱清单（只读）。无 docId（从未 AI 交互）返回 undefined——
 * 不铸造不发请求（同 loadPiChatHistory 纪律）；后端失败同样 undefined。
 */
export async function listPiSessionFamily(
  store: EditorStore
): Promise<PiSessionSummary[] | undefined> {
  try {
    const uuid = findDocIdEntry(store)
    if (!uuid) return undefined
    const prefix = `doc-${await sha1Hex(uuid)}`
    const res = await fetch(`/api/pi/sessions?docKey=${encodeURIComponent(prefix)}`)
    if (!res.ok) return undefined
    const body = (await res.json()) as { sessions: PiSessionSummary[] }
    return body.sessions
  } catch {
    return undefined
  }
}

/** T23：当前已采用的 sessionId（未有过会话/未回填命中时 null） */
export function getPiCurrentSessionId(store: EditorStore): string | null {
  return storeSessions.get(store) ?? null
}

/**
 * T23：切换到族内指定会话——精确读历史并采用其 sessionId（后续发送续写
 * 该会话）。sessionId 不属于当前文档族谱时拒绝（防跨族采用）。返回消息
 * （可为空数组）；校验/网络失败返回 null。
 */
export async function switchPiSession(
  store: EditorStore,
  sessionId: string
): Promise<UIMessage[] | null> {
  try {
    const uuid = findDocIdEntry(store)
    if (!uuid) return null
    const prefix = `doc-${await sha1Hex(uuid)}`
    if (!sessionId.startsWith(`${prefix}-`)) return null
    const res = await fetch(`/api/pi/history?sessionId=${encodeURIComponent(sessionId)}`)
    if (!res.ok) return null
    const body = (await res.json()) as { sessionId: string | null; messages: UIMessage[] }
    if (body.sessionId !== sessionId) return null
    storeSessions.set(store, sessionId)
    return body.messages
  } catch {
    return null
  }
}
