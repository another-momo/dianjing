/**
 * 2026-09-18 broker P0-1 判定面收编：decidePath（path-decision.ts）直钉单测。
 * 2026-09-19 A线尾单件1 翻正：read facet = 敏感名单硬拒 + 名单外全 allow
 * （含界外，ok 侧 outside 分类标记）；write facet 语义不动。
 *
 * 覆盖：read facet 三态（凭据六件 deny=protected / 敏感名单 deny=sensitive
 * ~/.ssh·~/.aws·.env·.pem / 界内 allow outside=false / 界外 allow
 * outside=true——含 rootDir 一级与盘外）/ write facet 回归（写侧三根 deny
 * protected、workspace 子树 allow、界外 deny outside）/ 名单源导出钉扎
 * （protectedCredentialFiles 六件 / protectedWriteRoots 三根 /
 * sensitiveReadDirPaths 两件——自 key-guard 收编的单一真源）/
 * bridge.json 落点三形态（env override deny / rootDir 被搬走时平台默认
 * 落点仍 deny / 缺省形态不重复登记——env 源注入 fixture 防读真实环境）。
 *
 * fixture = 纯字符串路径运算（无真实 IO），与 key-guard.test.ts 同纪律。
 */
import { describe, expect, test } from 'bun:test'
import { join, resolve, sep } from 'node:path'

import {
  decidePath,
  protectedCredentialFiles,
  protectedWriteRoots,
  sensitiveReadDirPaths
} from '@/app/ai/pi-backend/path-decision'
import { resolveAppDataRoot } from '@/app/orchestration/app-data'

const ROOT = resolve('/fake/pd-root')
const WORKSPACE = resolve(ROOT, 'workspace')

/** env fixture（平台 appData 根可复算；无 override 键 = 无桥发现路径覆盖） */
const ENV_FIXTURE = {
  APPDATA: '/fixture/appdata-roaming',
  XDG_CONFIG_HOME: '/fixture/xdg-config'
}
/** 守卫内部 resolveAppDataRoot(env) 用 process.platform——测试同参复算对齐 */
const PLATFORM_APP_DATA_ROOT = resolveAppDataRoot(ENV_FIXTURE, process.platform)
const PLATFORM_BRIDGE_JSON = join(PLATFORM_APP_DATA_ROOT, 'bridge.json')
/** 旧名 mcp.json 的平台默认落点（读侧兼容回退残留——同含明文桥 token） */
const PLATFORM_LEGACY_MCP_JSON = join(PLATFORM_APP_DATA_ROOT, 'mcp.json')

function decide(input: string, facet: 'read' | 'write' = 'read') {
  // env 恒注入 fixture——缺省 process.env 会让 bridge.json 落点解析在 darwin
  // 被 homedir 兜底旁路、在 CI/本机间漂移，测试须全平台 hermetic
  return decidePath(input, { facet, rootDir: ROOT, homeDir: ROOT, env: ENV_FIXTURE })
}

