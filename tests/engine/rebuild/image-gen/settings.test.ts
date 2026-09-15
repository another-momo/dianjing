/**
 * 图片本地留存偏好存储钉扎（owner 拍板）。
 *
 * 覆盖：缺省 OFF / setRetainLocal 写盘 / 内存缓存 / reloadForTests 重读 /
 * 坏 JSON 回缺省（fail-safe 不抛）/ tmp+rename 原子写（写期间不存在中间文件）。
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createImageGenSettingsStore } from '@/app/ai/pi-backend/image-gen/settings'

function tempAgentDir(): { agentDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openpencil-imagegen-settings-'))
  return { agentDir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('image-gen/settings.ts 本地留存偏好', () => {
  test('未配置 → get() 缺省 OFF（retainLocal: false；fail-safe）', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenSettingsStore({ agentDir })
      expect(store.get()).toEqual({ retainLocal: false })
    } finally {
      cleanup()
    }
  })

  test('setRetainLocal(true) 落盘 + 内存缓存；reloadForTests 后从盘上读回', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenSettingsStore({ agentDir })
      expect(store.setRetainLocal(true)).toEqual({ retainLocal: true })
      expect(store.get()).toEqual({ retainLocal: true })

      // 落盘文件存在 + 形态正确
      const raw = JSON.parse(readFileSync(join(agentDir, 'image-gen-settings.json'), 'utf8')) as {
        version?: number
        retainLocal?: boolean
      }
      expect(raw.version).toBe(1)
      expect(raw.retainLocal).toBe(true)

      store.reloadForTests()
      expect(store.get()).toEqual({ retainLocal: true })

      // 新 store 实例（同 agentDir）跨进程模拟读回
      const fresh = createImageGenSettingsStore({ agentDir })
      expect(fresh.get()).toEqual({ retainLocal: true })
    } finally {
      cleanup()
    }
  })

  test('setRetainLocal(false) 后再读 = false；往返一致', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenSettingsStore({ agentDir })
      store.setRetainLocal(true)
      expect(store.setRetainLocal(false)).toEqual({ retainLocal: false })
      expect(store.get()).toEqual({ retainLocal: false })
    } finally {
      cleanup()
    }
  })

  test('坏 JSON → 回缺省 OFF（fail-safe：不抛、不污染缓存语义）', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      writeFileSync(join(agentDir, 'image-gen-settings.json'), '{not-json')
      const store = createImageGenSettingsStore({ agentDir })
      expect(store.get()).toEqual({ retainLocal: false })
      // 切开关成功落盘覆盖坏文件
      store.setRetainLocal(true)
      expect(store.get()).toEqual({ retainLocal: true })
    } finally {
      cleanup()
    }
  })

  test('字段类型不对（retainLocal 非布尔）→ 回缺省 OFF', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      writeFileSync(
        join(agentDir, 'image-gen-settings.json'),
        JSON.stringify({ version: 1, retainLocal: 'yes' })
      )
      const store = createImageGenSettingsStore({ agentDir })
      expect(store.get()).toEqual({ retainLocal: false })
    } finally {
      cleanup()
    }
  })

  test('agentDir 不存在 → setRetainLocal 自动 mkdir（写盘前兜底）', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      rmSync(agentDir, { recursive: true, force: true })
      expect(existsSync(agentDir)).toBe(false)
      const store = createImageGenSettingsStore({ agentDir })
      store.setRetainLocal(true)
      expect(existsSync(join(agentDir, 'image-gen-settings.json'))).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('原子写：写期间只存在 .tmp 临时文件 + 终态 rename 后 .tmp 不残留', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      mkdirSync(agentDir, { recursive: true })
      // 先写一个旧文件模拟覆盖场景
      writeFileSync(
        join(agentDir, 'image-gen-settings.json'),
        JSON.stringify({ version: 1, retainLocal: false })
      )
      const store = createImageGenSettingsStore({ agentDir })
      store.setRetainLocal(true)
      // 终态：正式文件存在且为新内容；.tmp 不残留
      expect(existsSync(join(agentDir, 'image-gen-settings.json'))).toBe(true)
      expect(existsSync(join(agentDir, 'image-gen-settings.json.tmp'))).toBe(false)
      const raw = JSON.parse(readFileSync(join(agentDir, 'image-gen-settings.json'), 'utf8')) as {
        retainLocal?: boolean
      }
      expect(raw.retainLocal).toBe(true)
    } finally {
      cleanup()
    }
  })
})
