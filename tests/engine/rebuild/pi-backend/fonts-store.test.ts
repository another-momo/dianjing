/**
 * 字体库存储层真实落盘测试（createFontsStore + 临时目录）。
 *
 * 覆盖：
 *  - installBytes → 字节落盘 + manifest 落盘回读一致（Windows 路径 mkdir 回归钉扎：
 *    哈希前缀子目录必须真实创建，writeFileSync 不落 ENOENT）
 *  - readBytes 按 hash+ext 回读字节一致
 *  - 同 (family, key) 换装不同字节 → 旧哈希字节被清（不留孤儿文件）
 *  - deleteStyle → 字节文件与 manifest 条目同删
 *  - deleteFamily → 整族字节清空 + manifest 族条目消失
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StyleEntry } from '@open-pencil/core/text/font/installed/manifest'

import { createFontsStore } from '@/app/ai/pi-backend/fonts/store'

function makeStyle(key: string, hash: string, size: number): StyleEntry {
  return {
    key,
    weight: 400,
    italic: false,
    variable: false,
    hash,
    ext: 'otf',
    size,
    artifact: 'full',
    source: 'local-file',
    installedAt: Date.now()
  }
}

function freshStore() {
  const rootDir = mkdtempSync(join(tmpdir(), 'fonts-store-'))
  return createFontsStore({ rootDir })
}

describe('createFontsStore 真实落盘', () => {
  test('installBytes 写字节 + manifest，readBytes 回读一致', () => {
    const store = freshStore()
    const bytes = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 1, 2, 3, 4])
    const hash = store.hashBytes(bytes)
    const result = store.installBytes({
      bytes,
      ext: 'otf',
      style: makeStyle('Regular', hash, bytes.byteLength),
      family: 'Test Family',
      artifact: 'full'
    })
    expect(result.hash).toBe(hash)

    const back = store.readBytes(hash, 'otf')
    expect(back).not.toBeNull()
    expect(Array.from(back!)).toEqual(Array.from(bytes))

    const manifest = store.readManifest()
    const family = manifest.families.find((f) => f.family === 'Test Family')
    expect(family?.styles.map((s) => s.key)).toEqual(['Regular'])
  })

  test('同 key 换装不同字节：新字节可读、旧哈希文件被清', () => {
    const store = freshStore()
    const bytesV1 = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 1])
    const bytesV2 = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 2, 2])
    const hashV1 = store.hashBytes(bytesV1)
    const hashV2 = store.hashBytes(bytesV2)

    store.installBytes({
      bytes: bytesV1,
      ext: 'otf',
      style: makeStyle('Regular', hashV1, bytesV1.byteLength),
      family: 'Test Family',
      artifact: 'full'
    })
    store.installBytes({
      bytes: bytesV2,
      ext: 'otf',
      style: makeStyle('Regular', hashV2, bytesV2.byteLength),
      family: 'Test Family',
      artifact: 'full'
    })

    expect(store.readBytes(hashV2, 'otf')).not.toBeNull()
    expect(store.readBytes(hashV1, 'otf')).toBeNull()
    const family = store.readManifest().families.find((f) => f.family === 'Test Family')
    expect(family?.styles).toHaveLength(1)
    expect(family?.styles[0].hash).toBe(hashV2)
  })

  test('deleteStyle 删字节与 manifest 条目', () => {
    const store = freshStore()
    const bytes = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 9])
    const hash = store.hashBytes(bytes)
    store.installBytes({
      bytes,
      ext: 'otf',
      style: makeStyle('Regular', hash, bytes.byteLength),
      family: 'Test Family',
      artifact: 'full'
    })

    const result = store.deleteStyle('Test Family', 'Regular')
    expect(result.removed).toBe(true)
    expect(store.readBytes(hash, 'otf')).toBeNull()
    expect(store.readManifest().families.find((f) => f.family === 'Test Family')).toBeUndefined()
  })

  test('deleteFamily 清空整族字节与 manifest 条目', () => {
    const store = freshStore()
    const bytesA = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 1])
    const bytesB = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 2])
    const hashA = store.hashBytes(bytesA)
    const hashB = store.hashBytes(bytesB)
    store.installBytes({
      bytes: bytesA,
      ext: 'otf',
      style: makeStyle('Regular', hashA, bytesA.byteLength),
      family: 'Test Family',
      artifact: 'full'
    })
    store.installBytes({
      bytes: bytesB,
      ext: 'otf',
      style: makeStyle('Bold', hashB, bytesB.byteLength),
      family: 'Test Family',
      artifact: 'full'
    })

    const result = store.deleteFamily('Test Family')
    expect(result.removed).toBe(true)
    expect(store.readBytes(hashA, 'otf')).toBeNull()
    expect(store.readBytes(hashB, 'otf')).toBeNull()
    expect(store.readManifest().families).toHaveLength(0)
  })
})
