/**
 * 2026-09-16 凭据守卫 A 案 tool_call handler 钉扎。
 *
 * 与 ask/pending-guard 同构：handler 与 extension 分离导出，测试直钉 handler
 * （免 ExtensionAPI 桩件与类型断言）。fixture = 纯字符串路径运算（无真实 IO），
 * homeDir 注入 root（好测 ~ 展开命中凭据的情形）。
 *
 * 覆盖 17 用例：read 4 件 + 5 关键放行 + edit/write + grep 6 形态 + ls/find/bash/custom + 非 string path；
 * 2026-09-18 P0-3 追加读侧敏感名单扩面用例（.ssh/.aws/.env/.pem 命中与不命中、写侧面不动）。
 */

import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'

import {
  createKeyGuardHandler,
  protectedCredentialFiles,
  protectedWriteRoots
} from '@/app/ai/pi-backend/key-guard'

// fixture 用 resolve 把假根钉成真绝对路径——resolve 在 Win/mac/linux 都带系统正确
// 前缀（Windows 加盘符，POSIX 保留 /），与 handler 内 isAbsolute→resolve 路径
// 同根，归一化形态可比对。纯字符串运算不需真建目录。
const ROOT = resolve('/fake/kg-root')
const WORKSPACE = resolve(ROOT, 'workspace')
const WORKSPACE_PI = resolve(WORKSPACE, '.pi')
// 2026-09-18 userdata 重排：用户扩展层 workspace/.agents——写侧 deny 面新增成员
const WORKSPACE_AGENTS = resolve(WORKSPACE, '.agents')
const AGENT_DIR = resolve(ROOT, 'pi-agent')
const AUTH_JSON = resolve(AGENT_DIR, 'auth.json')
const IMAGE_GEN_JSON = resolve(AGENT_DIR, 'image-gen.json')
const KEY_ENV = resolve(ROOT, 'key-env')
const PI_BACKEND_TOKEN = resolve(ROOT, 'pi-backend-token')

const READ_DENY_REASON =
  'Access denied: this path stores API credentials/tokens and is protected from agent access. ' +
  'Do not read, search, or infer credential files — if credentials need inspection or changes, direct the user to the Settings panel.'

const WRITE_DENY_REASON =
  'Access denied: this path stores API credentials/tokens and is protected from agent writes. ' +
  'Credential updates go through the Settings panel (credential routes) only.'

const WRITE_FACET_DENY_REASON =
  'Access denied: this path is in the protected pi agent configuration facet and cannot be modified by the agent. ' +
  'The project trust surface is closed; configuration updates go through the Settings panel or developer tooling.'

const SENSITIVE_READ_DENY_REASON =
  'Access denied: this path is a sensitive system or credential file (SSH/AWS config, .env, PEM key material) and is protected from agent reads and searches. ' +
  'Do not read, search, or infer its contents — if the file needs inspection or changes, ask the user to handle it directly.'

function makeHandler() {
  return createKeyGuardHandler({ rootDir: ROOT, cwd: WORKSPACE, homeDir: ROOT })
}

describe('protectedCredentialFiles', () => {
  test('四件绝对路径单源——与 paths.ts resolver 同根', () => {
    expect(protectedCredentialFiles(ROOT)).toEqual([
      KEY_ENV,
      PI_BACKEND_TOKEN,
      AUTH_JSON,
      IMAGE_GEN_JSON
    ])
  })
})

