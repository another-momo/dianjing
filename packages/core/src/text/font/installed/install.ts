/**
 * 应用字体库安装管线（renderer 端纯逻辑）。
 *
 * 形态：纯函数层（无 fs / 无静态 import woff2.ts）。流程 = 预校验 → 容器转码
 * （woff/woff2 → sfnt）→ 二次校验提取元数据 → 提交安装端点。
 *
 * 与端点侧的协作：调用方注入 transcode（woff2 → sfnt 字节流）与 post（POST
 * 字节到 pi-backend fonts/install 端点）。本模块不依赖 wawoff2、不依赖 fetch，
 * 单测可注入假实现。
 *
 * 全程不 throw：所有失败（预校验拒 / 转码失败 / 转码后仍非法 / 提交错误）
 * 包成 `{ ok: false, reason }`——结构化结果与既有的 FontFamilyOption / ValidationResult 同款
 * 离散形态。
 */
import { validateFontBytes } from './validate'

/** 安装管线依赖注入（transcode / post 均可单测替换） */
export interface InstallDeps {
  /** woff2 → sfnt 转换；非 woff2 不调。缺省 = 拒收 woff2（与未注入等价） */
  transcode?: (bytes: Uint8Array) => Promise<Uint8Array>
  /** 提交安装：bytes = 最终 sfnt 字节；返回响应体（FamilyView 或 {family, style}） */
  post: (bytes: Uint8Array) => Promise<unknown>
}

/** 安装成功：返回族名（端点侧响应以家族聚合视图，family 字段作族名键） */
export interface InstallOk {
  ok: true
  family: string
}

/** 安装失败：reason 稳定短码，文案由 UI 层映射 */
export interface InstallFail {
  ok: false
  reason: InstallFailureReason
  detail?: string
}

export type InstallFailureReason =
  | 'invalid-bytes' // 预校验拒（魔数/大小/opentype parse/name 缺失等）
  | 'unsupported-container' // 容器为 woff/woff2 但未注入 transcode
  | 'transcode-failed' // transcode 抛错或产物非法
  | 'post-failed' // 提交端点失败

export type InstallResult = InstallOk | InstallFail

/**
 * 接收任意容器字体字节 → 校验 → 必要时转码 → 提交安装。
 * 失败不 throw，统一包为 `{ ok: false, reason }`。
 */
export async function installLocalFont(
  bytes: Uint8Array,
  deps: InstallDeps
): Promise<InstallResult> {
  const initial = validateFontBytes(bytes)
  if (!initial.ok) {
    return { ok: false, reason: 'invalid-bytes', detail: `${initial.reason}: ${initial.detail}` }
  }

  // woff/woff2：转码后须对产物再校验一次——以 sfnt 形态走 opentype.js parse
  // 提取族名/样式名。容器为 woff 时本批不内置 transcode（woff 不是常驻
  // 上游压缩格式；如要支持则依赖方扩展 deps.transcode，路径一致）
  let sfntBytes: Uint8Array = bytes
  if (initial.container === 'woff2') {
    if (!deps.transcode) {
      return { ok: false, reason: 'unsupported-container' }
    }
    try {
      sfntBytes = await deps.transcode(bytes)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: 'transcode-failed', detail }
    }
  } else if (initial.container === 'woff') {
    return { ok: false, reason: 'unsupported-container' }
  }

  // 转码产物再校验：sfnt 走 opentype parse 拿 name 表（family/style/weight/italic）
  const finalValidation = validateFontBytes(sfntBytes)
  if (!finalValidation.ok) {
    return { ok: false, reason: 'transcode-failed', detail: finalValidation.detail }
  }
  if (finalValidation.container !== 'ttf' && finalValidation.container !== 'otf') {
    return { ok: false, reason: 'transcode-failed', detail: 'transcoded output is not sfnt' }
  }
  if (finalValidation.family.length === 0) {
    return { ok: false, reason: 'transcode-failed', detail: 'family name missing after transcode' }
  }

  try {
    await deps.post(sfntBytes)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: 'post-failed', detail }
  }
  return { ok: true, family: finalValidation.family }
}

/** 提取族名辅助：post 响应里 family 字段解析（端点侧可能回 FamilyView 或 {family}） */
export function pickInstalledFamily(response: unknown): string {
  if (response && typeof response === 'object') {
    const record = response as { family?: unknown }
    if (typeof record.family === 'string') return record.family
  }
  return ''
}
