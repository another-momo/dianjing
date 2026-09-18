import { expect, test } from 'bun:test'

import { appCredentialServices } from '@/app/settings/credentials/app'
import {
  pexelsKeyStatus,
  refreshMediaCredentials,
  setPexelsKey,
  setUnsplashKey,
  unsplashKeyStatus
} from '@/app/settings/credentials/media'
import {
  PEXELS_CREDENTIAL,
  UNSPLASH_CREDENTIAL
} from '@/app/settings/credentials/media-credentials'

import {
  getActiveProvider,
  setActiveStockPhotoProvider,
  setPexelsAPIKey,
  setUnsplashAccessKey
} from '#core/tools/stock-photo/providers'

const SEARCH_OPTIONS = { perPage: 1, orientation: 'landscape', targetDim: 100 } as const

function activeStockPhotoProvider() {
  const provider = getActiveProvider()
  if (!provider) throw new Error('Missing registered provider')
  return provider
}

test('media keys are injected as lazy resolvers that re-read the store at search time', async () => {
  const previousProvider = getActiveProvider()?.name ?? null
  try {
    await setPexelsKey('pexels-secret')
    expect(pexelsKeyStatus.value).toBe('configured')
    setActiveStockPhotoProvider('pexels')

    // 绕过 media.ts 直接清 store：惰性 resolver 只在搜索时落手，读到 null
    // 即抛 not configured——若注入的是急迫求值的字符串快照，此处会拿旧
    // key 继续发请求而不是抛 not configured
    await appCredentialServices.manager.clear(PEXELS_CREDENTIAL)
    await expect(activeStockPhotoProvider().search('forest', SEARCH_OPTIONS)).rejects.toThrow(
      'not configured'
    )
  } finally {
    setPexelsAPIKey(null)
    setActiveStockPhotoProvider(previousProvider)
    await appCredentialServices.manager.clear(PEXELS_CREDENTIAL)
  }
})

test('missing keys inject a null credential source and report missing status', async () => {
  const previousProvider = getActiveProvider()?.name ?? null
  try {
    await setUnsplashKey('unsplash-secret')
    expect(unsplashKeyStatus.value).toBe('configured')
    await setUnsplashKey('')
    expect(unsplashKeyStatus.value).toBe('missing')
    setActiveStockPhotoProvider('unsplash')
    await expect(activeStockPhotoProvider().search('forest', SEARCH_OPTIONS)).rejects.toThrow(
      'not configured'
    )
  } finally {
    setUnsplashAccessKey(null)
    setActiveStockPhotoProvider(previousProvider)
    await appCredentialServices.manager.clear(UNSPLASH_CREDENTIAL)
  }
})

test('refreshMediaCredentials mirrors stored state into the status refs', async () => {
  const previousProvider = getActiveProvider()?.name ?? null
  try {
    await appCredentialServices.manager.set(PEXELS_CREDENTIAL, 'stored-key')
    await refreshMediaCredentials()
    expect(pexelsKeyStatus.value).toBe('configured')
    await appCredentialServices.manager.clear(PEXELS_CREDENTIAL)
    await refreshMediaCredentials()
    expect(pexelsKeyStatus.value).toBe('missing')
  } finally {
    setPexelsAPIKey(null)
    setUnsplashAccessKey(null)
    setActiveStockPhotoProvider(previousProvider)
    await appCredentialServices.manager.clear(PEXELS_CREDENTIAL)
  }
})
