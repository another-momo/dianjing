import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { effectScope } from 'vue'

import { appCredentialServices, browserCredentialsRemembered } from '@/app/settings/credentials/app'
import { BrowserCredentialStore } from '@/app/settings/credentials/browser'
import { PEXELS_CREDENTIAL } from '@/app/settings/credentials/media-credentials'
import { useCredentialSettings } from '@/app/settings/credentials/preferences/use'

/** The remembered setter is fire-and-forget; poll the store backend until it flips. */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
}

test('remember toggle switches the app credential store through useCredentialSettings', async () => {
  const scope = effectScope()
  try {
    const state = scope.run(() => useCredentialSettings())
    if (!state) throw new Error('Missing scope')

    expect(state.remembered.value).toBe(false)
    expect(state.failed.value).toBe(false)
    expect(appCredentialServices.manager.backend).toBe('memory')

    await appCredentialServices.manager.set(PEXELS_CREDENTIAL, 'pexels-secret')

    state.remembered.value = true
    await waitFor(() => appCredentialServices.manager.backend === 'browser', 'browser backend')
    expect(state.remembered.value).toBe(true)
    expect(browserCredentialsRemembered.value).toBe(true)
    expect(state.failed.value).toBe(false)
    // 切换把已存 key 搬进加密浏览器库，resolver 依旧可读
    expect(await appCredentialServices.resolver.resolve(PEXELS_CREDENTIAL)).toBe('pexels-secret')

    state.remembered.value = false
    await waitFor(() => appCredentialServices.manager.backend === 'memory', 'memory backend')
    expect(state.remembered.value).toBe(false)
    expect(browserCredentialsRemembered.value).toBe(false)
    // 关闭 remember：key 随会话保留（浏览器库→内存库搬移），持久面被清掉
    // （clearPrevious）——新开的浏览器库实例读同一份 IDB，应读不到
    expect(await appCredentialServices.resolver.resolve(PEXELS_CREDENTIAL)).toBe('pexels-secret')
    expect(await new BrowserCredentialStore().read(PEXELS_CREDENTIAL)).toBeNull()
  } finally {
    scope.stop()
    await appCredentialServices.manager.clear(PEXELS_CREDENTIAL)
  }
})
