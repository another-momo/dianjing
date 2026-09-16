/**
 * 2026-09-16 指派后端化：design 模型指派（pi 模式专属）从浏览器 localStorage
 * 迁回后端 —— 后端持久化于 <状态根>/pi-agent/design-assignment.json（dev =
 * %APPDATA%/Dianjing，resolveAgentDir 同缝）。
 *
 * 设计动机：localStorage 指派对后端不可见，单端写读仅在浏览器侧有效。
 * ① 跨端一致性：会话恢复、IPC 桥、其他端接入都能拿到同一份指派
 * ② 腐烂即无指派：get 失败 / 形状坏 → null，与 provider-gate needs-setup
 *    语义对齐（指派 provider 不在目录也走 needs-setup）
 * ③ 形状校验在端点统一：catalog 不存在性校验放 provider-gate.ts 而不在
 *    此处做（端点保持薄——保存任意合理 providerId/modelId 都允许，腐烂时
 *    由 provider-gate 派生 needs-setup 兜底）
 *
 * 写盘纪律（与 capabilities store 同源）：tmp + rename 原子写，0o600 与同
 * 目录其他文件齐平（auth.json / image-gen.json / capabilities.json 已是
 * 0o600）。设计指派不含敏感字段（providerId/modelId/thinkingLevel），
 * 0o600 是统一防越权读而非内容保护。
 *
 * 缺失即无指派语义（capabilities.ts 同款取舍）：
 * - get 文件缺席 / 坏 JSON / 形状坏 → null 不抛
 * - set(null) → existsSync 守卫后 unlinkSync（与 image-gen credentials.clear 同律）
 * - set(非 null) 校验失败 → throw TypeError，由 server.ts 翻 400
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PiModelSpec, PiThinkingLevel } from './client'

/** PiThinkingLevel 字面量集合 —— set 校验用，缺省/缺失视为允许 */
const THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]

const PROVIDER_ID_RE = /^[a-z0-9-]+$/

function isPiModelSpec(value: unknown): value is PiModelSpec {
  if (!value || typeof value !== 'object') return false
  if (!('providerId' in value) || !('modelId' in value)) return false
  const providerId = (value as { providerId: unknown }).providerId
  if (typeof providerId !== 'string' || providerId.length === 0) return false
  if (!PROVIDER_ID_RE.test(providerId)) return false
  const modelId = (value as { modelId: unknown }).modelId
  if (typeof modelId !== 'string' || modelId.length === 0) return false
  if ('thinkingLevel' in value) {
    const thinkingLevel = (value as { thinkingLevel: unknown }).thinkingLevel
    if (
      thinkingLevel !== undefined &&
      !(THINKING_LEVELS as readonly string[]).includes(thinkingLevel as string)
    ) {
      return false
    }
  }
  return true
}

export type DesignAssignmentStore = {
  /** 进程级内存缓存；缺省 null；返回纯值对象（深拷贝隔断调用方改写缓存） */
  get(): PiModelSpec | null
  /**
   * PUT 写入：null → 删文件（existsSync 守卫避免无谓 ENOENT）；非 null 先过
   * 形状校验（失败 throw TypeError，server.ts 转 400）。返回写入后的规范化值
   * ——无 thinkingLevel 字段时不返回字段，与 assignment.ts 序列化约定一致。
   */
  set(spec: PiModelSpec | null): PiModelSpec | null
  /** 测试钩子：丢弃内存缓存，下次 get 重读盘 */
  reloadForTests(): void
  /** 测试钩子：是否落盘（不存在则 false） */
  exists(): boolean
}

export function createDesignAssignmentStore({
  agentDir
}: {
  agentDir: string
}): DesignAssignmentStore {
  const filePath = join(agentDir, 'design-assignment.json')
  let cache: PiModelSpec | null | undefined

  function readFromDisk(): PiModelSpec | null {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
      return isPiModelSpec(raw) ? raw : null
    } catch {
      // ENOENT（首跑无指派）= 正常静默；坏 JSON / 形状坏 = 腐烂 → null
      // 不抛——指派缺失即无指派语义，由 provider-gate needs-setup 兜底
      return null
    }
  }

  function clone(spec: PiModelSpec): PiModelSpec {
    const next: PiModelSpec = { providerId: spec.providerId, modelId: spec.modelId }
    if (spec.thinkingLevel) next.thinkingLevel = spec.thinkingLevel
    return next
  }

  function get(): PiModelSpec | null {
    if (cache === undefined) cache = readFromDisk()
    return cache ? clone(cache) : null
  }

  function writeToDisk(spec: PiModelSpec): void {
    mkdirSync(agentDir, { recursive: true })
    const tmpPath = `${filePath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(spec, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmpPath, filePath)
  }

  function set(spec: PiModelSpec | null): PiModelSpec | null {
    if (spec === null) {
      cache = null
      if (existsSync(filePath)) unlinkSync(filePath)
      return null
    }
    if (!isPiModelSpec(spec)) {
      throw new TypeError(
        'design assignment 形状不合法：需 { providerId: ^[a-z0-9-]+$, modelId: 非空, thinkingLevel?: PiThinkingLevel }'
      )
    }
    const normalized: PiModelSpec = clone(spec)
    writeToDisk(normalized)
    cache = normalized
    return clone(normalized)
  }

  function reloadForTests(): void {
    cache = undefined
  }

  return { get, set, reloadForTests, exists: () => existsSync(filePath) }
}

export type { PiModelSpec }
