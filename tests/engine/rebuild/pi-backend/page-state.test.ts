/**
 * 2026-09-26 sl-w1-page-state：page-state store 单测——
 *
 * 覆盖矩阵：
 *  - 缺文件 → null（腐烂即无，不抛）
 *  - 坏 JSON → null
 *  - 形状坏（缺字段 / 类型错 / 多余字段被忽略）→ null
 *  - 正常形状 → 读回
 *  - write patch 部分字段 → 未传字段保留旧值
 *  - write 显式 null → 清空该字段
 *  - write 空 patch → 删文件
 *  - write 后跨实例读回（读穿盘，无进程内缓存）
 *  - 返回对象深拷贝隔断外部改写
 *  - 进程外改文件 → 下次 read 即见新值（无缓存读穿——dev/打包版共享状态根场景）
 *  - clear 删文件（文件本不存在 no-op）
 *  - exists 判定
 *  - docUuid 非法字符 → throw
 *
 * 命名遵循 steiger prefer-domain-folders：与 design-assignment.test.ts
 * 同形态（裸 store 名，不带 service- 前缀）。
 *
 * 测试 fixture：mkdtemp 建临时 pageStateDir（与 design-assignment.test.ts
 * 同源）。
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPageStateStore } from '@/app/ai/pi-backend/page-state'

let pageStateDir = ''
const DOC_UUID = 'doc-abc-123'

beforeEach(() => {
  pageStateDir = mkdtempSync(join(tmpdir(), 'page-state-'))
})

afterEach(() => {
  rmSync(pageStateDir, { recursive: true, force: true })
})

test('缺文件 → read 返 null（缺省链兜底，不抛）', () => {
  const store = createPageStateStore({ pageStateDir })
  expect(store.read(DOC_UUID)).toBeNull()
  expect(store.exists(DOC_UUID)).toBe(false)
})

test('坏 JSON → read 返 null（腐烂即无，不抛）', () => {
  writeFileSync(join(pageStateDir, `${DOC_UUID}.json`), '{not-json}', 'utf8')
  const store = createPageStateStore({ pageStateDir })
  expect(store.read(DOC_UUID)).toBeNull()
})

test('形状坏 → read 返 null（缺字段 / 类型错 / 非对象）', () => {
  // 缺字段（仅 modeId）
  writeFileSync(join(pageStateDir, `${DOC_UUID}.json`), JSON.stringify({ modeId: 'm' }), 'utf8')
  expect(createPageStateStore({ pageStateDir }).read(DOC_UUID)).toBeNull()

  // 字段类型错（modeId 是 number）
  writeFileSync(
    join(pageStateDir, `${DOC_UUID}.json`),
    JSON.stringify({ modeId: 1, profileId: null, engagedPageId: null }),
    'utf8'
  )
  expect(createPageStateStore({ pageStateDir }).read(DOC_UUID)).toBeNull()

  // 非对象
  writeFileSync(join(pageStateDir, `${DOC_UUID}.json`), 'null', 'utf8')
  expect(createPageStateStore({ pageStateDir }).read(DOC_UUID)).toBeNull()

  // engagedPageId 是 boolean
  writeFileSync(
    join(pageStateDir, `${DOC_UUID}.json`),
    JSON.stringify({ modeId: 'm', profileId: 'p', engagedPageId: true }),
    'utf8'
  )
  expect(createPageStateStore({ pageStateDir }).read(DOC_UUID)).toBeNull()
})

test('正常形状 → read 返 PageState（返回对象隔断外部改写）', () => {
  writeFileSync(
    join(pageStateDir, `${DOC_UUID}.json`),
    JSON.stringify({ modeId: 'mode-a', profileId: 'profile-b', engagedPageId: 'page-1' }),
    'utf8'
  )
  const store = createPageStateStore({ pageStateDir })
  const got = store.read(DOC_UUID)
  expect(got).toEqual({ modeId: 'mode-a', profileId: 'profile-b', engagedPageId: 'page-1' })
  if (got) {
    ;(got as { modeId: string }).modeId = 'tampered'
  }
  expect(store.read(DOC_UUID)?.modeId).toBe('mode-a')
})

test('write patch 部分字段 → 未传字段保留旧值', () => {
  const store = createPageStateStore({ pageStateDir })
  store.write(DOC_UUID, { modeId: 'mode-a', profileId: 'profile-b', engagedPageId: 'page-1' })
  // 只改 engagedPageId
  const next = store.write(DOC_UUID, { engagedPageId: 'page-2' })
  expect(next).toEqual({ modeId: 'mode-a', profileId: 'profile-b', engagedPageId: 'page-2' })
  expect(store.read(DOC_UUID)).toEqual({
    modeId: 'mode-a',
    profileId: 'profile-b',
    engagedPageId: 'page-2'
  })
})

test('write 显式 null → 清空该字段（其他字段保留）', () => {
  const store = createPageStateStore({ pageStateDir })
  store.write(DOC_UUID, { modeId: 'mode-a', profileId: 'profile-b', engagedPageId: 'page-1' })
  // 清空 profileId
  const next = store.write(DOC_UUID, { profileId: null })
  expect(next).toEqual({ modeId: 'mode-a', profileId: null, engagedPageId: 'page-1' })
})

test('write 空 patch（{}） → 删文件（与 set(null) 同律）', () => {
  const store = createPageStateStore({ pageStateDir })
  store.write(DOC_UUID, { modeId: 'mode-a', profileId: null, engagedPageId: null })
  expect(store.exists(DOC_UUID)).toBe(true)
  const next = store.write(DOC_UUID, {})
  // 删后 read 返 null（腐烂即无），但 write 返回的 next 是「等显式删后」语义
  expect(next).toEqual({ modeId: null, profileId: null, engagedPageId: null })
  expect(store.exists(DOC_UUID)).toBe(false)
})

test('write 跨实例可读回（盘 + 缓存一致性）', () => {
  const storeA = createPageStateStore({ pageStateDir })
  storeA.write(DOC_UUID, { modeId: 'mode-a', profileId: 'profile-b', engagedPageId: 'page-1' })

  const storeB = createPageStateStore({ pageStateDir })
  expect(storeB.read(DOC_UUID)).toEqual({
    modeId: 'mode-a',
    profileId: 'profile-b',
    engagedPageId: 'page-1'
  })
})

test('进程外改文件 → 下次 read 即见新值（无缓存读穿盘）', () => {
  const store = createPageStateStore({ pageStateDir })
  store.write(DOC_UUID, { modeId: 'mode-a', profileId: null, engagedPageId: null })
  // 直接改盘（模拟另一进程写入——dev/打包版共享状态根的真实场景）
  writeFileSync(
    join(pageStateDir, `${DOC_UUID}.json`),
    JSON.stringify({ modeId: 'mode-b', profileId: 'p', engagedPageId: 'p2' }),
    'utf8'
  )
  expect(store.read(DOC_UUID)?.modeId).toBe('mode-b')
})

test('clear 删文件（文件本不存在 → no-op，不抛 ENOENT）', () => {
  const store = createPageStateStore({ pageStateDir })
  expect(store.exists(DOC_UUID)).toBe(false)
  store.clear(DOC_UUID)
  expect(store.exists(DOC_UUID)).toBe(false)
  // 写了再清
  store.write(DOC_UUID, { modeId: 'm', profileId: null, engagedPageId: null })
  expect(store.exists(DOC_UUID)).toBe(true)
  store.clear(DOC_UUID)
  expect(store.exists(DOC_UUID)).toBe(false)
})

test('首次 write（无旧文件） → 全字段按 patch 写入', () => {
  const store = createPageStateStore({ pageStateDir })
  const next = store.write(DOC_UUID, { modeId: 'mode-a', profileId: null, engagedPageId: 'page-1' })
  expect(next).toEqual({ modeId: 'mode-a', profileId: null, engagedPageId: 'page-1' })
  // 落盘形态 = 缩进 JSON + LF 收尾 + 0o600（与 design-assignment 同缝）
  const raw = JSON.parse(readFileSync(join(pageStateDir, `${DOC_UUID}.json`), 'utf8')) as {
    modeId?: unknown
  }
  expect(raw.modeId).toBe('mode-a')
})

test('docUuid 非法字符（路径分隔符 / 过长） → throw TypeError', () => {
  const store = createPageStateStore({ pageStateDir })
  // 含路径分隔符
  expect(() => store.read('../escape')).toThrow(TypeError)
  // 过长
  expect(() => store.read('a'.repeat(129))).toThrow(TypeError)
  // 空
  expect(() => store.write('', { modeId: 'm' })).toThrow(TypeError)
})

test('不同 docUuid 互不干扰（一文档一文件隔离）', () => {
  const store = createPageStateStore({ pageStateDir })
  store.write('doc-1', { modeId: 'mode-1', profileId: null, engagedPageId: null })
  store.write('doc-2', { modeId: 'mode-2', profileId: 'p-2', engagedPageId: 'page-2' })
  expect(store.read('doc-1')).toEqual({
    modeId: 'mode-1',
    profileId: null,
    engagedPageId: null
  })
  expect(store.read('doc-2')).toEqual({
    modeId: 'mode-2',
    profileId: 'p-2',
    engagedPageId: 'page-2'
  })
  expect(existsSync(join(pageStateDir, 'doc-1.json'))).toBe(true)
  expect(existsSync(join(pageStateDir, 'doc-2.json'))).toBe(true)
})
