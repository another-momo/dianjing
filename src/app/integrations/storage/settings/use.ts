import { tryOnMounted, tryOnScopeDispose } from '@vueuse/core'
import { isEqual } from 'es-toolkit'
import { computed, ref, watch, type Ref } from 'vue'

import {
  activeStorageProviderID,
  readStoragePreferences,
  storageCredentialStatuses,
  storageProviderRegistry,
  writeStoragePreference
} from '@/app/integrations/storage'
import { appCredentialServices } from '@/app/settings/credentials/app'
import { credentialRef } from '@/app/settings/credentials/reference'
import type { CredentialStatus } from '@/app/settings/credentials/types'
import { resumeStorageSync } from '@/app/storage/sync'

import { testStorageDraft } from './draft'

const storageSettingsServices = {
  readPreferences: readStoragePreferences,
  writePreference: writeStoragePreference,
  statuses: storageCredentialStatuses,
  manager: appCredentialServices.manager,
  test: testStorageDraft,
  resume: resumeStorageSync
}

import type { SettingsSaveResult } from '@/app/settings/save-result'

export function useStorageSettings(
  credentialDrafts: Ref<Record<string, string>>,
  services = storageSettingsServices
) {
  const provider = computed(() => storageProviderRegistry.get(activeStorageProviderID.value))

  // AppInput 的 modelValue 是 required——草稿记录先给全部字段 '' 入座，
  // 未填写/未配置字段不再以 undefined 绑进输入框（2026-09-16 修 5 条 prop 警告）
  const preferenceDrafts = ref<Record<string, string>>({
    ...Object.fromEntries(provider.value.preferenceFields.map((field) => [field.id, ''])),
    ...readStoragePreferences(provider.value.id)
  })
  credentialDrafts.value = Object.fromEntries(
    provider.value.credentialFields.map((field) => [field.id, ''])
  )
  const credentialStatuses = ref<Record<string, CredentialStatus>>({})
  const busy = ref(false)

  const configured = computed(
    () =>
      provider.value.preferenceFields.every(
        (field) =>
          !field.required || Boolean(services.readPreferences(provider.value.id)[field.id]?.trim())
      ) &&
      provider.value.credentialFields.every(
        (field) => !field.required || savedStatuses.value[field.id] === 'configured'
      )
  )
  let statusRequest = 0
  let version = 0
  let disposed = false

  tryOnScopeDispose(() => {
    disposed = true
    version++
    statusRequest++
    credentialDrafts.value = {}
  })

  function current(request: number) {
    return !disposed && request === version
  }

  async function refreshStatuses() {
    const request = ++statusRequest
    const target = provider.value
    try {
      const statuses = await services.statuses(target.id)
      if (!disposed && request === statusRequest && provider.value.id === target.id)
        savedStatuses.value = statuses
    } catch {
      if (!disposed && request === statusRequest && provider.value.id === target.id) {
        savedStatuses.value = Object.fromEntries(
          target.credentialFields.map((field) => [field.id, 'unavailable' as const])
        )
      }
    }
  }

  function savePreferences(): void {
    for (const field of provider.value.preferenceFields) {
      writeStoragePreference(provider.value.id, field.id, preferenceDrafts.value[field.id] ?? '')
    }
    void resumeStorageSync()
  }

  async function saveCredential(field: string): Promise<void> {
    const target = credentialDrafts.value
    const value = target[field]?.trim()
    if (!value) return

    await appCredentialServices.manager.set(credentialRef(provider.value.id, field), value)
    if (credentialDrafts.value === target && target[field]?.trim() === value) target[field] = ''
    await refreshStatuses()
    await resumeStorageSync()
  }

  async function clearCredential(field: string): Promise<void> {
    const target = credentialDrafts.value
    await appCredentialServices.manager.clear(credentialRef(provider.value.id, field))
    if (credentialDrafts.value === target) target[field] = ''
    await refreshStatuses()
  }

  watch(activeStorageProviderID, (providerID) => {
    credentialStatuses.value = {}
    preferenceDrafts.value = {
      ...Object.fromEntries(
        storageProviderRegistry.get(providerID).preferenceFields.map((field) => [field.id, ''])
      ),
      ...readStoragePreferences(providerID)
    }
    credentialDrafts.value = Object.fromEntries(
      storageProviderRegistry.get(providerID).credentialFields.map((field) => [field.id, ''])
    )
    void refreshStatuses()
  }

  function clearCredential(field: string) {
    if (busy.value || !provider.value.credentialFields.some((item) => item.id === field)) return
    credentialDrafts.value = { ...credentialDrafts.value, [field]: '' }
    cleared.value = [...new Set([...cleared.value, field])]
  }

  async function save(): Promise<SettingsSaveResult> {
    if (busy.value || disposed) return 'failed'
    let persisted = false
    saveResult.value = null
    operation.value = 'save'
    error.value = ''
    const request = ++version
    const target = provider.value
    const preferences = { ...preferenceDrafts.value }
    const credentials = { ...credentialDrafts.value }
    const removals = new Set(cleared.value)
    try {
      // Persistence spans preferences and the native credential store; it is not atomic.
      for (const field of target.preferenceFields) {
        services.writePreference(target.id, field.id, preferences[field.id] ?? '')
        persisted = true
      }
      for (const field of target.credentialFields) {
        if (!current(request)) return persisted ? 'partial' : 'failed'
        const reference = credentialRef(target.id, field.id)
        const replacement = credentials[field.id]?.trim()
        if (replacement) await services.manager.set(reference, replacement)
        else if (removals.has(field.id)) await services.manager.clear(reference)
        if (replacement || removals.has(field.id)) persisted = true
      }
      if (!current(request)) return persisted ? 'partial' : 'failed'
      reset()
      void services
        .resume()
        .catch(() =>
          console.warn('[Storage] Could not resume synchronization after saving settings')
        )
      saveResult.value = 'saved'
      return 'saved'
    } catch (cause) {
      const result = persisted ? 'partial' : 'failed'
      if (current(request)) {
        error.value = cause instanceof Error ? cause.message : String(cause)
        saveResult.value = result
        await refreshStatuses()
      }
      return result
    } finally {
      operation.value = null
    }
  }

  async function testConnection() {
    if (busy.value || disposed) return null
    operation.value = 'test'
    const request = version
    const target = provider.value.id
    const credentials = { ...credentialDrafts.value }
    const removals = cleared.value.filter((field) => !credentials[field]?.trim())
    try {
      const result = await services.test(
        target,
        { ...preferenceDrafts.value },
        credentials,
        removals
      )
      return current(request) ? result : null
    } catch (cause) {
      return current(request)
        ? { ok: false as const, message: cause instanceof Error ? cause.message : String(cause) }
        : null
    } finally {
      operation.value = null
    }
  }

  watch(activeStorageProviderID, () => {
    savedStatuses.value = {}
    reset()
  })
  tryOnMounted(() => void refreshStatuses())

  return {
    provider,
    preferenceDrafts,
    credentialStatuses,
    operation,
    busy,
    configured,
    dirty,
    error,
    saveResult,
    begin: reset,
    cancel: reset,
    save,
    clearCredential,
    testConnection
  }
}
