/**
 * document-key 只读 reader + docUuid mint 钩子（open-docs 存活守卫前端接线面）：
 *  - readPiDocUuid：既有条目读回 / 无条目 null（不铸造——从未 AI 交互的文档不拦不 claim）
 *  - mint 钩子：缺省 null 无副作用；铸新 uuid 触发 (store, uuid)；已存在不触发；
 *    钩子异常不中断铸造
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  ensurePiDocUuid,
  readPiDocUuid,
  setPiDocUuidMintedListener
} from '@/app/ai/pi-backend/document-key'
import type { EditorStore } from '@/app/editor/session'

const DOC_NAMESPACE = 'openpencil.ai'
const DOC_ENTRY_KEY = 'openpencil.ai/docId'

interface PluginDataEntry {
  pluginId: string
  key: string
  value: string
}

function makeStore(docUuid: string | null): EditorStore {
  const root = {
    pluginData: docUuid ? [{ pluginId: DOC_NAMESPACE, key: DOC_ENTRY_KEY, value: docUuid }] : []
  }
  const graph = {
    rootId: 'root',
    getNode: () => root,
    updateNode: (_id: string, patch: { pluginData: PluginDataEntry[] }) => {
      root.pluginData = patch.pluginData
    }
  }
  return { graph } as unknown as EditorStore
}

beforeEach(() => {
  setPiDocUuidMintedListener(null)
})

afterEach(() => {
  setPiDocUuidMintedListener(null)
})

describe('readPiDocUuid', () => {
  test('已有 docId 条目 → 返回 uuid', () => {
    expect(readPiDocUuid(makeStore('uuid-1'))).toBe('uuid-1')
  })

  test('无条目 → null 且不铸造', () => {
    const store = makeStore(null)
    expect(readPiDocUuid(store)).toBeNull()
    expect(store.graph.getNode(store.graph.rootId)?.pluginData).toEqual([])
  })
})

describe('setPiDocUuidMintedListener', () => {
  test('缺省无钩子：mint 正常铸入并返回', () => {
    const store = makeStore(null)
    const uuid = ensurePiDocUuid(store)
    expect(uuid).toBeTruthy()
    expect(readPiDocUuid(store)).toBe(uuid)
  })

  test('铸新 uuid → 钩子收到 (store, uuid)；已存在 → 不触发', () => {
    const minted: Array<{ store: EditorStore; docUuid: string }> = []
    setPiDocUuidMintedListener((store, docUuid) => {
      minted.push({ store, docUuid })
    })
    const store = makeStore(null)
    const uuid = ensurePiDocUuid(store)
    expect(minted.length).toBe(1)
    expect(minted[0]?.docUuid).toBe(uuid)
    expect(minted[0]?.store).toBe(store)

    ensurePiDocUuid(store)
    expect(minted.length).toBe(1)
    expect(readPiDocUuid(store)).toBe(uuid)
  })

  test('钩子异常不中断铸造', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    setPiDocUuidMintedListener(() => {
      throw new Error('listener boom')
    })
    try {
      const store = makeStore(null)
      const uuid = ensurePiDocUuid(store)
      expect(uuid).toBeTruthy()
      expect(readPiDocUuid(store)).toBe(uuid)
    } finally {
      warn.mockRestore()
    }
  })
})
