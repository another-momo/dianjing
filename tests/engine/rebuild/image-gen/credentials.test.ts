/**
 * T54→T66：凭证链钉扎（验收锚 T54-plan §3.1/§3.2 + T66 P0/P1）——
 * 空 key 清除生效（00 #7）；四键（providerType/baseUrl/model/apiKey）自由
 * 配置落盘（预设表已删，无隐式 baseURL）；状态脱敏（status 不回 key）；
 * providerType 注册表校验；T54 旧格式文件（含 presetId）容忍读。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createImageGenCredentialStore } from '@/app/ai/pi-backend/image-gen/credentials'
import {
  DEFAULT_IMAGE_GEN_PROVIDER_TYPE,
  IMAGE_GEN_PROVIDER_TYPES,
  isImageGenProviderType
} from '@/app/ai/pi-backend/image-gen/provider-types'

const VALID_INPUT = {
  providerType: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-image-1',
  apiKey: 'sk-secret-imagegen'
}

function tempAgentDir(): { agentDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openpencil-imagegen-test-'))
  return { agentDir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 落盘文件的读取钉扎形状（新/旧格式字段并集） */
interface RawCredentialFileOnDisk {
  providerType?: string
  presetId?: string
  apiKey?: string
}

describe('provider 类型注册表', () => {
  test('T77 P6 注册表含 openai-compatible + seedream 两族', () => {
    expect(IMAGE_GEN_PROVIDER_TYPES.map((entry) => entry.id)).toEqual([
      'openai-compatible',
      'seedream'
    ])
    expect(DEFAULT_IMAGE_GEN_PROVIDER_TYPE).toBe('openai-compatible')
    expect(isImageGenProviderType('openai-compatible')).toBe(true)
    expect(isImageGenProviderType('seedream')).toBe(true)
  })
})

describe('凭证存储', () => {
  test('未配置 → get() null / status.configured=false（无隐式 baseURL）', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      expect(store.get()).toBeNull()
      expect(store.status()).toEqual({ configured: false })
      expect(store.exists()).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('set 四键落盘；status 脱敏不回 key', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      store.set(VALID_INPUT)
      const credentials = store.get()
      expect(credentials).toEqual(VALID_INPUT)
      const status = store.status()
      expect(status.configured).toBe(true)
      expect(status.providerType).toBe('openai-compatible')
      expect(status.baseUrl).toBe('https://api.openai.com/v1')
      expect(JSON.stringify(status)).not.toContain('sk-secret-imagegen')
      // 落盘文件存在且为 JSON（权限位 win 下不可断言 0o600，只断言存在与内容）
      const raw: {
        apiKey?: string
        presetId?: string
      } = JSON.parse(readFileSync(join(agentDir, 'image-gen.json'), 'utf8'))
      expect(raw.apiKey).toBe('sk-secret-imagegen')
      // 新格式不写 presetId
      expect('presetId' in raw).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('T54 旧格式（含 presetId、无 providerType）容忍读：归一 openai-compatible，presetId 忽略', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      // 手写 T54 旧格式文件
      writeFileSync(
        join(agentDir, 'image-gen.json'),
        JSON.stringify({
          version: 1,
          presetId: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-image-1',
          apiKey: 'sk-legacy'
        })
      )
      const store = createImageGenCredentialStore({ agentDir })
      expect(store.get()).toEqual({
        providerType: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-1',
        apiKey: 'sk-legacy'
      })
      // 迁移在写：下次 set 后盘上即新格式
      store.set({ ...VALID_INPUT, apiKey: 'sk-rewritten' })
      const raw: RawCredentialFileOnDisk = JSON.parse(
        readFileSync(join(agentDir, 'image-gen.json'), 'utf8')
      )
      expect(raw.providerType).toBe('openai-compatible')
      expect('presetId' in raw).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('空 key 清除生效（00 #7：set 空串 = clear，文件移除）', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      store.set({ ...VALID_INPUT, apiKey: 'sk-to-be-cleared' })
      expect(store.get()).not.toBeNull()
      store.set({ ...VALID_INPUT, apiKey: '' })
      expect(store.get()).toBeNull()
      expect(store.status().configured).toBe(false)
      expect(existsSync(join(agentDir, 'image-gen.json'))).toBe(false)
      // 全空白同义
      store.set({ ...VALID_INPUT, apiKey: 'sk-again' })
      store.set({ ...VALID_INPUT, apiKey: '   ' })
      expect(store.get()).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('clear() 幂等（未配置时调用不炸）', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      store.clear()
      expect(store.get()).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('未知 providerType 拒绝', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      expect(() => store.set({ ...VALID_INPUT, providerType: 'evil-protocol' })).toThrow(
        '未知生图服务商类型'
      )
      expect(store.get()).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('baseUrl/model 校验：空值与非 http(s) URL 拒绝', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      expect(() => store.set({ ...VALID_INPUT, baseUrl: ' ' })).toThrow('Base URL 不能为空')
      expect(() => store.set({ ...VALID_INPUT, baseUrl: 'not-a-url' })).toThrow('合法 URL')
      expect(() => store.set({ ...VALID_INPUT, baseUrl: 'ftp://example.com' })).toThrow(
        'http/https'
      )
      expect(() => store.set({ ...VALID_INPUT, model: '  ' })).toThrow('模型名不能为空')
      expect(store.get()).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('key 含空白字符拒绝（HTTP 头不可携带）', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      expect(() => store.set({ ...VALID_INPUT, apiKey: 'sk-has space' })).toThrow('空白字符')
    } finally {
      cleanup()
    }
  })

  test('跨进程持久化：reloadForTests 后从盘上读回', () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      store.set({ ...VALID_INPUT, apiKey: 'sk-persist' })
      store.reloadForTests()
      expect(store.get()?.apiKey).toBe('sk-persist')
      // 新 store 实例（模拟进程重启）同读
      const fresh = createImageGenCredentialStore({ agentDir })
      expect(fresh.get()?.apiKey).toBe('sk-persist')
    } finally {
      cleanup()
    }
  })
})
