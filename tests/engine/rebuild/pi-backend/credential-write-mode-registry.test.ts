/**
 * 0o600 落盘点位登记门禁（2026-09-29 凭据守卫现状稿缺口 2.2——仓外
 * docs/202609291049-pi-agent-credential-guard-state.md）。
 *
 * 现状稿实证：仓内凭据写盘点位统一 `{ mode: 0o600 }`，但「新增凭据落盘点位
 * 必须联登 protectedCredentialFiles」此前纯靠人工约定——bridge.json（明文桥
 * 鉴权 token）正是漏网实证（缺口 2.1，已补登读侧名单）。本测试把人工约定改
 * 测试强制：
 *  A. 扫 src/ 全部 .ts，凡含 `mode: 0o600`（容空白/进制前缀大小写变体）即
 *     「落盘点位文件」，必须在下方登记表——新增 0o600 点位而未登记 → 红；
 *  B. 登记表无死条目——点位文件删除或改写法后表须同批清理，防登记表腐烂；
 *  C. 登记表 writes 非 null 的条目（凭据写入方）其凭据文件名必须出现在
 *     protectedCredentialFiles 返回值（endsWith 匹配）——凭据落盘点位漏登
 *     deny 名单 → 红（bridge.json 案例的机制化复现钉扎）。
 *
 * 登记表条目二分：writes 非 null = 凭据写入方（名单联改义务）；writes null =
 * 非凭据但对齐 0o600 纪律的落盘点位（豁免，reason 写明理由）。名单口径 =
 * 只登读侧文件名（与 key-env / pi-backend-token 两件 rootDir 直下既有条目
 * 同口径；写侧 protectedWriteRoots 三根不动）。
 *
 * key-env 无代码写入方（用户自助创建文件，main.ts 只读不写），故无登记条目。
 */

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { protectedCredentialFiles } from '@/app/ai/pi-backend/path-decision'

/** 仓根 src/（本档在 tests/engine/rebuild/pi-backend/，上溯四级到仓根） */
const SRC_ROOT = join(import.meta.dir, '../../../../src')

/**
 * 容空白与进制前缀大小写变体（`mode:0o600` / `mode: 0o600` / `mode:  0o600`
 * 同判；Node 数字字面量接受 0o600 与 0O600 两形——漏扫大写形态则 A/C 两闸失守）
 */
const MODE_0O600_PATTERN = /mode:\s*0[Oo]600/

interface RegistryEntry {
  /** 本文件以 mode: 0o600 写入的凭据文件名；null = 非凭据点位（0o600 卫生对齐，豁免） */
  writes: string | null
  reason: string
}

/**
 * 登记表：POSIX 相对 src/ 路径 → 写入对象与豁免理由。
 * 维护口径：新增 0o600 写盘点位 = 本表补条 + 若是凭据文件同步联登
 * path-decision.ts protectedCredentialFiles（A/C 两道闸同时约束）。
 */
const REGISTRY: Record<string, RegistryEntry> = {
  // ── 凭据写入方（writes 非 null——文件名必须在 protectedCredentialFiles）──
  'app/ai/pi-backend/main.ts': {
    writes: 'pi-backend-token',
    reason: 'standalone 模式鉴权 token 明文（paths.ts PI_BACKEND_TOKEN_FILENAME，tmp+rename）'
  },
  'app/ai/pi-backend/provider-admin.ts': {
    writes: 'auth.json',
    reason: 'provider key 明文兜底写路径（login 不可用时直写 pi-agent/auth.json）'
  },
  'app/ai/pi-backend/image-gen/credentials.ts': {
    writes: 'image-gen.json',
    reason: 'image-gen apiKey 明文'
  },
  'app/ai/pi-backend/mcp-connections/store.ts': {
    writes: 'mcp-connections.json',
    reason: 'MCP 接入凭据（headers/env 值含第三方 key）'
  },
  'app/bridge/server/discovery.ts': {
    writes: 'bridge.json',
    reason: '桥发现文件（明文桥鉴权 token）——2026-09-29 现状稿缺口 2.1 漏网实证，已补登读侧名单'
  },
  // ── 豁免（writes null——非凭据，0o600 为落盘卫生对齐）──
  'app/ai/pi-backend/capabilities.ts': {
    writes: null,
    reason: 'capabilities.json 无敏感字段（builtinTools/skills 档位），0o600 齐平同目录卫生'
  },
  'app/ai/pi-backend/design-assignment.ts': {
    writes: null,
    reason: 'design-assignment.json 无敏感字段（providerId/modelId/thinkingLevel），头注自陈'
  },
  'app/ai/pi-backend/page-state.ts': {
    writes: null,
    reason: '页面状态用户数据（注入目录下 docUuid.json），无凭据字段'
  },
  'app/ai/pi-backend/open-docs/guard.ts': {
    writes: null,
    reason: '打开文档心跳记录用户数据（注入目录下 docUuid.json），无凭据字段'
  },
  'app/ai/pi-backend/image-gen/settings.ts': {
    writes: null,
    reason: 'image-gen-settings.json 仅 retainLocal 开关，无敏感字段'
  }
}

/** 扫 src/ 全部 .ts：命中 mode: 0o600 的文件，返回 POSIX 相对路径（升序稳定） */
function scanMode0o600Files(): string[] {
  const hits: string[] = []
  for (const entry of readdirSync(SRC_ROOT, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const full = join(entry.parentPath, entry.name)
    if (!MODE_0O600_PATTERN.test(readFileSync(full, 'utf8'))) continue
    hits.push(full.slice(SRC_ROOT.length + 1).replace(/\\/g, '/'))
  }
  return hits.sort()
}

test('A: 每个 mode: 0o600 落盘点位都已在登记表（未登记 → 补表并按凭据与否分流）', () => {
  const unregistered = scanMode0o600Files().filter((file) => !(file in REGISTRY))
  expect(unregistered).toEqual([])
})

test('B: 登记表无死条目（点位文件已删或已不写 0o600 → 同批清表）', () => {
  const scanned = new Set(scanMode0o600Files())
  const stale = Object.keys(REGISTRY).filter((file) => !scanned.has(file))
  expect(stale).toEqual([])
})

test('C: 凭据写入方的文件名全部在 protectedCredentialFiles 读侧名单', () => {
  // env fixture 注入——bridge.json 落点解析缺省读 process.env，测试须 hermetic
  const denyList = protectedCredentialFiles(resolve('/fake/registry-root'), {
    APPDATA: '/fake/appdata',
    XDG_CONFIG_HOME: '/fake/xdg'
  })
  const credentialWriters = Object.entries(REGISTRY).flatMap(([file, entry]) =>
    entry.writes === null ? [] : [{ file, writes: entry.writes }]
  )
  const missing = credentialWriters
    .filter(({ writes }) => !denyList.some((p) => p.endsWith(sep + writes)))
    .map(({ file, writes }) => `${file} → ${writes}`)

  expect(missing).toEqual([])
})
