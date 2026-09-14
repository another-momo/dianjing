import { afterEach, describe, expect, test } from 'bun:test'

import {
  attachStderrPassthrough,
  makeReadyMarker,
  stopChildGracefully
} from '@/app/orchestration/lifecycle'

// 桩 ChildProcess——只模拟 stopChildGracefully / attachStderrPassthrough 关心的面。
// 禁 import node:events——本测试用手搓最小 fake 替代；TypeScript 结构类型天然满足
// Pick<ChildProcess,'stderr'|'kill'> 的形态契约。
// 真实 spawn 路径另由 child-ready.test.ts 覆盖，本单测聚焦骨架行为。

type StderrListener = (chunk: Buffer) => void

interface FakeStderr {
  handlers: StderrListener[]
  on(event: 'data', listener: StderrListener): void
  emit(chunk: Buffer): void
}

function createFakeStderr(): FakeStderr {
  const handlers: StderrListener[] = []
  return {
    handlers,
    on(_event, listener) {
      handlers.push(listener)
    },
    emit(chunk) {
      for (const h of handlers) h(chunk)
    }
  }
}

interface FakeChild {
  killed: string | undefined
  exitCodeValue: number | null
  stderr: FakeStderr
  kill(signal?: string): boolean
  simulateExit(code: number | null): void
}

function createFakeChild(): FakeChild {
  const state: { killed: string | undefined; exitCodeValue: number | null } = {
    killed: undefined,
    exitCodeValue: null
  }
  const stderr = createFakeStderr()
  return {
    get killed() {
      return state.killed
    },
    get exitCodeValue() {
      return state.exitCodeValue
    },
    get stderr() {
      return stderr
    },
    kill(signal) {
      state.killed = signal ?? 'SIGTERM'
      return true
    },
    simulateExit(code) {
      state.exitCodeValue = code
    }
  }
}

// stopChildGracefully 通过 `child.exitCode` getter 读取——FakeChild 不实现
// getter 即可（属性访问走 FakeChild 自身，与 ChildProcess.exitCode 命名一致）。
// attachStderrPassthrough 通过 `child.stderr.on('data', cb)` 监听；FakeChild
// 的 stderr 字段提供 on() 即可——结构类型满足 Pick<ChildProcess,'stderr'|'kill'>。

// stopChildGracefully 内的 hasExited 读 `child.exitCode !== null`，故需把
// exitCodeValue 暴露为可被外部读取（FakeChild 上 getter `exitCodeValue`）。
// 但 Pick<ChildProcess,'stderr'|'kill'> 没要求 exitCode 字段——为让 TS 类型
// 兼容，需另加 exitCode 字段（仅类型层面；运行时由 FakeChild 自身 closure 持状态）。
function asChildProcessShape(fake: FakeChild): {
  exitCode: number | null
  stderr: FakeStderr
  kill: (signal?: string) => boolean
} {
  return {
    get exitCode() {
      return fake.exitCodeValue
    },
    stderr: fake.stderr,
    kill: (signal) => fake.kill(signal)
  }
}

describe('orchestration/lifecycle', () => {
  describe('stopChildGracefully', () => {
    test('returns immediately when child is null', async () => {
      await stopChildGracefully(null)
    })

    test('returns immediately when child already exited', async () => {
      const fake = createFakeChild()
      fake.simulateExit(0)
      const child = asChildProcessShape(fake)
      await stopChildGracefully(child)
      expect(fake.killed).toBeUndefined()
    })

    test('sends SIGTERM (default kill) when child is alive and exits gracefully', async () => {
      const fake = createFakeChild()
      const child = asChildProcessShape(fake)
      // 让 SIGTERM 后 20ms 模拟退出（早于 timeoutMs=2000）
      setTimeout(() => fake.simulateExit(0), 20)
      await stopChildGracefully(child, { timeoutMs: 2000 })
      expect(fake.killed).toBe('SIGTERM')
    })

    test('escalates to SIGKILL when child does not exit within timeout', async () => {
      const fake = createFakeChild()
      const child = asChildProcessShape(fake)
      // 不 simulateExit——保持 alive 状态到超时，强制 SIGKILL
      // 用短 timeoutMs 避免单测慢：50ms timeout、50ms poll 间隔
      await stopChildGracefully(child, { timeoutMs: 50 })
      // 第一次 kill('SIGTERM') + 超时后 kill('SIGKILL')
      expect(fake.killed).toBe('SIGKILL')
    })
  })

  describe('makeReadyMarker', () => {
    test('prefix is open-pencil-ready:', () => {
      const marker = makeReadyMarker()
      expect(marker.startsWith('open-pencil-ready:')).toBe(true)
    })

    test('two markers differ (UUID v4 随机段)', () => {
      // marker 后缀是 randomUUID——同前缀不同 UUID；钉前缀以防漂移
      expect(makeReadyMarker()).not.toBe(makeReadyMarker())
    })
  })

  describe('attachStderrPassthrough', () => {
    let stderrChunks: string[]

    afterEach(() => {
      stderrChunks = []
    })

    function makeStubChild(): {
      fake: FakeChild
      child: FakeStderr & { kill: (signal?: string) => boolean }
    } {
      const fake = createFakeChild()
      const child = {
        stderr: fake.stderr,
        kill: (signal?: string) => fake.kill(signal)
      }
      return { fake, child }
    }

    test('passthrough writes data to process.stderr when no EADDRINUSE callback', () => {
      stderrChunks = []
      const original = process.stderr.write.bind(process.stderr)
      process.stderr.write = (chunk: string | Buffer): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
        return true
      }
      try {
        const { child } = makeStubChild()
        attachStderrPassthrough(child)
        child.stderr.emit(Buffer.from('hello\n'))
        expect(stderrChunks.join('')).toBe('hello\n')
      } finally {
        process.stderr.write = original
      }
    })

    test('invokes onEaddrinuse and skips passthrough when EADDRINUSE appears', () => {
      stderrChunks = []
      const original = process.stderr.write.bind(process.stderr)
      process.stderr.write = (chunk: string | Buffer): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
        return true
      }
      try {
        let callbackCalls = 0
        let receivedText = ''
        const { child } = makeStubChild()
        attachStderrPassthrough(child, {
          onEaddrinuse: (text) => {
            callbackCalls++
            receivedText = text
          }
        })
        child.stderr.emit(Buffer.from('Error: listen EADDRINUSE: address already in use :::7600\n'))
        expect(callbackCalls).toBe(1)
        expect(receivedText).toContain('EADDRINUSE')
        // 回调命中时不应透传
        expect(stderrChunks.join('')).toBe('')
      } finally {
        process.stderr.write = original
      }
    })
  })
})
