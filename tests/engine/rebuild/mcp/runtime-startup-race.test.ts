import { expect, test } from 'bun:test'

import {
  type AutomationHealth,
  type AutomationServerHandle,
  createMCPRuntimeService,
  MCP_STARTUP_RETRY_DELAYS_MS,
  type MCPRuntimeDependencies
} from '@/app/bridge/runtime'

// T74：钉扎 dev 启动时序 race 的退避重试——vite configureServer 的 startChild
// 异步 spawn 桥子进程，WorkspaceView.onMounted 起跑 startMCPRuntime 时桥可能还没
// listen；无重试时编辑器永不 connectAutomation，桥永远 no_app（实证见
// docs/archive/rebuild-campaign/tasks/T74-plan.md §1）。本测试用注入的 sleep 让退避零延迟。

const HEALTH_OK: AutomationHealth = { status: 'ok', version: 'test' }

const noop = () => undefined

function createHandle(): AutomationServerHandle {
  return { disconnect: noop, authToken: null, managed: true }
}

interface RuntimeHarness {
  dependencies: MCPRuntimeDependencies
  spawnCalls: number
  readHealthCalls: number
  connectCalls: number
  sleeps: number[]
  failHealthTimes: number
}

function createHarness(failHealthTimes: number): RuntimeHarness {
  const harness: RuntimeHarness = {
    dependencies: {} as MCPRuntimeDependencies,
    spawnCalls: 0,
    readHealthCalls: 0,
    connectCalls: 0,
    sleeps: [],
    failHealthTimes
  }
  harness.dependencies = {
    spawn: async () => {
      harness.spawnCalls++
      return createHandle()
    },
    readHealth: async () => {
      harness.readHealthCalls++
      return harness.readHealthCalls <= failHealthTimes ? null : HEALTH_OK
    },
    canConnect: () => true,
    connect: () => {
      harness.connectCalls++
      return noop
    },
    sleep: async (ms) => {
      harness.sleeps.push(ms)
    }
  }
  return harness
}

// 与 tests/engine/app/bridge/mcp-runtime.test.ts 同款：never 可赋给任意返回类型
const getStore = () => ({}) as never

test('startup race: bridge slow to listen → retries until running', async () => {
  const harness = createHarness(2) // 前 2 次 readHealth 返回 null（桥慢起）
  const service = createMCPRuntimeService(harness.dependencies)

  const result = await service.start(getStore)

  expect(result.ok).toBe(true)
  expect(service.state.status).toBe('running')
  expect(service.state.version).toBe('test')
  expect(harness.spawnCalls).toBe(3)
  expect(harness.readHealthCalls).toBe(3)
  expect(harness.connectCalls).toBe(1)
  // 成功前的退避只有前两个间隔，成功即停
  expect(harness.sleeps).toEqual([200, 500])
})

test('startup race: bridge never healthy → error after exhausting retries', async () => {
  const harness = createHarness(Number.POSITIVE_INFINITY) // 全部失败
  const service = createMCPRuntimeService(harness.dependencies)

  const result = await service.start(getStore)

  expect(result.ok).toBe(false)
  expect(service.state.status).toBe('error')
  expect(service.state.error).toBe('Automation bridge did not become healthy')
  // 总尝试次数 = 1 + 重试间隔数
  expect(harness.spawnCalls).toBe(1 + MCP_STARTUP_RETRY_DELAYS_MS.length)
  expect(harness.connectCalls).toBe(0)
  expect(harness.sleeps).toEqual([...MCP_STARTUP_RETRY_DELAYS_MS])
})

test('startup retry delay sequence pinned', () => {
  expect([...MCP_STARTUP_RETRY_DELAYS_MS]).toEqual([200, 500, 1000, 2000, 4000])
})
