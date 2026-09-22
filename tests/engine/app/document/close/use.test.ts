import { expect, test } from 'bun:test'

import { handleCloseRequestImpl, isMacPlatform, matchesReloadKey } from '@/app/document/close/use'

test('handleCloseRequestImpl short-circuits when approval already granted', async () => {
  let confirmCalls = 0
  const result = await handleCloseRequestImpl(
    () => true,
    async () => {
      confirmCalls++
      return true
    }
  )
  expect(result).toBe(true)
  expect(confirmCalls).toBe(0)
})

test('handleCloseRequestImpl defers to confirm when approval not set', async () => {
  const result = await handleCloseRequestImpl(
    () => false,
    async () => true
  )
  expect(result).toBe(true)
})

test('handleCloseRequestImpl propagates a rejected confirm', async () => {
  const result = await handleCloseRequestImpl(
    () => false,
    async () => false
  )
  expect(result).toBe(false)
})

test('isMacPlatform detects the mac token', () => {
  expect(isMacPlatform('MacIntel')).toBe(true)
  expect(isMacPlatform('MacPPC')).toBe(true)
  expect(isMacPlatform('MacARM')).toBe(true)
  expect(isMacPlatform('Win32')).toBe(false)
  expect(isMacPlatform('Linux x86_64')).toBe(false)
})

test('matchesReloadKey accepts F5 regardless of mac/win', () => {
  expect(matchesReloadKey({ key: 'F5', metaKey: false, ctrlKey: false, altKey: false }, true)).toBe(
    true
  )
  expect(
    matchesReloadKey({ key: 'F5', metaKey: false, ctrlKey: false, altKey: false }, false)
  ).toBe(true)
})

test('matchesReloadKey accepts Cmd+R on mac and Ctrl+R on win', () => {
  expect(matchesReloadKey({ key: 'r', metaKey: true, ctrlKey: false, altKey: false }, true)).toBe(
    true
  )
  expect(matchesReloadKey({ key: 'R', metaKey: true, ctrlKey: false, altKey: false }, true)).toBe(
    true
  )
  expect(matchesReloadKey({ key: 'r', metaKey: false, ctrlKey: true, altKey: false }, false)).toBe(
    true
  )
})

test('matchesReloadKey rejects the wrong-side modifier on each platform', () => {
  // mac: requires meta, not ctrl
  expect(matchesReloadKey({ key: 'r', metaKey: false, ctrlKey: true, altKey: false }, true)).toBe(
    false
  )
  // win: requires ctrl, not meta
  expect(matchesReloadKey({ key: 'r', metaKey: true, ctrlKey: false, altKey: false }, false)).toBe(
    false
  )
})

test('matchesReloadKey lets Shift variants through (hard reload still reloads)', () => {
  expect(
    matchesReloadKey(
      { key: 'R', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
      true
    )
  ).toBe(true)
  expect(
    matchesReloadKey(
      { key: 'r', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      false
    )
  ).toBe(true)
})

test('matchesReloadKey rejects when Alt is held', () => {
  expect(matchesReloadKey({ key: 'r', metaKey: true, ctrlKey: false, altKey: true }, true)).toBe(
    false
  )
  expect(matchesReloadKey({ key: 'r', metaKey: false, ctrlKey: true, altKey: true }, false)).toBe(
    false
  )
})

test('matchesReloadKey ignores unrelated keys', () => {
  expect(matchesReloadKey({ key: 'a', metaKey: true, ctrlKey: false, altKey: false }, true)).toBe(
    false
  )
  expect(
    matchesReloadKey({ key: 'F4', metaKey: false, ctrlKey: false, altKey: false }, false)
  ).toBe(false)
  expect(
    matchesReloadKey({ key: 'Enter', metaKey: false, ctrlKey: false, altKey: false }, false)
  ).toBe(false)
})