describe('createKeyGuardHandler — read / edit / write 路径守卫', () => {
  test('read 绝对路径 auth.json → block（READ reason）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: AUTH_JSON } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('read ../pi-agent/auth.json（cwd=workspace）→ block（向上解析命中凭据）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: '../pi-agent/auth.json' } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('read pi-agent/auth.json 相对（resolve 进 workspace/pi-agent/auth.json）→ 放行', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: 'pi-agent/auth.json' } })).toBeUndefined()
  })

  test('read 混合大小写+反斜杠（<ROOT>\\Pi-Agent\\AUTH.JSON）→ block（归一化吃下）', () => {
    const handler = makeHandler()
    const mixed = ROOT.replaceAll('/', '\\') + '\\Pi-Agent\\AUTH.JSON'
    expect(handler({ toolName: 'read', input: { path: mixed } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('read 绝对 key-env / pi-backend-token / pi-agent/image-gen.json → 各 block', () => {
    const handler = makeHandler()
    for (const target of [KEY_ENV, PI_BACKEND_TOKEN, IMAGE_GEN_JSON]) {
      expect(handler({ toolName: 'read', input: { path: target } })).toEqual({
        block: true,
        reason: READ_DENY_REASON
      })
    }
  })

  test('read 绝对 workspace/.agents/base.md → 放行（读侧不扩——.agents 内无凭据）', () => {
    const handler = makeHandler()
    const baseMd = join(WORKSPACE_AGENTS, 'base.md')
    expect(handler({ toolName: 'read', input: { path: baseMd } })).toBeUndefined()
  })

  test('read ~/pi-agent/auth.json（homeDir=root）→ block（~ 展开命中）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: '~/pi-agent/auth.json' } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('edit 绝对 auth.json / write 绝对 key-env → block（2026-09-16：facet 写侧先于凭据命中，reason = facet）', () => {
    const handler = makeHandler()
    // 2026-09-16 层 1 纵深件：auth.json 在 pi-agent/ 子树，facet 写侧 deny
    // 先于凭据命中——reason 走 facet 而非凭据（实测路径更准：「在 pi-agent/ 下」）
    expect(handler({ toolName: 'edit', input: { path: AUTH_JSON } })).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
    // key-env 与 pi-backend-token 在 rootDir 直接，不在 pi-agent/ 下——
    // facet 不命中，凭据命中 reason 仍 = WRITE_DENY_REASON
    expect(handler({ toolName: 'write', input: { path: KEY_ENV } })).toEqual({
      block: true,
      reason: WRITE_DENY_REASON
    })
  })
})

describe('createKeyGuardHandler — grep 搜索根守卫', () => {
  test('grep 无 path（cwd=workspace 不含凭据）→ 放行', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'foo' } })).toBeUndefined()
  })

  test('grep path 绝对 pi-agent 目录 → block（祖先含凭据文件）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'foo', path: AGENT_DIR } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('grep path 绝对 rootDir → block（祖先目录）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'foo', path: ROOT } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('grep path 绝对 auth.json 文件本身 → block（自身）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'foo', path: AUTH_JSON } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('grep path 绝对 workspace/.agents 目录 → 放行（读/搜侧不含凭据文件后代）', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'grep', input: { pattern: 'foo', path: WORKSPACE_AGENTS } })
    ).toBeUndefined()
  })
})

