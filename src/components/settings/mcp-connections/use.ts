/**
 * MCP 连接编排层：脏检查、busy 守卫、部分保存 partial、并发写队列。
 *
 * 与上游拷改版的差异：上游接 localStorage + 凭据服务层，本仓接 fetch client
 * （见 ./client）；token 状态机概念被「headers/env 已配置态」取代——
 * hasHeaders/hasEnv 是元数据而非状态机；名称即 slug，合法性校验在 form 层。
 */

import { tryOnScopeDispose } from '@vueuse/core'
import { computed, ref, watch, type Ref } from 'vue'

import type { SettingsSaveResult } from '@/app/settings/save-result'

import { saveMCPConnection, deleteMCPConnection } from './client'
import { enqueueMCPConnectionMutation } from './mutations'
import { createEmptyMCPConnectionDraft, type MCPConnectionDraft } from './types'

const connectionServices = {
  save: saveMCPConnection,
  remove: deleteMCPConnection
}

export function useMCPConnectionSettings(draft: Ref<MCPConnectionDraft>) {
  const busy = ref(0)
  const isBusy = computed(() => busy.value > 0)
  const error = ref('')
  const saveResult = ref<SettingsSaveResult | null>(null)

  let version = 0
  let disposed = false

  tryOnScopeDispose(() => {
    disposed = true
    version++
  })

  function current(request: number): boolean {
    return !disposed && request === version
  }

  function startAdd(): void {
    version++
    saveResult.value = null
    draft.value = createEmptyMCPConnectionDraft()
    error.value = ''
  }

  function startEdit(source: MCPConnectionDraft): void {
    version++
    saveResult.value = null
    draft.value = { ...source }
    error.value = ''
  }

  async function save(): Promise<SettingsSaveResult> {
    const progress = { persisted: false }
    saveResult.value = null
    const request = ++version
    busy.value++
    // 名称即 slug：编辑态用既有 id，新建取 name.trim()（form 层已校验）
    const id = draft.value.id ?? draft.value.name.trim()
    error.value = ''

    try {
      const result = await enqueueMCPConnectionMutation(id, async () => {
        const connection = await connectionServices.save({ ...draft.value, id })
        progress.persisted = true
        return connection
      })
      if (!current(request)) return 'partial'

      if (result.status === 'failed' && result.error) {
        // 保存成功但健康检查失败：不阻断保存（仅显错）；UI 据徽章呈现
        error.value = result.error
      }
      saveResult.value = 'saved'
      return 'saved'
    } catch (cause) {
      const result = progress.persisted ? 'partial' : 'failed'
      if (current(request)) {
        error.value = cause instanceof Error ? cause.message : String(cause)
        saveResult.value = result
      }
      return result
    } finally {
      busy.value--
    }
  }

  async function remove(): Promise<boolean> {
    saveResult.value = null
    const id = draft.value.id
    if (!id) return false

    const request = ++version
    busy.value++
    error.value = ''

    try {
      await enqueueMCPConnectionMutation(id, () => connectionServices.remove(id))
      return current(request)
    } catch (cause) {
      if (current(request)) error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    } finally {
      busy.value--
    }
  }

  watch(
    () => draft.value.transport,
    () => {
      error.value = ''
    }
  )

  return {
    draft,
    busy: isBusy,
    error,
    saveResult,
    startAdd,
    startEdit,
    save,
    remove
  }
}