describe('名单源导出（A线尾单自 key-guard 收编的单一真源）', () => {
  test('protectedCredentialFiles = 凭据六件 + 平台默认 bridge.json 形（env fixture 注入）', () => {
    expect(protectedCredentialFiles(ROOT, ENV_FIXTURE)).toEqual([
      resolve(ROOT, 'key-env'),
      resolve(ROOT, 'pi-backend-token'),
      resolve(ROOT, 'pi-agent', 'auth.json'),
      resolve(ROOT, 'pi-agent', 'image-gen.json'),
      resolve(ROOT, 'pi-agent', 'mcp-connections.json'),
      resolve(ROOT, 'bridge.json'),
      resolve(ROOT, 'mcp.json'),
      PLATFORM_BRIDGE_JSON,
      PLATFORM_LEGACY_MCP_JSON
    ])
  })

  test('旧名 mcp.json 随 rootDir 形与平台默认形同补（override 形态无旧名回退）', () => {
    const list = protectedCredentialFiles(ROOT, ENV_FIXTURE)
    expect(list.filter((p) => p.endsWith(sep + 'mcp.json'))).toEqual([
      resolve(ROOT, 'mcp.json'),
      PLATFORM_LEGACY_MCP_JSON
    ])
    const d = decidePath(join(PLATFORM_APP_DATA_ROOT, 'mcp.json'), {
      facet: 'read',
      rootDir: ROOT,
      homeDir: ROOT,
      env: ENV_FIXTURE
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.denyCause).toBe('protected')
  })

  test('bridge.json 三形态不重复登记（缺省 rootDir 形 + 平台默认形异根并存）', () => {
    const list = protectedCredentialFiles(ROOT, ENV_FIXTURE)
    const bridgeEntries = list.filter((p) => p.endsWith(sep + 'bridge.json'))
    expect(bridgeEntries).toEqual([resolve(ROOT, 'bridge.json'), PLATFORM_BRIDGE_JSON])
  })

  test('DIANJING_BRIDGE_DISCOVERY_PATH override 进名单（trim 语义随桥侧 reader）', () => {
    const override = resolve('/fixture/bridge-iso', 'bridge.json')
    const list = protectedCredentialFiles(ROOT, {
      ...ENV_FIXTURE,
      DIANJING_BRIDGE_DISCOVERY_PATH: `  ${override}  `
    })
    expect(list).toContain(override)
    // trim 后原值不重复登记
    expect(list.filter((p) => p.endsWith(sep + 'bridge.json')).length).toBe(3)
  })

  test('缺省形态（rootDir 即平台状态根）bridge.json 收敛为一条', () => {
    const root = resolveAppDataRoot(ENV_FIXTURE, process.platform)
    const list = protectedCredentialFiles(root, ENV_FIXTURE)
    expect(list.filter((p) => p.endsWith(sep + 'bridge.json'))).toEqual([join(root, 'bridge.json')])
  })

  test('protectedWriteRoots = 写侧三根（pi-agent + workspace/.pi + workspace/.agents）', () => {
    expect(protectedWriteRoots(ROOT)).toEqual([
      resolve(ROOT, 'pi-agent'),
      resolve(WORKSPACE, '.pi'),
      resolve(WORKSPACE, '.agents')
    ])
  })

  test('sensitiveReadDirPaths = homeDir 下 .ssh 与 .aws', () => {
    expect(sensitiveReadDirPaths(ROOT)).toEqual([resolve(ROOT, '.ssh'), resolve(ROOT, '.aws')])
  })
})

describe('decidePath read facet —— 界内界外全 allow（名单外）', () => {
  test('workspace 子树绝对路径 → allow，outside=false（absolutePath 大小写保留）', () => {
    const target = resolve(WORKSPACE, 'Assets', 'Logo.PNG')
    const d = decide(target)
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.absolutePath).toBe(target.replaceAll('\\', '/'))
      expect(d.outside).toBe(false)
    }
  })

  test('相对路径按缺省 cwd（workspace）解析 → allow outside=false', () => {
    const d = decide('logo.png')
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.absolutePath).toBe(resolve(WORKSPACE, 'logo.png').replaceAll('\\', '/'))
      expect(d.outside).toBe(false)
    }
  })

  test('workspace 本体（恰等于 workspace 目录）→ allow outside=false', () => {
    const d = decide(WORKSPACE)
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.outside).toBe(false)
  })

  test('界外（rootDir 一级）→ allow，outside=true（读族界外静默放行）', () => {
    const d = decide(resolve(ROOT, 'secret.png'))
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.outside).toBe(true)
  })

  test('盘外绝对路径 → allow，outside=true', () => {
    const d = decide('/etc/hosts/logo.png')
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.outside).toBe(true)
  })

  test('workspace/.agents/** 与 workspace/.pi/** → allow（写侧三根不拦读）', () => {
    expect(decide(resolve(WORKSPACE, '.agents', 'skills', 'x', 'SKILL.md')).ok).toBe(true)
    expect(decide(resolve(WORKSPACE, '.pi', 'settings.json')).ok).toBe(true)
  })

  test('pi-agent/settings.json（非凭据）→ allow（读侧名单 = 凭据名单+敏感名单）', () => {
    expect(decide(resolve(ROOT, 'pi-agent', 'settings.json')).ok).toBe(true)
  })
})

