/* oxlint-disable open-pencil/no-module-mocking -- pi SDK/host 模块级桩（无 DI 缝）；DI 迁移评估挂 backlog */
/**
 * T87：GET/PUT /api/pi/capabilities 路由的 HTTP 往返。
 * T96：v2 形状（builtinTools 三档）+ PUT 三档校验 + 部分更新（缺省保留旧值）。
 *
 * 真 createPiBackendServer + mock pi-coding-agent（夹具同 chat-cancel-route）。
 * 覆盖：GET 缺省 DEFAULTS / PUT ON 落盘回读 / PUT 非布尔 400 / 方法白名单 /
 * 鉴权（无 token 401）。
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({
    session: {
      prompt: () => Promise.resolve(),
      subscribe: () => () => undefined,
      abort: () => Promise.resolve(),
      sessionManager: { getSessionFile: () => null }
    }
  }),
  DefaultResourceLoader: class {
    async reload(): Promise<void> {
      // eslint-disable-next-line no-promise-executor-return -- 同步桩返回
      return Promise.resolve() as Promise<void>
    }
  },
  SessionManager: {
    create: () => ({ getSessionFile: () => null }),
    open: () => ({ getSessionFile: () => null })
  },
  defineTool: (def: unknown) => def,
  // T91c 修复：mock.module 是 process 级（bun:test 语义），
  // 同批跑的 marketing/ask-user-question-roundtrip.test.ts 用 readPiHistoryFile
  // 依赖真 parseSessionEntries；stub 成 () => [] 会让 roundtrip 测试拿到空历史。
  // 这里用 SDK 同等语义的 15 行纯函数（JSONL 逐行 JSON.parse，容错 skip）。
  parseSessionEntries: (content: string): unknown[] => {
    const entries: unknown[] = []
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
        // oxlint-disable-next-line open-pencil/no-silent-catch -- 容错 skip 是 SDK 真语义：malformed 行静默跳过，非错误吞没
      } catch {
        // skip malformed
      }
    }
    return entries
  }
}))

import { createPiBackendServer } from '@/app/ai/pi-backend/server'

const TOKEN = 't87-cap-route-token'

let server: Server | null = null
let baseURL = ''
let rootDir = ''

async function boot(): Promise<void> {
  // 每测试独立 fresh rootDir：避免状态跨用例污染（capabilities.json 持久化）
  await teardown()
  rootDir = mkdtempSync(join(tmpdir(), 'pi-cap-route-'))
  mkdirSync(join(rootDir, 'pi-agent'), { recursive: true })
  const next = createPiBackendServer({ rootDir, authToken: TOKEN })
  await new Promise<void>((resolve) => {
    next.listen(0, '127.0.0.1', resolve)
  })
  const address = next.address()
  if (!address || typeof address === 'string') throw new Error('no ephemeral port')
  server = next
  baseURL = `http://127.0.0.1:${address.port}`
}

async function teardown(): Promise<void> {
  if (server) {
    const s = server
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
    })
    server = null
  }
  if (rootDir) {
    rmSync(rootDir, { recursive: true, force: true })
    rootDir = ''
  }
  baseURL = ''
}

afterAll(async () => {
  await teardown()
})

type CapabilitiesBody = { builtinTools: string; agentSkills: boolean; disabledSkills: string[] }

async function getCapabilities(): Promise<{ status: number; body: CapabilitiesBody }> {
  const res = await fetch(`${baseURL}/api/pi/capabilities`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  return { status: res.status, body: (await res.json()) as CapabilitiesBody }
}

async function putCapabilities(payload: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseURL}/api/pi/capabilities`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload)
  })
  return { status: res.status, body: await res.json() }
}

describe('GET/PUT /api/pi/capabilities（T87）', () => {
  beforeEach(async () => {
    await boot()
  })

  test('GET 缺省 DEFAULTS（2026-09-22 翻转 full+true）', async () => {
    const r = await getCapabilities()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
  })

  test('PUT ON → 落盘 + 后续 GET 返 ON（同实例）', async () => {
    const put = await putCapabilities({ agentSkills: true, builtinTools: 'full' })
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })

    const get1 = await getCapabilities()
    expect(get1.body).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })

    // 验证文件持久化：关闭 server，新 server 实例（同一 rootDir）应能读到 ON
    if (server) {
      const s = server
      await new Promise<void>((resolve) => {
        s.close(() => resolve())
      })
    }
    const next = createPiBackendServer({ rootDir, authToken: TOKEN })
    await new Promise<void>((resolve) => {
      next.listen(0, '127.0.0.1', resolve)
    })
    const address = next.address()
    server = next
    if (!address || typeof address === 'string') throw new Error('no ephemeral port')
    baseURL = `http://127.0.0.1:${address.port}`

    const get2 = await getCapabilities()
    expect(get2.body).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
  })

  test('PUT 非布尔 → 400（不动落盘）', async () => {
    const put1 = await putCapabilities({ agentSkills: 'yes' })
    expect(put1.status).toBe(400)
    const put2 = await putCapabilities({ agentSkills: 1 })
    expect(put2.status).toBe(400)
    const get = await getCapabilities()
    expect(get.body).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
  })

  test('T96 PUT 非法 builtinTools → 400（不动落盘）', async () => {
    const put1 = await putCapabilities({ agentSkills: true, builtinTools: 'everything' })
    expect(put1.status).toBe(400)
    const put2 = await putCapabilities({ agentSkills: true, builtinTools: 1 })
    expect(put2.status).toBe(400)
    const get = await getCapabilities()
    expect(get.body).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
  })

  test('T96 PUT 只给 agentSkills → builtinTools 保留旧值（部分更新）', async () => {
    const put1 = await putCapabilities({ agentSkills: true, builtinTools: 'readonly' })
    expect(put1.status).toBe(200)
    const put2 = await putCapabilities({ agentSkills: false })
    expect(put2.status).toBe(200)
    expect(put2.body).toEqual({ builtinTools: 'readonly', agentSkills: false, disabledSkills: [] })
    const get = await getCapabilities()
    expect(get.body).toEqual({ builtinTools: 'readonly', agentSkills: false, disabledSkills: [] })
  })

  test('PUT OFF → 关闭后 skills=[]（listSkills 守门）', async () => {
    await putCapabilities({ agentSkills: false })
    const get = await getCapabilities()
    // builtinTools 缺省保留旧值（缺省 'full'）；agentSkills 显式 false
    expect(get.body).toEqual({ builtinTools: 'full', agentSkills: false, disabledSkills: [] })
  })

  test('POST/DELETE → 405（方法白名单）', async () => {
    const post = await fetch(`${baseURL}/api/pi/capabilities`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(post.status).toBe(405)
    const del = await fetch(`${baseURL}/api/pi/capabilities`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(del.status).toBe(405)
  })

  test('无 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/capabilities`)
    expect(res.status).toBe(401)
  })

  test('带错 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/capabilities`, {
      headers: { authorization: 'Bearer wrong-token' }
    })
    expect(res.status).toBe(401)
  })

  test('PUT 坏 JSON → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/capabilities`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not-json'
    })
    expect(res.status).toBe(400)
  })

  test('manifest 端点同时透传 capabilities + skills', async () => {
    const res = await fetch(`${baseURL}/api/pi/studio/manifest`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { capabilities?: unknown; skills?: unknown }
    expect(body.capabilities).toEqual({
      builtinTools: 'full',
      agentSkills: true,
      disabledSkills: []
    })
    expect(body.skills).toEqual([])
  })
})

describe('GET /api/pi/skills（管理面全量清单）', () => {
  beforeEach(async () => {
    await boot()
  })

  test('GET 形状：{ skills: ManagedSkillEntry[] }，含 source + enabled 字段', async () => {
    // 在 rootDir/workspace/.agents/skills/<name>/SKILL.md 造一个 skill
    const skillDir = join(rootDir, 'workspace', '.agents', 'skills', 'route-skill')
    mkdirSync(skillDir, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: route-skill\ndescription: 路由测试用\n---\n\n正文\n`,
      'utf8'
    )

    const res = await fetch(`${baseURL}/api/pi/skills`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      skills: Array<{ name: string; description: string; source: string; enabled: boolean }>
    }
    const found = body.skills.find((s) => s.name === 'route-skill')
    expect(found).toBeDefined()
    expect(found?.source).toBe('user')
    expect(found?.enabled).toBe(true)
    // 脱敏：仅 name + description + source + enabled（无 filePath / baseDir）
    expect(Object.keys(found ?? {}).sort()).toEqual(['description', 'enabled', 'name', 'source'])
  })

  test('GET 不受 agentSkills 总闸影响（总闸 OFF 时仍返全量含被禁件）', async () => {
    const skillDir = join(rootDir, 'workspace', '.agents', 'skills', 'off-skill')
    mkdirSync(skillDir, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: off-skill\ndescription: 总闸测试\n---\n\n正文\n`,
      'utf8'
    )

    // 关闭 agentSkills 总闸
    await fetch(`${baseURL}/api/pi/capabilities`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agentSkills: false })
    })

    const res = await fetch(`${baseURL}/api/pi/skills`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { skills: Array<{ name: string }> }
    // 管理面不受总闸影响——off-skill 仍可见
    expect(body.skills.find((s) => s.name === 'off-skill')).toBeDefined()
  })

  test('GET 含被禁件（enabled=false 反映 disabledSkills）', async () => {
    const skillDir = join(rootDir, 'workspace', '.agents', 'skills', 'to-disable')
    mkdirSync(skillDir, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: to-disable\ndescription: 将被禁\n---\n\n正文\n`,
      'utf8'
    )

    // 写 disabledSkills
    await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ disabled: ['to-disable'] })
    })

    const res = await fetch(`${baseURL}/api/pi/skills`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const body = (await res.json()) as {
      skills: Array<{ name: string; enabled: boolean }>
    }
    const found = body.skills.find((s) => s.name === 'to-disable')
    expect(found?.enabled).toBe(false)
  })

  test('GET POST/DELETE → 405（方法白名单）', async () => {
    const post = await fetch(`${baseURL}/api/pi/skills`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(post.status).toBe(405)
    const del = await fetch(`${baseURL}/api/pi/skills`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(del.status).toBe(405)
  })

  test('GET 无 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/skills`)
    expect(res.status).toBe(401)
  })
})

describe('PUT /api/pi/skills/disabled（管理面单件启停）', () => {
  beforeEach(async () => {
    await boot()
  })

  test('PUT roundtrip：写 → GET 返新集合；持久化层跟随', async () => {
    const put1 = await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ disabled: ['alpha', 'beta'] })
    })
    expect(put1.status).toBe(200)
    expect((await put1.json()) as { disabled: string[] }).toEqual({
      disabled: ['alpha', 'beta']
    })

    const get = await fetch(`${baseURL}/api/pi/skills`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect((await get.json()) as { skills: Array<{ name: string }> }).toEqual({
      skills: [],
      diagnostics: []
    })

    // 验证文件持久化：关闭 server，新 server 实例应能恢复 disabled 集合
    if (server) {
      const s = server
      await new Promise<void>((resolve) => {
        s.close(() => resolve())
      })
    }
    const next = createPiBackendServer({ rootDir, authToken: TOKEN })
    await new Promise<void>((resolve) => {
      next.listen(0, '127.0.0.1', resolve)
    })
    const address = next.address()
    server = next
    if (!address || typeof address === 'string') throw new Error('no ephemeral port')
    baseURL = `http://127.0.0.1:${address.port}`

    // capabilities GET 应反映 disabledSkills（v3 形状落盘）
    const capGet = await fetch(`${baseURL}/api/pi/capabilities`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect((await capGet.json()) as { disabledSkills: string[] }).toEqual({
      builtinTools: 'full',
      agentSkills: true,
      disabledSkills: ['alpha', 'beta']
    })
  })

  test('PUT 非数组 → 400（不动落盘）', async () => {
    const put1 = await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ disabled: 'not-array' })
    })
    expect(put1.status).toBe(400)
    const put2 = await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ disabled: null })
    })
    expect(put2.status).toBe(400)
  })

  test('PUT 后端归一去重保序', async () => {
    const put = await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ disabled: ['b', 'a', 'b', 'c', 'a'] })
    })
    expect(put.status).toBe(200)
    expect((await put.json()) as { disabled: string[] }).toEqual({
      disabled: ['b', 'a', 'c']
    })
  })

  test('PUT 不校验名字存在性（负向韧性：被禁名对应 skill 卸载后再装回保持禁用）', async () => {
    const put = await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ disabled: ['never-installed-skill'] })
    })
    expect(put.status).toBe(200)
    expect((await put.json()) as { disabled: string[] }).toEqual({
      disabled: ['never-installed-skill']
    })
  })

  test('PUT 不影响 builtinTools / agentSkills', async () => {
    // 先写非默认档位
    await fetch(`${baseURL}/api/pi/capabilities`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ agentSkills: true, builtinTools: 'readonly' })
    })
    // 再写 disabledSkills
    await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ disabled: ['a'] })
    })
    // capabilities 应保留 readonly 档位
    const get = await fetch(`${baseURL}/api/pi/capabilities`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect((await get.json()) as { builtinTools: string; disabledSkills: string[] }).toEqual({
      builtinTools: 'readonly',
      agentSkills: true,
      disabledSkills: ['a']
    })
  })

  test('GET → 405（方法白名单）', async () => {
    const res = await fetch(`${baseURL}/api/pi/skills/disabled`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(405)
  })

  test('PUT 无 token → 401', async () => {
    const res = await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: [] })
    })
    expect(res.status).toBe(401)
  })

  test('PUT 坏 JSON → 400', async () => {
    const res = await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not-json'
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/pi/skills diagnostics 字段（批 B）', () => {
  beforeEach(async () => {
    await boot()
  })

  test('GET 响应新增 diagnostics 字段（空数组起步）', async () => {
    const res = await fetch(`${baseURL}/api/pi/skills`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      skills: unknown[]
      diagnostics: Array<{ code: string }>
    }
    expect(Array.isArray(body.diagnostics)).toBe(true)
    expect(body.diagnostics).toEqual([])
  })

  test('有坏 skill 时 diagnostics 触发 parse-failed 条目', async () => {
    // 造一个缺 SKILL.md 的子目录
    const skillDir = join(rootDir, 'workspace', '.agents', 'skills', 'broken-skill')
    mkdirSync(skillDir, { recursive: true })

    const res = await fetch(`${baseURL}/api/pi/skills`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const body = (await res.json()) as {
      diagnostics: Array<{ code: string; skillName?: string }>
    }
    expect(body.diagnostics.some((d) => d.code === 'parse-failed' && d.skillName === 'broken-skill')).toBe(
      true
    )
  })

  test('diagnostics 字段为可空数组（与既有 shape 测试兼容：skills 字段不变）', async () => {
    const res = await fetch(`${baseURL}/api/pi/skills`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const body = (await res.json()) as { skills: unknown[]; diagnostics: unknown[] }
    expect(Object.keys(body).sort()).toEqual(['diagnostics', 'skills'])
  })
})

describe('POST /api/pi/skills/delete（批 B 分层删除）', () => {
  beforeEach(async () => {
    await boot()
  })

  test('用户层命中 → 200 {deleted: name}；磁盘目录被删除；后续 GET 不再列出', async () => {
    const skillDir = join(rootDir, 'workspace', '.agents', 'skills', 'doomed')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: doomed\ndescription: x\n---\n\n正文\n',
      'utf8'
    )

    const post = await fetch(`${baseURL}/api/pi/skills/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: 'doomed' })
    })
    expect(post.status).toBe(200)
    expect((await post.json()) as { deleted: string }).toEqual({ deleted: 'doomed' })

    // 磁盘目录已删
    expect(existsSync(skillDir)).toBe(false)

    // 后续 GET 不再列出
    const get = await fetch(`${baseURL}/api/pi/skills`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const body = (await get.json()) as { skills: Array<{ name: string }> }
    expect(body.skills.find((s) => s.name === 'doomed')).toBeUndefined()
  })

  test('name 不存在 → 404 {error}', async () => {
    const post = await fetch(`${baseURL}/api/pi/skills/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: 'never-installed' })
    })
    expect(post.status).toBe(404)
    const body = (await post.json()) as { error: string }
    expect(typeof body.error).toBe('string')
  })

  // 内置件 → 403（SkillBuiltinProtectedError）在 capabilities store 层覆盖：
  // createPiBackendServer 不暴露 builtinSkillsDir 注入，路由层构造不出内置件场景。

  test('body 缺 name → 400', async () => {
    const post = await fetch(`${baseURL}/api/pi/skills/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({})
    })
    expect(post.status).toBe(400)
  })

  test('name 空字符串 → 400', async () => {
    const post = await fetch(`${baseURL}/api/pi/skills/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: '' })
    })
    expect(post.status).toBe(400)
  })

  test('坏 JSON → 400', async () => {
    const post = await fetch(`${baseURL}/api/pi/skills/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: '{not-json'
    })
    expect(post.status).toBe(400)
  })

  test('DELETE / GET 方法 → 405', async () => {
    const del = await fetch(`${baseURL}/api/pi/skills/delete`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(del.status).toBe(405)
    const get = await fetch(`${baseURL}/api/pi/skills/delete`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(get.status).toBe(405)
  })

  test('无 token → 401', async () => {
    const post = await fetch(`${baseURL}/api/pi/skills/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'doomed' })
    })
    expect(post.status).toBe(401)
  })

  test('delete 不动 disabledSkills（重装回来仍处停用态）', async () => {
    const skillDir = join(rootDir, 'workspace', '.agents', 'skills', 'disabled-then-delete')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: disabled-then-delete\ndescription: x\n---\n\n正文\n',
      'utf8'
    )

    await fetch(`${baseURL}/api/pi/skills/disabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ disabled: ['disabled-then-delete'] })
    })

    await fetch(`${baseURL}/api/pi/skills/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: 'disabled-then-delete' })
    })

    const capGet = await fetch(`${baseURL}/api/pi/capabilities`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const caps = (await capGet.json()) as { disabledSkills: string[] }
    expect(caps.disabledSkills).toContain('disabled-then-delete')
  })
})
