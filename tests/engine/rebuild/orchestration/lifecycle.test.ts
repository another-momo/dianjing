import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import {
  attachStderrPassthrough,
  makeReadyMarker,
  stopChildGracefully
} from '@/app/orchestration/lifecycle'

// 桩 ChildProcess——只模拟 stopChildGracefully 关心的面（exitCode / kill）。
// 真实 spawn 路径另由 child-ready.test.ts 覆盖，本单测聚焦骨架行为。
class StubChild extends EventEmitter {
  killed: string | undefined
  exitCodeValue: number | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 桩类型刻意收紧
  stderrEmitter: any = null

  get exitCode(): number | null {
    return this.exitCodeValue
  }

  override kill(signal?: string): boolean {
    this.killed = signal ?? 'SIGTERM'
    return true
  }

  simulateExit(code: number | null): void {
    this.exitCodeValue = code
    this.emit('exit', code)
  }
}

describe('orchestration/lifecycle', () => {
  describe('stopChildGracefully', () => {
    test('returns immediately when child is null', async () => {
      await stopChildGracefully(null)
    })

    test('returns immediately when child already exited', async () => {
      const child = new StubChild()
      child.simulateExit(0)
      await stopChildGracefully(child)
      expect(child.killed).toBeUndefined()
    })

    test('sends SIGTERM (default kill) when child is alive and exits gracefully', async () => {
      const child = new StubChild()
      // 让 SIGTERM 后 20ms 模拟退出（早于 timeoutMs=2000）
      setTimeout(() => child.simulateExit(0), 20)
      await stopChildGracefully(child, { timeoutMs: 2000 })
      expect(child.killed).toBe('SIGTERM')
    })

    test('escalates to SIGKILL when child does not exit within timeout', async () => {
      const child = new StubChild()
      // 不 simulateExit——保持 alive 状态到超时，强制 SIGKILL
      // 用短 timeoutMs 避免单测慢：50ms timeout、50ms poll 间隔
      await stopChildGracefully(child, { timeoutMs: 50 })
      // 第一次 kill('SIGTERM') + 超时后 kill('SIGKILL')
      expect(child.killed).toBe('SIGKILL')
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

    function makeStubChild(): StubChild {
      const child = new StubChild()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 桩类型刻意收紧
      child.stderrEmitter = new EventEmitter()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 桩类型刻意收紧
      child.stderr = child.stderrEmitter
      return child
    }

    test('passthrough writes data to process.stderr when no EADDRINUSE callback', () => {
      stderrChunks = []
      const original = process.stderr.write.bind(process.stderr)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 桩类型刻意收紧
      ;(process.stderr as any).write = (chunk: string | Buffer): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
        return true
      }
      try {
        const child = makeStubChild()
        attachStderrPassthrough(child)
        child.stderrEmitter.emit('data', Buffer.from('hello\n'))
        expect(stderrChunks.join('')).toBe('hello\n')
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 桩类型刻意收紧
        ;(process.stderr as any).write = original
      }
    })

    test('invokes onEaddrinuse and skips passthrough when EADDRINUSE appears', () => {
      stderrChunks = []
      const original = process.stderr.write.bind(process.stderr)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 桩类型刻意收紧
      ;(process.stderr as any).write = (chunk: string | Buffer): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
        return true
      }
      try {
        let callbackCalls = 0
        let receivedText = ''
        const child = makeStubChild()
        attachStderrPassthrough(child, {
          onEaddrinuse: (text) => {
            callbackCalls++
            receivedText = text
          }
        })
        child.stderrEmitter.emit(
          'data',
          Buffer.from('Error: listen EADDRINUSE: address already in use :::7600\n')
        )
        expect(callbackCalls).toBe(1)
        expect(receivedText).toContain('EADDRINUSE')
        // 回调命中时不应透传
        expect(stderrChunks.join('')).toBe('')
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 桩类型刻意收紧
        ;(process.stderr as any).write = original
      }
    })
  })
})
