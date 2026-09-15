/**
 * 2026-09-16 凭据守卫 A 案 tool_call handler 钉扎。
 *
 * 与 ask/pending-guard 同构：handler 与 extension 分离导出，测试直钉 handler
 * （免 ExtensionAPI 桩件与类型断言）。fixture = 纯字符串路径运算（无真实 IO），
 * homeDir 注入 root（好测 ~ 展开命中凭据的情形）。
 *
 * 覆盖 17 用例：read 4 件 + 5 关键放行 + edit/write + grep 6 形态 + ls/find/bash/custom + 非 string path。
 */

import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'

import { createKeyGuardHandler, protectedCredentialFiles } from '@/app/ai/pi-backend/key-guard'

// fixture 用 resolve 把假根钉成真绝对路径——resolve 在 Win/mac/linux 都带系统正确
// 前缀（Windows 加盘符，POSIX 保留 /），与 handler 内 isAbsolute→resolve 路径
// 同根，归一化形态可比对。纯字符串运算不需真建目录。
const ROOT = resolve('/fake/kg-root')
const WORKSPACE = resolve(ROOT, 'workspace')
const AGENT_DIR = resolve(ROOT, 'pi-agent')
const AUTH_JSON = resolve(AGENT_DIR, 'auth.json')
const IMAGE_GEN_JSON = resolve(AGENT_DIR, 'image-gen.json')
const KEY_ENV = resolve(ROOT, 'key-env')
const PI_BACKEND_TOKEN = resolve(ROOT, 'pi-backend-token')

const READ_DENY_REASON =
  'Access denied: this path stores API credentials/tokens and is protected from agent access. ' +
  'Do not read, search, or infer credential files — if credentials need inspection or changes, direct the user to the Settings panel.'

const WRITE_DENY_REASON =
  'Access denied: this path stores API credentials/tokens and is protected from agent writes. ' +
  'Credential updates go through the Settings panel (credential routes) only.'

function makeHandler() {
  return createKeyGuardHandler({ rootDir: ROOT, cwd: WORKSPACE, homeDir: ROOT })
}

describe('protectedCredentialFiles', () => {
  test('四件绝对路径单源——与 paths.ts resolver 同根', () => {
    expect(protectedCredentialFiles(ROOT)).toEqual([
      KEY_ENV,
      PI_BACKEND_TOKEN,
      AUTH_JSON,
      IMAGE_GEN_JSON
    ])
  })
})

describe('createKeyGuardHandler — read / edit / write 路径守卫', () => {
  test('read 绝对路径 auth.json → block（READ reason）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: AUTH_JSON } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('read ../pi-agent/auth.json（cwd=workspace）→ block（向上解析命中凭据）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: '../pi-agent/auth.json' } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('read pi-agent/auth.json 相对（resolve 进 workspace/pi-agent/auth.json）→ 放行', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: 'pi-agent/auth.json' } })).toBeUndefined()
  })

  test('read 混合大小写+反斜杠（<ROOT>\\Pi-Agent\\AUTH.JSON）→ block（归一化吃下）', () => {
    const handler = makeHandler()
    const mixed = ROOT.replaceAll('/', '\\') + '\\Pi-Agent\\AUTH.JSON'
    expect(handler({ toolName: 'read', input: { path: mixed } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('read 绝对 key-env / pi-backend-token / pi-agent/image-gen.json → 各 block', () => {
    const handler = makeHandler()
    for (const target of [KEY_ENV, PI_BACKEND_TOKEN, IMAGE_GEN_JSON]) {
      expect(handler({ toolName: 'read', input: { path: target } })).toEqual({
        block: true,
        reason: READ_DENY_REASON
      })
    }
  })

  test('read 绝对 studio/base.md → 放行（非凭据文件）', () => {
    const handler = makeHandler()
    const baseMd = join(ROOT, 'studio', 'base.md')
    expect(handler({ toolName: 'read', input: { path: baseMd } })).toBeUndefined()
  })

  test('read ~/pi-agent/auth.json（homeDir=root）→ block（~ 展开命中）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: '~/pi-agent/auth.json' } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('edit 绝对 auth.json / write 绝对 key-env → block（WRITE reason）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'edit', input: { path: AUTH_JSON } })).toEqual({
      block: true,
      reason: WRITE_DENY_REASON
    })
    expect(handler({ toolName: 'write', input: { path: KEY_ENV } })).toEqual({
      block: true,
      reason: WRITE_DENY_REASON
    })
  })
})

describe('createKeyGuardHandler — grep 搜索根守卫', () => {
  test('grep 无 path（cwd=workspace 不含凭据）→ 放行', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'foo' } })).toBeUndefined()
  })

  test('grep path 绝对 pi-agent 目录 → block（祖先含凭据文件）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'foo', path: AGENT_DIR } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('grep path 绝对 rootDir → block（祖先目录）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'foo', path: ROOT } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('grep path 绝对 auth.json 文件本身 → block（自身）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'foo', path: AUTH_JSON } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('grep path 绝对 studio 目录 → 放行（不含凭据文件后代）', () => {
    const handler = makeHandler()
    const studioDir = join(ROOT, 'studio')
    expect(
      handler({ toolName: 'grep', input: { pattern: 'foo', path: studioDir } })
    ).toBeUndefined()
  })
})

describe('createKeyGuardHandler — 不防面（决策依据见 key-guard.ts 头注）', () => {
  test('ls path 即便指向 rootDir → 放行（输出仅文件名）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'ls', input: { path: ROOT } })).toBeUndefined()
  })

  test('find path 即便指向 rootDir → 放行（输出仅文件名）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'find', input: { path: ROOT } })).toBeUndefined()
  })

  test('bash input.command = "cat pi-agent/auth.json" → 放行（D 案挂起不拦）', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'bash', input: { command: 'cat pi-agent/auth.json' } })
    ).toBeUndefined()
  })

  test('custom 工具 toolName "render" → 放行', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'render', input: { path: AUTH_JSON } })).toBeUndefined()
  })

  test('read 但 input.path 非 string（缺参）→ 放行（SDK schema 自会拒）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: {} })).toBeUndefined()
    expect(handler({ toolName: 'read', input: { path: 42 } })).toBeUndefined()
  })
})