describe('createKeyGuardHandler — 读侧敏感名单扩面（2026-09-18 broker P0-3）', () => {
  const SSH_DIR = resolve(ROOT, '.ssh')
  const AWS_DIR = resolve(ROOT, '.aws')

  test('read ~/.ssh/id_rsa（~ 展开命中，homeDir=root）→ block（SENSITIVE reason）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: '~/.ssh/id_rsa' } })).toEqual({
      block: true,
      reason: SENSITIVE_READ_DENY_REASON
    })
  })

  test('read .ssh 目录本体 / .aws/credentials → block（目录本体及后代）', () => {
    const handler = makeHandler()
    for (const target of [SSH_DIR, resolve(AWS_DIR, 'credentials')]) {
      expect(handler({ toolName: 'read', input: { path: target } })).toEqual({
        block: true,
        reason: SENSITIVE_READ_DENY_REASON
      })
    }
  })

  test('read workspace 内 .env → block（basename 恰 .env 任意路径过挡——有意过挡写实断言）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: resolve(WORKSPACE, '.env') } })).toEqual({
      block: true,
      reason: SENSITIVE_READ_DENY_REASON
    })
  })

  test('read 任意深度 .env.production → block（.env. 前缀）', () => {
    const handler = makeHandler()
    const target = resolve(WORKSPACE, 'config', '.env.production')
    expect(handler({ toolName: 'read', input: { path: target } })).toEqual({
      block: true,
      reason: SENSITIVE_READ_DENY_REASON
    })
  })

  test('read workspace/cert.pem 与盘外 /etc/ssl/server.pem → block（.pem 扩展名任意路径）', () => {
    const handler = makeHandler()
    for (const target of [resolve(WORKSPACE, 'cert.pem'), '/etc/ssl/server.pem']) {
      expect(handler({ toolName: 'read', input: { path: target } })).toEqual({
        block: true,
        reason: SENSITIVE_READ_DENY_REASON
      })
    }
  })

  test('read workspace/foo.env → 放行（basename 非恰 .env 亦非 .env. 前缀）', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'read', input: { path: resolve(WORKSPACE, 'foo.env') } })
    ).toBeUndefined()
  })

  test('read ~/.sshconfig → 放行（不在 .ssh/ 目录下，basename 非名单模式）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: '~/.sshconfig' } })).toBeUndefined()
  })

  test('read workspace/note.pem.md → 放行（扩展名非恰 .pem）', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'read', input: { path: resolve(WORKSPACE, 'note.pem.md') } })
    ).toBeUndefined()
  })

  test('edit ~/.ssh/config 与 write workspace/.env → 放行（写侧面不动，名单读侧专属）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'edit', input: { path: '~/.ssh/config' } })).toBeUndefined()
    expect(
      handler({ toolName: 'write', input: { path: resolve(WORKSPACE, '.env') } })
    ).toBeUndefined()
  })

  test('grep path=~/.ssh → block（搜根在敏感目录内）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'x', path: '~/.ssh' } })).toEqual({
      block: true,
      reason: SENSITIVE_READ_DENY_REASON
    })
  })

  test('grep path=homeDir（敏感目录祖先，搜索会捞出 .ssh/.aws 内容）→ block', () => {
    // homeDir 独立于 rootDir——避开凭据四件祖先命中（凭据 reason 优先），
    // 纯钉敏感名单祖先方向
    const home = resolve(ROOT, 'home')
    const handler = createKeyGuardHandler({ rootDir: ROOT, cwd: WORKSPACE, homeDir: home })
    expect(handler({ toolName: 'grep', input: { pattern: 'x', path: home } })).toEqual({
      block: true,
      reason: SENSITIVE_READ_DENY_REASON
    })
  })

  test('grep path=workspace/.env → block（搜根本身命中名单模式）', () => {
    const handler = makeHandler()
    const target = resolve(WORKSPACE, '.env')
    expect(handler({ toolName: 'grep', input: { pattern: 'x', path: target } })).toEqual({
      block: true,
      reason: SENSITIVE_READ_DENY_REASON
    })
  })

  test('grep path=workspace（无敏感目录后代）→ 放行', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'grep', input: { pattern: 'x', path: WORKSPACE } })).toBeUndefined()
  })
})

describe('protectedWriteRoots — 2026-09-16 层 1 写侧纵深件（2026-09-18 扩 .agents）', () => {
  test('三根 = agentDir + workspace/.pi + workspace/.agents（写侧 deny 面）', () => {
    expect(protectedWriteRoots(ROOT)).toEqual([AGENT_DIR, WORKSPACE_PI, WORKSPACE_AGENTS])
  })
})

