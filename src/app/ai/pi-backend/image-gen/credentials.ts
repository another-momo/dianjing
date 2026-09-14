/**
 * T54（Phase 3 W2/T-B3）：generate_image 凭证面（providerType/baseUrl/apiKey/model
 * 四键；T66 起 presetId 退役——预设表删除，三键全部用户手填，P0/P1）。
 *
 * 存储：.dianjing/pi-agent/image-gen.json（0o600，tmp+rename 原子写）。
 * 进程级注入：store 对象由 server.ts 创建并注入 generate_image 工具工厂
 * （集成期装配）——key 只活在本进程内存与该文件，不进桥 payload、不进
 * 工具 schema、不打印、不回传前端（status() 只回 configured/providerType/
 * baseUrl/model 元数据）。
 *
 * 为什么不用 provider-admin 的 pi auth.json 面（复用 vs 扩面定谳）：
 * provider-admin 的凭证语义绑定 pi ModelRuntime 的 LLM provider 注册表
 * （login/logout/models.json 联动）；生图凭证不是聊天模型 provider，
 * 塞进 auth.json 会与聊天 key 共面且无法携带 baseURL/model 键组。
 * 独立文件 + 同等 0o600/不回显纪律 = 同安全级别的扩面。
 *
 * 空 key 清除必须生效（00 #7 旧 bug 不修不搬）：set() 收到空 key = clear()。
 *
 * 旧格式兼容（T66 裁决：容忍读，迁移在写）：T54 版文件含 presetId 而无
 * providerType——两个旧预设（openai/dmx）同为 OpenAI 兼容端，读到时
 * providerType 归一为 'openai-compatible'、presetId 字段忽略；下次 set()
 * 写盘即为新格式，旧字段自然消亡。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isImageGenProviderType, type ImageGenProviderType } from './provider-types'

export interface ImageGenCredentials {
  providerType: ImageGenProviderType
  baseUrl: string
  model: string
  apiKey: string
}

/** 脱敏状态（任何响应面只允许这个形状） */
export interface ImageGenCredentialStatus {
  configured: boolean
  providerType?: string
  baseUrl?: string
  model?: string
}

interface ImageGenCredentialFile {
  version: 1
  providerType: ImageGenProviderType
  baseUrl: string
  model: string
  apiKey: string
}

/** T54 旧格式（含 presetId、无 providerType）读入时的形状 */
interface LegacyImageGenCredentialFile {
  version: 1
  presetId: string
  baseUrl: string
  model: string
  apiKey: string
}

export function createImageGenCredentialStore({ agentDir }: { agentDir: string }) {
  const filePath = join(agentDir, 'image-gen.json')
  let cache: ImageGenCredentials | null | undefined

  function readFromDisk(): ImageGenCredentials | null {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<
        ImageGenCredentialFile & LegacyImageGenCredentialFile
      >
      if (
        typeof raw.baseUrl === 'string' &&
        raw.baseUrl.length > 0 &&
        typeof raw.model === 'string' &&
        raw.model.length > 0 &&
        typeof raw.apiKey === 'string' &&
        raw.apiKey.length > 0
      ) {
        return {
          // 旧文件无 providerType：两个旧预设均为 OpenAI 兼容端，归一即可
          providerType: isImageGenProviderType(raw.providerType)
            ? raw.providerType
            : 'openai-compatible',
          baseUrl: raw.baseUrl,
          model: raw.model,
          apiKey: raw.apiKey
        }
      }
      return null
    } catch {
      // ENOENT = 未配置（正常静默）；坏 JSON 按未配置处理——凭证面 fail-safe，
      // 坏文件宁可要求重配也不携带半残状态
      return null
    }
  }

  function get(): ImageGenCredentials | null {
    if (cache === undefined) cache = readFromDisk()
    return cache
  }

  function writeToDisk(credentials: ImageGenCredentials): void {
    mkdirSync(agentDir, { recursive: true })
    const doc: ImageGenCredentialFile = { version: 1, ...credentials }
    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(doc, null, 2), { mode: 0o600 })
    renameSync(tmpPath, filePath)
  }

  /**
   * 设置凭证。providerType 必须在注册表内（T66 起 baseUrl/model 由用户手填，
   * 不再由预设携带）。空 key（含全空白）= 清除（00 #7）。
   */
  function set(input: {
    providerType: string
    baseUrl: string
    model: string
    apiKey: string
  }): void {
    if (!isImageGenProviderType(input.providerType)) {
      throw new Error(`未知生图服务商类型：${input.providerType}`)
    }
    const baseURL = input.baseUrl.trim()
    if (!baseURL) {
      throw new Error('Base URL 不能为空')
    }
    let parsedURL: URL
    try {
      parsedURL = new URL(baseURL)
    } catch {
      throw new Error(`Base URL 不是合法 URL：${baseURL}`)
    }
    if (parsedURL.protocol !== 'https:' && parsedURL.protocol !== 'http:') {
      throw new Error(`Base URL 仅支持 http/https：${baseURL}`)
    }
    const model = input.model.trim()
    if (!model) {
      throw new Error('模型名不能为空')
    }
    const key = input.apiKey.trim()
    if (!key) {
      clear()
      return
    }
    if (/\s/.test(key)) {
      throw new Error('API key 含空白字符，无法作为 HTTP 头携带——请检查是否复制完整')
    }
    const credentials: ImageGenCredentials = {
      providerType: input.providerType,
      baseUrl: baseURL,
      model,
      apiKey: key
    }
    writeToDisk(credentials)
    cache = credentials
  }

  function clear(): void {
    cache = null
    // 文件本就不存在 = 目标态已达；existsSync 前置免空 catch
    if (existsSync(filePath)) unlinkSync(filePath)
  }

  function status(): ImageGenCredentialStatus {
    const credentials = get()
    if (!credentials) return { configured: false }
    return {
      configured: true,
      providerType: credentials.providerType,
      baseUrl: credentials.baseUrl,
      model: credentials.model
    }
  }

  /** 测试钩子：丢弃内存缓存，下次 get 重读盘 */
  function reloadForTests(): void {
    cache = undefined
  }

  return { get, set, clear, status, reloadForTests, exists: () => existsSync(filePath) }
}

export type ImageGenCredentialStore = ReturnType<typeof createImageGenCredentialStore>
