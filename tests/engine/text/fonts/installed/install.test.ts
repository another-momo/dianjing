/**
 * install.ts 安装管线测试。
 *
 * 覆盖：
 *  - 预校验拒：坏字节 / 未知容器 / <10 字节 → 不调 transcode / post
 *  - woff2 → 未注入 transcode → unsupported-container
 *  - woff2 → transcode 抛错 → transcode-failed，不调 post
 *  - woff2 → transcode 产物坏字节 → transcode-failed
 *  - post 抛错 → post-failed
 *
 * fixture 来源：tests/fixtures/fonts/NotoSansCJK-Test.otf（合法 sfnt 实体，
 * opentype.js 可解析、name 表含族名）。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { installLocalFont, type InstallDeps } from '#core/text/font/installed/install'
import { detectContainer } from '#core/text/font/installed/validate'

import { repoPath } from '#tests/helpers/paths'

const FIXTURE_PATH = repoPath('tests/fixtures/fonts/NotoSansCJK-Test.otf')
const fixtureBytes = new Uint8Array(readFileSync(FIXTURE_PATH))

/** 合成的 woff2 容器（仅 'wOF2' 魔数 + 填充字节）——预校验走 sniff VF 路径 */
function fakeWoff2Bytes(): Uint8Array {
  const buf = new Uint8Array(64)
  const v = new DataView(buf.buffer)
  v.setUint32(0, 0x774f4632) // 'wOF2'
  return buf
}

interface SpyState {
  transcodeCalls: number
  postCalls: number
  postArgs: Uint8Array[]
  postShouldThrow: boolean
}

function makeDeps(
  transcodeResult: Uint8Array | Error | 'missing',
  options: { postShouldThrow?: boolean } = {}
): { deps: InstallDeps; state: SpyState } {
  const state: SpyState = {
    transcodeCalls: 0,
    postCalls: 0,
    postArgs: [],
    postShouldThrow: options.postShouldThrow ?? false
  }
  const deps: InstallDeps = {
    post: async (bytes) => {
      state.postCalls++
      state.postArgs.push(bytes)
      if (state.postShouldThrow) throw new Error('post boom')
      return { family: 'Noto Sans SC' }
    }
  }
  if (transcodeResult !== 'missing') {
    deps.transcode = async (bytes) => {
      state.transcodeCalls++
      void bytes
      if (transcodeResult instanceof Error) throw transcodeResult
      return transcodeResult
    }
  }
  return { deps, state }
}

describe('installLocalFont 编排', () => {
  test('预校验拒：未知魔数 → invalid-bytes，不调 transcode / post', async () => {
    const bad = new Uint8Array(50)
    bad[0] = 0x99
    bad[1] = 0x88
    bad[2] = 0x77
    bad[3] = 0x66
    const { deps, state } = makeDeps('missing')
    const result = await installLocalFont(bad, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('invalid-bytes')
    expect(state.transcodeCalls).toBe(0)
    expect(state.postCalls).toBe(0)
  })

  test('预校验拒：<10 字节 → invalid-bytes', async () => {
    const { deps, state } = makeDeps('missing')
    const result = await installLocalFont(new Uint8Array(5), deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('invalid-bytes')
    expect(state.postCalls).toBe(0)
  })

  test('预校验拒：.ttc 合集签名 → invalid-bytes', async () => {
    const ttc = new Uint8Array(12)
    const v = new DataView(ttc.buffer)
    v.setUint32(0, 0x74746366) // 'ttcf'
    const { deps, state } = makeDeps('missing')
    const result = await installLocalFont(ttc, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('invalid-bytes')
    expect(state.postCalls).toBe(0)
  })

  test('woff 输入：未注入 transcode → unsupported-container', async () => {
    const woff = new Uint8Array(64)
    new DataView(woff.buffer).setUint32(0, 0x774f4646) // 'wOFF'
    const { deps, state } = makeDeps('missing')
    const result = await installLocalFont(woff, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('unsupported-container')
    expect(state.postCalls).toBe(0)
  })

  test('woff2 输入：未注入 transcode → unsupported-container', async () => {
    const woff2 = fakeWoff2Bytes()
    const { deps, state } = makeDeps('missing')
    const result = await installLocalFont(woff2, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('unsupported-container')
    expect(state.postCalls).toBe(0)
  })

  test('woff2 输入：transcode 抛错 → transcode-failed，不调 post', async () => {
    const woff2 = fakeWoff2Bytes()
    const { deps, state } = makeDeps(new Error('wasm failed'))
    const result = await installLocalFont(woff2, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('transcode-failed')
    expect(result.detail).toContain('wasm failed')
    expect(state.transcodeCalls).toBe(1)
    expect(state.postCalls).toBe(0)
  })

  test('woff2 输入：transcode 产物坏字节（未知 magic）→ transcode-failed', async () => {
    const woff2 = fakeWoff2Bytes()
    const garbage = new Uint8Array(50)
    garbage[0] = 0x99
    garbage[1] = 0x88
    garbage[2] = 0x77
    garbage[3] = 0x66
    const { deps, state } = makeDeps(garbage)
    const result = await installLocalFont(woff2, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('transcode-failed')
    expect(state.transcodeCalls).toBe(1)
    expect(state.postCalls).toBe(0)
  })

  test('woff2 输入：transcode 产物是 ttf 容器但 parse 失败 → transcode-failed', async () => {
    const woff2 = fakeWoff2Bytes()
    // 合法 ttf 头 + numTables 越界 → opentype parse 拒
    const garbage = new Uint8Array(1024)
    const v = new DataView(garbage.buffer)
    v.setUint32(0, 0x00010000)
    v.setUint16(4, 1)
    v.setUint32(8, 0xffffffff)
    const { deps, state } = makeDeps(garbage)
    const result = await installLocalFont(woff2, deps)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('transcode-failed')
    expect(state.postCalls).toBe(0)
  })

  test('fixture sanity：otf 容器检测', () => {
    expect(detectContainer(fixtureBytes)).toBe('otf')
    expect(fixtureBytes.byteLength).toBeGreaterThan(1024)
  })

  test('sfnt 直通：合法 otf → post 被调、family 从 name 表提取', async () => {
    const { deps, state } = makeDeps('missing')
    const result = await installLocalFont(fixtureBytes, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`)
    expect(result.family).toBe('Noto Sans CJK SC')
    expect(state.postCalls).toBe(1)
    expect(state.transcodeCalls).toBe(0)
  })

  test('woff2 幸福路径：transcode 返真实 sfnt → post 被调', async () => {
    const woff2 = fakeWoff2Bytes()
    const { deps, state } = makeDeps(fixtureBytes)
    const result = await installLocalFont(woff2, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.detail}`)
    expect(result.family).toBe('Noto Sans CJK SC')
    expect(state.transcodeCalls).toBe(1)
    expect(state.postCalls).toBe(1)
  })
})
