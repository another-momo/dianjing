/**
 * T19 选路接线：把 Chat 的 transport 切到 pi 后端；T25 D3 门退役后恒注册
 * （pi 已是唯一路径——旧 ToolLoop/harness 分支已切除）。
 *
 * 走既有 override 钩子（browser-bridge.ts exposeChatTransportOverride，与 e2e
 * mock 注入同一条管道），因此 transports.ts / use.ts / ChatPanel.vue 零改动。
 * 副作用顺序：本模块显式 import '@/app/ai/fork/use'，保证 window.openPencil
 * .setChatTransport 已暴露后再注册工厂。
 *
 * T22：sessionId 不再按浏览器 tab 固定——工厂收到 Chat 所属 EditorStore，
 * transport 每次发送经 getPiRequestContext 动态解析「文档会话族谱当前会话 +
 * 当前活动 tab documentId」（document-key.ts，T22-plan D1/D2/D4）。
 */

import { hasWindowGlobal } from '@open-pencil/core/constants'

import '@/app/ai/fork/use'
import { getPiDesignModelSpec } from '@/app/ai/pi-backend/assignment'
import { getPiRequestContext } from '@/app/ai/pi-backend/document-key'
import { PiBackendChatTransport } from '@/app/ai/pi-backend/transport'

export function attachPiBackendTransport(): void {
  if (!hasWindowGlobal()) return

  const setChatTransport = window.openPencil?.setChatTransport
  if (!setChatTransport) {
    throw new Error('pi-backend: window.openPencil.setChatTransport hook unavailable')
  }

  // T21：design 模型指派（设置页 PiModelsPanel 维护）随每次发送传给后端
  setChatTransport(
    (store) => new PiBackendChatTransport(() => getPiRequestContext(store), getPiDesignModelSpec)
  )
}
