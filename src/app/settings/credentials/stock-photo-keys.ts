/**
 * T25：stock-photo 凭证面（pexels/unsplash）+ 持久化开关——从已删除的
 * ai/chat/storage.ts 手术式拆出（T25-plan D2：旧 AI 凭证面切除，stock-photo
 * 链保留——stockPhoto 在 22 件 CORE_TOOLS 内，pi 模式经 7600 桥可用）。
 *
 * key 卫生：写入经 appCredentialServices.manager，读只经 resolver 注入 core
 * （setPexelsAPIKey/setUnsplashAccessKey），不打印不外传。
 */

import { ref } from 'vue'

import { setPexelsAPIKey, setUnsplashAccessKey } from '@open-pencil/core/tools'

import { appCredentialServices, browserCredentialsRemembered } from '@/app/settings/credentials/app'
import {
  PEXELS_CREDENTIAL,
  UNSPLASH_CREDENTIAL
} from '@/app/settings/credentials/media-credentials'
import { setAppCredentialPersistence } from '@/app/settings/credentials/persistence'
import type { CredentialRef, CredentialStatus } from '@/app/settings/credentials/types'

export { PEXELS_CREDENTIAL, UNSPLASH_CREDENTIAL }

export const pexelsKeyStatus = ref<CredentialStatus>('missing')
export const unsplashKeyStatus = ref<CredentialStatus>('missing')

async function refreshStatus(reference: CredentialRef): Promise<CredentialStatus> {
  const status = await appCredentialServices.manager.status(reference)
  return status === 'missing' && hasLegacyCredential(reference) ? 'configured' : status
}
async function resolveMediaCredential(reference: CredentialRef): Promise<string | null> {
  await initializeCredentialMigration()
  return appCredentialServices.resolver.resolve(reference)
}

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

export async function setPexelsKey(key: string): Promise<void> {
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

export { browserCredentialsRemembered }

export async function setRememberCredentials(remembered: boolean): Promise<void> {
  await setAppCredentialPersistence(remembered)
  await refreshMediaCredentials()
}

// 模块加载即刷新一次：把已存 key 注入 core（stockPhoto 工具经桥在编辑器侧
// 读取 core 内 key）。承接已删除的 chat/storage.ts credentialsReady 职责
// （T25 D2 切除迁移逻辑——T21 已拍板不做存量迁移）。
void refreshMediaCredentials()
