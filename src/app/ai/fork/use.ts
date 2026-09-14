// Batch 2a 路径分离（2026-09-05）：本文件自 src/app/ai/chat/use.ts 迁入 owned
// 路径 src/app/ai/fork/，原上游路径留给 deletedPaths 落账——pi 单路径后 chat
// 入口已实质重写，与上游同名文件不再存在合并语义。
import { ref } from 'vue'

import { hasWindowGlobal } from '@open-pencil/core/constants'

import { loadPiChatHistory, mintPiSessionId } from '@/app/ai/pi-backend/document-key'
import { exposeChatTransportOverride } from '@/app/browser-bridge'
import { getActiveEditorStore } from '@/app/editor/active-store'

import { createChatSessionManager } from './transports'

/**
 * T25：pi 单路径后的 chat 入口——会话钩子恒挂（T22 D2/D3），模型/凭证旧面
 * 已切除。Batch 2a 路径分离：stock-photo key 与 remember 开关不再经此处
 * re-export——设置 UI 直取源头 owned 文件 @/app/settings/credentials/stock-photo-keys。
 */
const activeTab = ref<'design' | 'code' | 'ai'>('ai')

const chatSession = createChatSessionManager({
  getActiveEditorStore,
  loadHistory: loadPiChatHistory,
  // T27：返回 Promise——resetChat await 它，ChatPanel 在铸会话完成后确定性刷新会话栏
  onSessionReset: (store: ReturnType<typeof getActiveEditorStore>) => mintPiSessionId(store)
})

if (hasWindowGlobal()) {
  exposeChatTransportOverride((factory) => {
    chatSession.setOverrideTransport(factory)
  })
}

export function useAIChat() {
  return {
    activeTab,
    ensureChat: chatSession.ensureChat,
    resetChat: chatSession.resetChat,
    chatFailure: chatSession.failure,
    clearChatFailure: chatSession.clearFailure
  }
}
