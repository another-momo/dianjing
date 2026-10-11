import type { ChatTransport, UIMessage } from 'ai'

import { hasWindowGlobal } from '@open-pencil/core/constants'

import type { EditorStore } from '@/app/editor/session/create'
import { createNavigationBenchmarkHooks } from '@/app/performance/navigation/hooks'
import type { NavigationBenchmarkHooks } from '@/app/performance/navigation/hooks'
import { appRuntimeConfig } from '@/app/runtime/config'

export interface OpenPencilTestHooks {
  writeCount?: () => number
  mockHandle?: FileSystemFileHandle
  savedOpen?: Window['open']
  navigation?: NavigationBenchmarkHooks
}

export interface OpenPencilWindowAPI {
  getStore?: () => EditorStore
  // T22：工厂收到 Chat 所属 EditorStore（pi 后端按 store 解析文档会话）；
  // 既有无参工厂（e2e mock）忽略该参，向后兼容
  setChatTransport?: (factory: (store: EditorStore) => ChatTransport<UIMessage>) => void
  openFile?: (path: string) => Promise<void>
  test?: OpenPencilTestHooks
}

let activeStore: EditorStore | null = null

function windowAPI(): OpenPencilWindowAPI {
  window.openPencil ??= {}
  window.openPencil.getStore ??= () => {
    if (!activeStore) throw new Error('Dianjing Studio store not initialized')
    return activeStore
  }
  return window.openPencil
}

export function setOpenPencilStore(store: EditorStore) {
  activeStore = store
  if (!hasWindowGlobal()) return
  const api = windowAPI()
  if (appRuntimeConfig.navigationBenchmark) {
    const testHooks = (api.test ??= {})
    testHooks.navigation = createNavigationBenchmarkHooks(store)
  }
}

export function exposeChatTransportOverride(
  setChatTransport: (factory: (store: EditorStore) => ChatTransport<UIMessage>) => void
) {
  windowAPI().setChatTransport = setChatTransport
}

export function setOpenPencilOpenFileHandler(openFile: (path: string) => Promise<void>) {
  windowAPI().openFile = openFile
}
