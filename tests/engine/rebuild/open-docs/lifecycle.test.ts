/**
 * open-docs 前端生命周期状态机单测——网络层桩全局 fetch（仓内既有先例），
 * 定时器以计数捕获、sendBeacon 以 navigator 覆写捕获。不覆盖冲突卡组件渲染与
 * tabs 装配（装配缝配装配面；mint → claim 接线在此直测）。
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

import { ensurePiDocUuid, setPiDocUuidMintedListener } from '@/app/ai/pi-backend/document-key'
import type { EditorStore } from '@/app/editor/session'
import { createEditorStore } from '@/app/editor/session/create'
import {
  answerOpenDocsConflict,
  claimDocumentOpen,
  openDocsConflict,
  releaseAllOnPageHide,
  releaseDocumentClaim,
  wireOpenDocsLifecycle
} from '@/app/open-docs/lifecycle'

const HEARTBEAT_INTERVAL_MS = 20_000

const OK_RECORD = { pid: 1, windowId: 'self-window', heartbeatAt: 1 }
const CONFLICT_HOLDER = { pid: 2, windowId: 'other-window', heartbeatAt: 123 }

function makeStore(docUuid: string | null, documentName = 'Doc'): EditorStore {
  const store = createEditorStore()
  store.state.documentName = documentName
  if (docUuid !== null) {
    store.graph.updateNode(store.graph.rootId, {
      pluginData: [{ pluginId: 'openpencil.ai', key: 'openpencil.ai/docId', value: docUuid }]
    })
  }
  return store
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status })
}

function claimOk(): Response {
  return jsonResponse(200, { record: OK_RECORD })
}

function claimConflict(): Response {
  return jsonResponse(409, { error: 'live_other_instance', holder: CONFLICT_HOLDER })
}

/** 心跳定时器回调是 fire-and-forget（void sendHeartbeat）——tick 后排空微任务再断言 */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

let fetchCalls: Array<{ url: string; body: Record<string, unknown> | null; init: RequestInit }>
let intervalFns: Array<() => void>
let intervalMs: number | undefined
let clearCalls: number
let route: (url: string, body: Record<string, unknown> | null) => Response

beforeEach(() => {
  fetchCalls = []
  intervalFns = []
  intervalMs = undefined
  clearCalls = 0
  route = () => new Response(null, { status: 204 })
  spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = init?.body
      const body = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null
      fetchCalls.push({ url: String(input), body, init: init ?? {} })
      return route(String(input), body)
    }
  )
  spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
    intervalFns.push(fn)
    intervalMs = ms
    // 返回真值句柄（真实环境为正整数/Timeout 对象）——useIntervalFn 的 clean()
    // 以 `if (timer)` 判空，返回 0 会让 pause() 静默跳过 clearInterval
    return 1 as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval)
  spyOn(globalThis, 'clearInterval').mockImplementation((() => {
    clearCalls++
  }) as unknown as typeof clearInterval)
  // 清理上一用例遗留的模块级持有（beacon 落进本轮 fetch 桩），随后计数归零
  releaseAllOnPageHide()
  fetchCalls = []
  intervalFns = []
  clearCalls = 0
  openDocsConflict.value = null
  setPiDocUuidMintedListener(null)
})

afterEach(() => {
  mock.restore()
  openDocsConflict.value = null
  setPiDocUuidMintedListener(null)
})

describe('claimDocumentOpen', () => {
  test('无 uuid 文档 → 不发请求（不拦不 claim）', async () => {
    await claimDocumentOpen(makeStore(null))
    expect(fetchCalls).toEqual([])
  })

  test('claim 成功 → POST claim + 心跳定时器 20s + 同 uuid 幂等', async () => {
    const store = makeStore('uuid-a')
    route = () => claimOk()
    await claimDocumentOpen(store)
    expect(fetchCalls.length).toBe(1)
    expect(fetchCalls[0]?.url).toBe('/api/pi/open-docs/claim')
    expect(fetchCalls[0]?.body).toMatchObject({ docUuid: 'uuid-a', force: false })
    expect(typeof fetchCalls[0]?.body?.windowId).toBe('string')
    expect(intervalFns.length).toBe(1)
    expect(intervalMs).toBe(HEARTBEAT_INTERVAL_MS)

    await claimDocumentOpen(store)
    expect(fetchCalls.length).toBe(1)
  })

  test('claim 409 → 冲突卡置位（含持有者）且无心跳', async () => {
    route = () => claimConflict()
    await claimDocumentOpen(makeStore('uuid-b', 'MyDoc'))
    expect(openDocsConflict.value).toMatchObject({
      docUuid: 'uuid-b',
      documentName: 'MyDoc',
      holder: CONFLICT_HOLDER
    })
    expect(intervalFns.length).toBe(0)
  })

  test('claim 不可用（500）→ 无卡无定时器，文档照常打开', async () => {
    route = () => new Response(null, { status: 500 })
    await claimDocumentOpen(makeStore('uuid-c'))
    expect(openDocsConflict.value).toBeNull()
    expect(intervalFns.length).toBe(0)
    expect(fetchCalls.length).toBe(1)
  })
})

