/**
 * T59（S3 §9 undo burst）：AI 回合撤销组边界信号 → 7600 桥 `undo_group` 指令。
 *
 * pi service 在每个 prompt run（= 一个 AI 回合）开始/结束各发一次 begin/end；
 * 桥侧据此开/关「AI 撤销组」，组内 mutating 工具调用按设计区 coalesce 合并
 * 撤销单元（桥侧实现见 automation/bridge/tool-handlers.ts 头注）。
 *
 * 纪律（T59-plan §1 定谳）：
 *  - 失败不阻断主流程：桥不可达/无 discovery/非 2xx 一律 warn 后吞掉
 *  - 悬挂组失效安全在桥侧（下个 begin 覆盖、非组编辑截断合并链），
 *    本侧 end 丢失不留后遗症
 *  - 不经 pi-backend/tools.ts（T54 装配冻结面）；链路复用同一 /rpc HTTP 面
 *
 * T98-路由：windowId 透传——begin/end 同窗打开/关闭撤销组，避免多窗时 A 窗
 * 的撤销组被 B 窗的 begin 覆盖。
 *
 * 仅运行于独立后端进程；token 只经 discovery 文件读取，不打印、不落盘他处。
 */

import { readDiscoveryFile } from '@/app/bridge/server/discovery'

import { postBridgeRPC } from './bridge-rpc'

export type UndoGroupAction = 'begin' | 'end'

export async function sendUndoGroupSignal(
  action: UndoGroupAction,
  documentId?: string,
  windowId?: string
): Promise<void> {
  try {
    const discovery = await readDiscoveryFile()
    if (!discovery) return
    const args = documentId ? { action, document_id: documentId } : { action }
    const res = await postBridgeRPC(discovery, 'undo_group', args, windowId)
    // T98：桥对工具执行错误改回 200 {ok:false,error}（502 严格保留给编辑器
    // 不可达）——成败判定须看 body.ok，不再只看 HTTP 状态
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
    if (!res.ok || body?.ok === false) {
      console.warn(
        `[pi-backend] undo_group ${action} 信号失败：HTTP ${res.status}（忽略，不阻断主流程）`
      )
    }
  } catch (error) {
    console.warn(
      `[pi-backend] undo_group ${action} 信号发送失败（忽略，不阻断主流程）：` +
        (error instanceof Error ? error.message : String(error))
    )
  }
}