describe('decidePath read facet —— 敏感名单硬拒', () => {
  test('凭据六件 → deny，denyCause=protected，absolutePath 带出', () => {
    for (const target of protectedCredentialFiles(ROOT, ENV_FIXTURE)) {
      const d = decide(target)
      expect(d.ok).toBe(false)
      if (!d.ok) {
        expect(d.reason).toBe('denied')
        expect(d.denyCause).toBe('protected')
        expect(d.error).toContain('credentials/tokens')
        expect(d.absolutePath).toBe(target.replaceAll('\\', '/'))
      }
    }
  })

  test('~/pi-agent/auth.json（~ 展开命中，homeDir=root）→ deny protected', () => {
    const d = decide('~/pi-agent/auth.json')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.denyCause).toBe('protected')
  })

  test('~/.ssh/id_rsa 与 ~/.aws/credentials → deny，denyCause=sensitive', () => {
    for (const target of ['~/.ssh/id_rsa', resolve(ROOT, '.aws', 'credentials')]) {
      const d = decide(target)
      expect(d.ok).toBe(false)
      if (!d.ok) {
        expect(d.denyCause).toBe('sensitive')
        expect(d.error).toContain('sensitive system or credential file')
      }
    }
  })

  test('workspace 内 .env → deny sensitive（fail-safe 过挡现状保留）', () => {
    const d = decide(resolve(WORKSPACE, '.env'))
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.denyCause).toBe('sensitive')
  })

  test('任意深度 .env.production 与 *.pem → deny sensitive', () => {
    for (const target of [resolve(WORKSPACE, 'config', '.env.production'), '/etc/ssl/server.pem']) {
      const d = decide(target)
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.denyCause).toBe('sensitive')
    }
  })

  test('workspace/foo.env 与 note.pem.md 与 ~/.sshconfig → allow（非名单模式）', () => {
    expect(decide(resolve(WORKSPACE, 'foo.env')).ok).toBe(true)
    expect(decide(resolve(WORKSPACE, 'note.pem.md')).ok).toBe(true)
    expect(decide('~/.sshconfig').ok).toBe(true)
  })
})

describe('decidePath read facet —— bridge.json 落点三形态（env 透传）', () => {
  test('DIANJING_BRIDGE_DISCOVERY_PATH override 落点 → deny protected（dev 形态隔离落点）', () => {
    const override = resolve('/fixture/bridge-iso', 'bridge.json')
    const d = decidePath(override, {
      facet: 'read',
      rootDir: ROOT,
      homeDir: ROOT,
      env: { DIANJING_BRIDGE_DISCOVERY_PATH: override }
    })
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.denyCause).toBe('protected')
      expect(d.error).toContain('credentials/tokens')
    }
  })

  test('rootDir 被搬走（DIANJING_ROOT_DIR 场景）时平台默认 bridge.json 落点仍 deny', () => {
    const movedRoot = resolve('/fixture/moved-root')
    const d = decidePath(PLATFORM_BRIDGE_JSON, {
      facet: 'read',
      rootDir: movedRoot,
      homeDir: ROOT,
      env: ENV_FIXTURE
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.denyCause).toBe('protected')
  })

  test('缺省形态（rootDir 即平台状态根）bridge.json → deny（rootDir 形覆盖，不重复）', () => {
    const root = resolveAppDataRoot(ENV_FIXTURE, process.platform)
    const d = decidePath(join(root, 'bridge.json'), {
      facet: 'read',
      rootDir: root,
      homeDir: ROOT,
      env: ENV_FIXTURE
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.denyCause).toBe('protected')
  })
})

describe('decidePath write facet —— 现行语义不动（回归）', () => {
  test('workspace 子树 → allow，outside=false', () => {
    const d = decide(resolve(WORKSPACE, 'out.png'), 'write')
    expect(d.ok).toBe(true)
    if (d.ok) expect(d.outside).toBe(false)
  })

  test('workspace/.agents/** → deny，denyCause=protected，absolutePath 带出', () => {
    const target = resolve(WORKSPACE, '.agents', 'skills', 'x', 'SKILL.md')
    const d = decide(target, 'write')
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.reason).toBe('denied')
      expect(d.denyCause).toBe('protected')
      expect(d.error).toContain('protected agent configuration area')
      expect(d.absolutePath).toBe(target.replaceAll('\\', '/'))
    }
  })

  test('pi-agent/**（~ 展开命中，homeDir=root）→ deny protected', () => {
    const d = decide('~/pi-agent/settings.json', 'write')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.denyCause).toBe('protected')
  })

  test('出界（rootDir 一级）→ deny，denyCause=outside', () => {
    const d = decide(resolve(ROOT, 'secret.png'), 'write')
    expect(d.ok).toBe(false)
    if (!d.ok) {
      expect(d.denyCause).toBe('outside')
      expect(d.error).toContain('outside workspace')
    }
  })

  test('盘外绝对路径 → deny outside', () => {
    const d = decide('/etc/hosts/logo.png', 'write')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.denyCause).toBe('outside')
  })
})
