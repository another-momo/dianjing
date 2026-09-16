/**
 * 2026-09-16：design-assignment store 单测——
 * get 四态（缺文件 / 坏 JSON / 形状坏 / 正常）+ set 校验失败 throw +
 * set(null) 删文件 + 写盘后跨实例读回。
 *
 * 命名避开 service- 前缀——steiger prefer-domain-folders：≥3 个 service- 前缀
 * 兄弟文件触发 check:arch 红（service-abort / service-capabilities 既有两件）。
 * 设计指派后端 store 不是 service.ts 的方法暴露形态（与 capabilities 同源但
 * 是 settings 类持久化），命名按 store 自有身份（design-assignment.test.ts）。
 *
 * 测试 fixture：mkdtemp 建临时 agentDir；与 capabilities.test.ts 同源。
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDesignAssignmentStore } from '@/app/ai/pi-backend/design-assignment'

let agentDir = ''

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'design-assign-'))
})

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
})

test('缺文件 → get 返 null（无指派语义，不抛）', () => {
  const store = createDesignAssignmentStore({ agentDir })
  expect(store.get()).toBeNull()
  expect(store.exists()).toBe(false)
})

test('坏 JSON → get 返 null（腐烂即无指派，不抛）', () => {
  writeFileSync(join(agentDir, 'design-assignment.json'), '{not-json}', 'utf8')
  const store = createDesignAssignmentStore({ agentDir })
  expect(store.get()).toBeNull()
})

test('形状坏 → get 返 null（providerId 不符合 ^[a-z0-9-]+$ / 缺字段 / thinkingLevel 非法）', () => {
  // providerId 含非法字符
  writeFileSync(
    join(agentDir, 'design-assignment.json'),
    JSON.stringify({ providerId: 'BadId!', modelId: 'm1' }),
    'utf8'
  )
  expect(createDesignAssignmentStore({ agentDir }).get()).toBeNull()

  // 缺 modelId
  writeFileSync(
    join(agentDir, 'design-assignment.json'),
    JSON.stringify({ providerId: 'openrouter' }),
    'utf8'
  )
  expect(createDesignAssignmentStore({ agentDir }).get()).toBeNull()

  // thinkingLevel 非法字面量
  writeFileSync(
    join(agentDir, 'design-assignment.json'),
    JSON.stringify({ providerId: 'openrouter', modelId: 'm1', thinkingLevel: 'ultra' }),
    'utf8'
  )
  expect(createDesignAssignmentStore({ agentDir }).get()).toBeNull()

  // 非对象
  writeFileSync(join(agentDir, 'design-assignment.json'), 'null', 'utf8')
  expect(createDesignAssignmentStore({ agentDir }).get()).toBeNull()
})

test('正常形状 → get 返 PiModelSpec（深拷贝隔断缓存改写）', () => {
  writeFileSync(
    join(agentDir, 'design-assignment.json'),
    JSON.stringify({
      providerId: 'openrouter',
      modelId: 'openrouter/free',
      thinkingLevel: 'low'
    }),
    'utf8'
  )
  const store = createDesignAssignmentStore({ agentDir })
  const got = store.get()
  expect(got).toEqual({
    providerId: 'openrouter',
    modelId: 'openrouter/free',
    thinkingLevel: 'low'
  })
  // 深拷贝：改 got 不影响下次 get
  if (got) {
    ;(got as { providerId: string }).providerId = 'tampered'
  }
  expect(store.get()?.providerId).toBe('openrouter')
})

test('set 校验失败 throw TypeError（不写盘）', () => {
  const store = createDesignAssignmentStore({ agentDir })
  // providerId 不合法字符
  expect(() =>
    store.set({
      providerId: 'BadId!',
      modelId: 'm1'
    } as Partial<Parameters<typeof store.set>[0]> as Parameters<typeof store.set>[0])
  ).toThrow(TypeError)
  // 缺 modelId
  expect(() =>
    store.set({
      providerId: 'openrouter'
    } as Partial<Parameters<typeof store.set>[0]> as Parameters<typeof store.set>[0])
  ).toThrow(TypeError)
  // thinkingLevel 非法字面量
  expect(() =>
    store.set({
      providerId: 'openrouter',
      modelId: 'm1',
      thinkingLevel: 'ultra'
    } as Partial<Parameters<typeof store.set>[0]> as Parameters<typeof store.set>[0])
  ).toThrow(TypeError)
  // 没有任何副作用落盘
  expect(existsSync(join(agentDir, 'design-assignment.json'))).toBe(false)
})

test('set(null) 删文件；文件本不存在 → 不抛（existsSync 守卫）', () => {
  const store = createDesignAssignmentStore({ agentDir })
  expect(store.set(null)).toBeNull()
  expect(store.exists()).toBe(false)
  // 再调一次也安全（不抛 ENOENT）
  expect(store.set(null)).toBeNull()
})

test('set(非 null) 写盘 → 跨实例可读回（含 thinkingLevel + 不含 thinkingLevel 两态）', () => {
  // 含 thinkingLevel
  const store = createDesignAssignmentStore({ agentDir })
  const written = store.set({
    providerId: 'openrouter',
    modelId: 'openrouter/free',
    thinkingLevel: 'high'
  })
  expect(written).toEqual({
    providerId: 'openrouter',
    modelId: 'openrouter/free',
    thinkingLevel: 'high'
  })
  expect(store.exists()).toBe(true)
  const reread = createDesignAssignmentStore({ agentDir })
  expect(reread.get()).toEqual({
    providerId: 'openrouter',
    modelId: 'openrouter/free',
    thinkingLevel: 'high'
  })

  // 不含 thinkingLevel（'off' 不写字段，与 assignment.ts 序列化约定一致）
  const next = store.set({ providerId: 'openrouter', modelId: 'openrouter/free' })
  expect(next).toEqual({
    providerId: 'openrouter',
    modelId: 'openrouter/free'
  })
  expect('thinkingLevel' in (next as object)).toBe(false)
  const raw = JSON.parse(readFileSync(join(agentDir, 'design-assignment.json'), 'utf8')) as {
    thinkingLevel?: unknown
  }
  expect(raw.thinkingLevel).toBeUndefined()
})

test('reloadForTests 丢缓存：进程内改文件 + reload → 下次 get 读盘', () => {
  const store = createDesignAssignmentStore({ agentDir })
  store.set({ providerId: 'openrouter', modelId: 'm1' })
  // 直接改盘（模拟外部进程写入）
  writeFileSync(
    join(agentDir, 'design-assignment.json'),
    JSON.stringify({ providerId: 'anthropic', modelId: 'm2' }),
    'utf8'
  )
  // 缓存仍在 → 旧值
  expect(store.get()?.providerId).toBe('openrouter')
  store.reloadForTests()
  expect(store.get()?.providerId).toBe('anthropic')
})