describe('心跳', () => {
  test('心跳 409 → 摘持有（clearInterval + warn），此后可重新 claim', async () => {
    route = (url) => (url.endsWith('/claim') ? claimOk() : new Response(null, { status: 409 }))
    const store = makeStore('uuid-h')
    await claimDocumentOpen(store)
    expect(intervalFns.length).toBe(1)

    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const tick = intervalFns[0]
    if (!tick) throw new Error('heartbeat timer missing')
    await tick()
    await flushAsync()
    warn.mockRestore()
    expect(clearCalls).toBe(1)
    expect(fetchCalls.filter((c) => c.url.endsWith('/heartbeat')).length).toBe(1)

    const before = fetchCalls.length
    await claimDocumentOpen(makeStore('uuid-h'))
    expect(fetchCalls.length).toBe(before + 1)
  })

  test('心跳网络异常 → 不摘持有，下轮续刷', async () => {
    route = (url) => {
      if (url.endsWith('/claim')) return claimOk()
      throw new Error('network down')
    }
    await claimDocumentOpen(makeStore('uuid-i'))
    const tick = intervalFns[0]
    if (!tick) throw new Error('heartbeat timer missing')
    await tick()
    await flushAsync()
    expect(clearCalls).toBe(0)
  })
})

describe('answerOpenDocsConflict', () => {
  test('force → force:true 重 claim 成功 + 心跳启动 + 卡清空', async () => {
    route = () => claimConflict()
    await claimDocumentOpen(makeStore('uuid-f'))
    expect(openDocsConflict.value).not.toBeNull()

    route = () => claimOk()
    await answerOpenDocsConflict('force')
    expect(openDocsConflict.value).toBeNull()
    const claimCalls = fetchCalls.filter((c) => c.url.endsWith('/claim'))
    expect(claimCalls.length).toBe(2)
    expect(claimCalls[1]?.body).toMatchObject({ docUuid: 'uuid-f', force: true })
    expect(intervalFns.length).toBe(1)
  })

  test('close → 注入的关 tab 通路被调 + 卡清空', async () => {
    const closed: EditorStore[] = []
    wireOpenDocsLifecycle({
      closeStoreTab: async (store) => {
        closed.push(store)
      }
    })
    route = () => claimConflict()
    await claimDocumentOpen(makeStore('uuid-g', 'G'))
    const conflictStore = openDocsConflict.value?.store
    if (!conflictStore) throw new Error('conflict state missing')

    await answerOpenDocsConflict('close')
    expect(openDocsConflict.value).toBeNull()
    expect(closed).toEqual([conflictStore])
  })

  test('dismiss → 卡清空且零请求', async () => {
    route = () => claimConflict()
    await claimDocumentOpen(makeStore('uuid-j'))
    const before = fetchCalls.length
    await answerOpenDocsConflict('dismiss')
    expect(openDocsConflict.value).toBeNull()
    expect(fetchCalls.length).toBe(before)
  })
})

describe('releaseDocumentClaim', () => {
  test('已持有 → POST release + 摘定时器', async () => {
    route = () => claimOk()
    const store = makeStore('uuid-r')
    await claimDocumentOpen(store)
    const before = fetchCalls.length

    releaseDocumentClaim(store)
    expect(fetchCalls.length).toBe(before + 1)
    expect(fetchCalls[before]?.url).toBe('/api/pi/open-docs/release')
    expect(fetchCalls[before]?.body).toMatchObject({ docUuid: 'uuid-r' })
    expect(clearCalls).toBe(1)
  })

  test('未持有 / 无 uuid → 零请求', () => {
    releaseDocumentClaim(makeStore('uuid-not-held'))
    releaseDocumentClaim(makeStore(null))
    expect(fetchCalls).toEqual([])
  })
})

describe('releaseAllOnPageHide', () => {
  test('sendBeacon 优先：每个持有 uuid 一条，持有表清空', async () => {
    const beacons: Array<{ url: string; blob: Blob }> = []
    const realNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        sendBeacon: (url: string, data: Blob) => {
          beacons.push({ url, blob: data })
          return true
        }
      }
    })
    try {
      route = () => claimOk()
      await claimDocumentOpen(makeStore('uuid-p1'))
      await claimDocumentOpen(makeStore('uuid-p2'))

      releaseAllOnPageHide()
      expect(beacons.length).toBe(2)
      const first = beacons[0]
      if (!first) throw new Error('beacon missing')
      expect(first.url).toBe('/api/pi/open-docs/release')
      const payload = JSON.parse(await first.blob.text()) as Record<string, unknown>
      expect(payload.docUuid).toBe('uuid-p1')
      expect(typeof payload.windowId).toBe('string')
      expect(clearCalls).toBe(2)
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: realNavigator
      })
    }
  })

  test('无 sendBeacon → fetch keepalive 兜底', async () => {
    const realNavigator = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'probe' }
    })
    try {
      route = () => claimOk()
      await claimDocumentOpen(makeStore('uuid-k'))

      releaseAllOnPageHide()
      const last = fetchCalls.at(-1)
      if (!last) throw new Error('release fetch missing')
      expect(last.url).toBe('/api/pi/open-docs/release')
      expect(last.init.keepalive).toBe(true)
      expect(last.body).toMatchObject({ docUuid: 'uuid-k' })
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: realNavigator
      })
    }
  })
})

describe('wireOpenDocsLifecycle — mint → claim 生产接线', () => {
  test('惰性铸出新 uuid 后自动 claim', async () => {
    wireOpenDocsLifecycle({
      closeStoreTab: async () => undefined
    })
    route = () => claimOk()
    const store = makeStore(null)
    ensurePiDocUuid(store)
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    const claimCalls = fetchCalls.filter((c) => c.url.endsWith('/claim'))
    expect(claimCalls.length).toBe(1)
    expect(claimCalls[0]?.body?.docUuid).toBe(readBackUuid(store))
  })
})

function readBackUuid(store: EditorStore): string {
  const uuid = store.graph
    .getNode(store.graph.rootId)
    ?.pluginData.find(
      (entry) => entry.pluginId === 'openpencil.ai' && entry.key === 'openpencil.ai/docId'
    )?.value
  if (uuid === undefined) throw new Error('minted uuid missing on graph')
  return uuid
}
