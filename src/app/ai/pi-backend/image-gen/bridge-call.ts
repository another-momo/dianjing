/**
 * T54（Phase 3 W2/T-B3）：generate_image 后端编排的桥调用助手。
 *
 * 与 pi-backend/tools.ts callBridgeTool 同语义（discovery 读取 → POST /rpc →
 * {ok,result}/{ok:false,error}，连接失败/401 单次重读 discovery 重试），两点差异：
 *  1. 显式 fetch 超时：桥 RPC 超时（automation/bridge/server/browser-rpc.ts，
 *     DIANJING_RPC_TIMEOUT_MS，缺省 300s）+ 60s 余量——生图链路 240s 级，
 *     裸 fetch 无超时会无限悬挂（tools.ts 既有段不在本任务改动面，集成期可
 *     归并共用，见 T54 报告）
 *  2. 独立模块：tools.ts 的 callBridgeTool 为私有且该文件属集成期接线面，
 *     本任务不改。
 *
 * key 卫生：本模块只搬运工具参数（图像字节 base64 / 节点 id / 尺寸），
 * 凭证永不进桥 payload（红线）。
 */

import { readDiscoveryFile } from '@/app/bridge/server/discovery'
import { DEFAULT_RPC_TIMEOUT_MS, readRPCTimeoutMs } from '@/app/orchestration/env'

import { classifyBridgeFailure, EDITOR_UNREACHABLE_MESSAGE } from '../bridge-errors'
import type { ToolTargetSource } from '../tools'

/** 桥 RPC 缺省超时本地副本（与 automation/bridge/server/browser-rpc.ts DEFAULT_RPC_TIMEOUT_MS
 * 保持一致，tests/engine/rebuild/image-gen/rpc-timeout.test.ts 钉扎两者一致） */
export const BRIDGE_RPC_DEFAULT_TIMEOUT_MS = DEFAULT_RPC_TIMEOUT_MS
/** fetch 在桥 RPC 超时之上再加的余量（桥内超时先触发并回 502，fetch 兜底防悬挂） */
export const BRIDGE_FETCH_MARGIN_MS = 60_000

export function bridgeCallTimeoutMs(): number {
  return readRPCTimeoutMs(BRIDGE_RPC_DEFAULT_TIMEOUT_MS) + BRIDGE_FETCH_MARGIN_MS
}

export type BridgeCallResult = Record<string, unknown>

/** 当次请求的桥目标袋——形随 tools.ts ToolTargetSource（T98-路由起加 windowId），
 *  type-shapes 门禁禁同形重复对象类型，故别名复用而非另立字面量 */
export type BridgeCallTarget = ToolTargetSource

export type BridgeCaller = (
  toolName: string,
  toolArgs: Record<string, unknown>,
  target?: BridgeCallTarget
) => Promise<BridgeCallResult>

type BridgeAttempt =
  | { ok: true; result: BridgeCallResult }
  | { ok: false; retryable: boolean; message: string }

async function attemptBridgeCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
  target?: BridgeCallTarget
): Promise<BridgeAttempt> {
  const discovery = await readDiscoveryFile()
  if (!discovery) {
    // T98：模型可见文案与 tools.ts 同缝（连接级统一英文文案）；内部细节
    // （discovery/端口/桥措辞）只进后端日志，不外露（T66/T81）
    console.warn('[image-gen] 桥 discovery 文件不存在或已过期（dev server 未启动？）')
    return { ok: false, retryable: false, message: EDITOR_UNREACHABLE_MESSAGE }
  }

  // documentId 注入桥 args 外层 document_id（同 tools.ts T22 D4 语义；
  // 缺省落当前活动 tab）
  const documentId = target?.documentId
  const args = documentId ? { ...toolArgs, document_id: documentId } : toolArgs

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (discovery.authToken) headers.authorization = `Bearer ${discovery.authToken}`
  const endpoint = `http://127.0.0.1:${discovery.httpPort}/rpc`
  // T98-路由：windowId 放 body 顶层（与 tools.ts 同缝）——桥按发起窗路由，
  // 多窗时生图落图不串窗（owner 实测错窗事故的现场路径即本助手）
  const windowId = target?.windowId
  const payload: Record<string, unknown> = { command: 'tool', args: { name: toolName, args } }
  if (windowId) payload.windowId = windowId

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(bridgeCallTimeoutMs())
    })
  } catch (error) {
    // 单次重试覆盖「桥在两次调用间重启、端口/token 漂移」窗口（重读 discovery）
    console.warn(
      `[image-gen] 桥连接失败：${error instanceof Error ? error.message : String(error)}`
    )
    return { ok: false, retryable: true, message: EDITOR_UNREACHABLE_MESSAGE }
  }

  const body = (await response.json().catch(() => null)) as {
    ok?: boolean
    result?: BridgeCallResult
    error?: string
  } | null

  if (response.status === 401) {
    // 401 唯一可恢复场景 = 桥重启换 token（重读 discovery 后再试一次）
    console.warn('[image-gen] 桥鉴权 401：discovery token 与运行中实例不匹配（重启 dev server）')
    return { ok: false, retryable: true, message: EDITOR_UNREACHABLE_MESSAGE }
  }
  if (!response.ok || body?.ok !== true) {
    // T98 判别缝（与 tools.ts 同缝）：2xx + ok:false = 编辑器在线、工具自身
    // 抛错 → 透传清洗后的工具 message；502 等其余 = 编辑器不可达 → 连接级
    // 统一文案。旧实现把工具错误也附上「确认浏览器已打开 app」，误导排查。
    const failure = classifyBridgeFailure(response.status, body, toolName)
    if (failure.kind === 'editor-unreachable') {
      console.warn(
        `[image-gen] 桥调用连接级失败：HTTP ${response.status}（${body?.error ?? '无错误详情'}）`
      )
    }
    return { ok: false, retryable: false, message: failure.message }
  }
  return { ok: true, result: body.result ?? {} }
}

export function createBridgeCaller(): BridgeCaller {
  return async (toolName, toolArgs, target) => {
    // 最多两次尝试：retryable（连接失败/401）时第二轮重读 discovery
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await attemptBridgeCall(toolName, toolArgs, target)
      if (outcome.ok) return outcome.result
      if (!outcome.retryable || attempt === 1) throw new Error(outcome.message)
    }
    throw new Error('unreachable')
  }
}