describe('createKeyGuardHandler — 写侧 deny pi-agent/** 与 workspace/.pi/**（2026-09-16 层 1 纵深件）', () => {
  test('edit 写 pi-agent/settings.json → block（facet reason）', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'edit', input: { path: resolve(AGENT_DIR, 'settings.json') } })
    ).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('write pi-agent/SYSTEM.md 与 APPEND_SYSTEM.md → block（facet reason）', () => {
    const handler = makeHandler()
    for (const target of [
      resolve(AGENT_DIR, 'SYSTEM.md'),
      resolve(AGENT_DIR, 'APPEND_SYSTEM.md')
    ]) {
      expect(handler({ toolName: 'write', input: { path: target } })).toEqual({
        block: true,
        reason: WRITE_FACET_DENY_REASON
      })
    }
  })

  test('edit 写 pi-agent/extensions/x.js → block（嵌套后代）', () => {
    const handler = makeHandler()
    const nested = resolve(AGENT_DIR, 'extensions', 'evil.js')
    expect(handler({ toolName: 'edit', input: { path: nested } })).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('edit 写 pi-agent/skills/foo/SKILL.md → block（嵌套后代）', () => {
    const handler = makeHandler()
    const nested = resolve(AGENT_DIR, 'skills', 'foo', 'SKILL.md')
    expect(handler({ toolName: 'edit', input: { path: nested } })).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('edit 写 workspace/.pi/SYSTEM.md → block（facet reason）', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'edit', input: { path: resolve(WORKSPACE_PI, 'SYSTEM.md') } })
    ).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('edit 写 workspace/.pi/extensions/foo.js → block（嵌套后代）', () => {
    const handler = makeHandler()
    const nested = resolve(WORKSPACE_PI, 'extensions', 'foo.js')
    expect(handler({ toolName: 'edit', input: { path: nested } })).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('write workspace/.agents/base.md → block（2026-09-18 新增自植面，与目录启用同批）', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'write', input: { path: resolve(WORKSPACE_AGENTS, 'base.md') } })
    ).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('edit 写 workspace/.agents/skills/foo/SKILL.md → block（嵌套后代 = 自植 skill）', () => {
    const handler = makeHandler()
    const nested = resolve(WORKSPACE_AGENTS, 'skills', 'foo', 'SKILL.md')
    expect(handler({ toolName: 'edit', input: { path: nested } })).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('edit .agents/workflows/x/workflow.md（cwd=workspace 相对路径）→ block', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'edit', input: { path: '.agents/workflows/x/workflow.md' } })
    ).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('write workspace/image-gen-output/2026-09-18/x.png → 放行（留存目录不 deny，用户数据面）', () => {
    const handler = makeHandler()
    const target = resolve(WORKSPACE, 'image-gen-output', '2026-09-18', 'x.png')
    expect(handler({ toolName: 'write', input: { path: target } })).toBeUndefined()
  })

  test('edit ../pi-agent/settings.json（cwd=workspace 上行） → block', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'edit', input: { path: '../pi-agent/settings.json' } })).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('edit ../workspace/.pi/settings.json → block', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'edit', input: { path: '../workspace/.pi/settings.json' } })
    ).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('edit 写 pi-agent 目录用 <ROOT>\\Pi-Agent\\Settings.JSON → block（大小写/分隔符归一化）', () => {
    const handler = makeHandler()
    const mixed = ROOT.replaceAll('/', '\\') + '\\Pi-Agent\\Settings.JSON'
    expect(handler({ toolName: 'edit', input: { path: mixed } })).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('read pi-agent/settings.json → 仍放行（不扩读侧——读侧维持凭据四件原口径）', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'read', input: { path: resolve(AGENT_DIR, 'settings.json') } })
    ).toBeUndefined()
  })

  test('read pi-agent/auth.json → 仍 block（凭据四件读侧维持）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: AUTH_JSON } })).toEqual({
      block: true,
      reason: READ_DENY_REASON
    })
  })

  test('write pi-agent/auth.json → block（facet 面先于凭据命中，reason = facet）', () => {
    const handler = makeHandler()
    // 凭据四件在 pi-agent/ 子树，facet 写侧 deny 先于凭据命中——理由走
    // facet 而非凭据（实测更准：路径是「在 pi-agent/ 下」而非「凭据文件本身」）
    expect(handler({ toolName: 'write', input: { path: AUTH_JSON } })).toEqual({
      block: true,
      reason: WRITE_FACET_DENY_REASON
    })
  })

  test('write workspace/base.md（非 .pi/.agents） → 放行（纵深件仅挡 .pi 与 .agents 子树）', () => {
    const handler = makeHandler()
    const base = resolve(WORKSPACE, 'base.md')
    expect(handler({ toolName: 'write', input: { path: base } })).toBeUndefined()
  })
})

describe('createKeyGuardHandler — 不防面（决策依据见 key-guard.ts 头注）', () => {
  test('ls path 即便指向 rootDir → 放行（输出仅文件名）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'ls', input: { path: ROOT } })).toBeUndefined()
  })

  test('find path 即便指向 rootDir → 放行（输出仅文件名）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'find', input: { path: ROOT } })).toBeUndefined()
  })

  test('bash input.command = "cat pi-agent/auth.json" → 放行（D 案挂起不拦）', () => {
    const handler = makeHandler()
    expect(
      handler({ toolName: 'bash', input: { command: 'cat pi-agent/auth.json' } })
    ).toBeUndefined()
  })

  test('custom 工具 toolName "render" → 放行', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'render', input: { path: AUTH_JSON } })).toBeUndefined()
  })

  test('read 但 input.path 非 string（缺参）→ 放行（SDK schema 自会拒）', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: {} })).toBeUndefined()
    expect(handler({ toolName: 'read', input: { path: 42 } })).toBeUndefined()
  })
})
