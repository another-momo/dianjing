import { ref } from 'vue'

import { setPexelsAPIKey, setUnsplashAccessKey } from '@open-pencil/core/tools'

import { appCredentialServices } from './app'
import { PEXELS_CREDENTIAL, UNSPLASH_CREDENTIAL } from './media-credentials'
import { setAppCredentialPersistence } from './persistence'
import type { CredentialRef, CredentialStatus } from './types'
export const credentialPersistenceRevision = ref(0)
async function refreshStatus(reference: CredentialRef): Promise<CredentialStatus> {
  return appCredentialServices.manager.status(reference)
}
async function resolveMediaCredential(reference: CredentialRef): Promise<string | null> {
  return appCredentialServices.resolver.resolve(reference)
}
export const pexelsKeyStatus = ref<CredentialStatus>('missing')
export const unsplashKeyStatus = ref<CredentialStatus>('missing')
export async function refreshMediaCredentials(): Promise<void> {
  const [pexelsStatus, unsplashStatus] = await Promise.all([
    refreshStatus(PEXELS_CREDENTIAL),
    refreshStatus(UNSPLASH_CREDENTIAL)
  ])
  pexelsKeyStatus.value = pexelsStatus
  unsplashKeyStatus.value = unsplashStatus
  setPexelsAPIKey(
    pexelsStatus === 'configured' ? () => resolveMediaCredential(PEXELS_CREDENTIAL) : null
  )
  setUnsplashAccessKey(
    unsplashStatus === 'configured' ? () => resolveMediaCredential(UNSPLASH_CREDENTIAL) : null
  )
}
async function setMediaKey(reference: CredentialRef, key: string): Promise<CredentialStatus> {
  const value = key.trim()
  if (value) await appCredentialServices.manager.set(reference, value)
  else await appCredentialServices.manager.clear(reference)
  return refreshStatus(reference)
}
export async function setPexelsKey(key: string): Promise<void> {
  pexelsKeyStatus.value = await setMediaKey(PEXELS_CREDENTIAL, key)
  setPexelsAPIKey(
    pexelsKeyStatus.value === 'configured' ? () => resolveMediaCredential(PEXELS_CREDENTIAL) : null
  )
}
export async function setUnsplashKey(key: string): Promise<void> {
  unsplashKeyStatus.value = await setMediaKey(UNSPLASH_CREDENTIAL, key)
  setUnsplashAccessKey(
    unsplashKeyStatus.value === 'configured'
      ? () => resolveMediaCredential(UNSPLASH_CREDENTIAL)
      : null
  )
}
export async function setRememberCredentials(remembered: boolean): Promise<void> {
  await setAppCredentialPersistence(remembered)
  await refreshMediaCredentials()
  credentialPersistenceRevision.value++
}

// 模块加载即刷新一次：把已存 key 的惰性 resolver 注入 core（stockPhoto 工具经桥
// 在编辑器侧读取 core 内 key）。承接已删除的 chat/storage.ts credentialsReady 与
// stock-photo-keys.ts 模块加载自刷职责——上游的启动触发点在其 chat 面，fork 已裁。
void refreshMediaCredentials()
