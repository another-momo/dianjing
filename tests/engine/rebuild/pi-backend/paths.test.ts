import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  BUILTIN_STUDIO_SUBPATH,
  IMAGE_GEN_OUTPUT_SUBDIR,
  KEY_ENV_FILENAME,
  PI_AGENT_SUBDIR,
  PI_BACKEND_TOKEN_FILENAME,
  PI_SESSIONS_SUBDIR,
  PI_SESSIONS_ARCHIVE_SUBDIR,
  PI_WORKSPACE_SUBDIR,
  SKILLS_SUBDIR,
  USER_STUDIO_SUBPATH,
  formatImageGenDateBucket,
  resolveAgentDir,
  resolveArchiveDir,
  resolveElectronRootDir,
  resolveImageGenDatedDir,
  resolveImageGenOutputDir,
  resolveKeyEnvPath,
  resolvePiBackendTokenPath,
  resolveRootDir,
  resolveSessionsDir,
  resolveSkillsDir,
  resolveStateDir,
  resolveStudioDirs,
  resolveWorkspaceDir,
  toDisplayPath
} from '@/app/ai/pi-backend/paths'

// D2：扁平化——STATE_DIR_NAME 概念消亡，子目录直接挂 rootDir。pi-agent/
// pi-sessions/ 等子目录名常量保留（值未变），只是不再嵌入顶层 .dianjing。

describe('pi-backend/paths — constants', () => {
  test('subdir / filename constants match the original inline literals', () => {
    // 这些常量被原位 pi-agent、skills、studio 等拼接字面量替换——
    // 值与原文一致即可保证下游拼接结果不变。
    expect(PI_AGENT_SUBDIR).toBe('pi-agent')
    expect(PI_SESSIONS_SUBDIR).toBe('pi-sessions')
    expect(PI_SESSIONS_ARCHIVE_SUBDIR).toBe('pi-sessions-archive')
    expect(KEY_ENV_FILENAME).toBe('key-env')
    expect(SKILLS_SUBDIR).toBe('skills')
    expect(PI_BACKEND_TOKEN_FILENAME).toBe('pi-backend-token')
  })

  test('USER_STUDIO_SUBPATH is workspace/.agents（2026-09-18 重排：平铺进 workspace）', () => {
    // 2026-09-18 userdata 重排：用户扩展层 `studio` → `workspace/.agents`
    // （复数命名对齐 pi SDK 原生 `.agents/skills` 约定）
    expect(USER_STUDIO_SUBPATH.replaceAll('\\', '/')).toBe('workspace/.agents')
  })

  test('BUILTIN_STUDIO_SUBPATH is the dev source-tree location', () => {
    expect(BUILTIN_STUDIO_SUBPATH.replaceAll('\\', '/')).toBe('src/app/ai/pi-backend/studio')
  })
})

describe('pi-backend/paths — resolveStateDir and friends (D2: flat under rootDir)', () => {
  const rootDir = '/tmp/dianjing-test-root'

  test('resolveStateDir returns rootDir verbatim (D2: identity, no .dianjing layer)', () => {
    expect(resolveStateDir(rootDir)).toBe(rootDir)
  })

  test('resolveAgentDir appends pi-agent directly under rootDir', () => {
    expect(resolveAgentDir(rootDir)).toBe(join(rootDir, 'pi-agent'))
  })

  test('resolveSessionsDir appends pi-sessions directly under rootDir', () => {
    expect(resolveSessionsDir(rootDir)).toBe(join(rootDir, 'pi-sessions'))
  })

  test('resolveArchiveDir appends pi-sessions-archive directly under rootDir', () => {
    expect(resolveArchiveDir(rootDir)).toBe(join(rootDir, 'pi-sessions-archive'))
  })

  test('resolveKeyEnvPath appends key-env filename directly under rootDir', () => {
    expect(resolveKeyEnvPath(rootDir)).toBe(join(rootDir, 'key-env'))
  })

  test('resolveSkillsDir appends skills under workspace/.agents（与 workflows/profiles 同根）', () => {
    expect(resolveSkillsDir(rootDir)).toBe(join(rootDir, 'workspace', '.agents', 'skills'))
  })

  test('resolveImageGenOutputDir = workspace/image-gen-output（2026-09-18 重排进 workspace）', () => {
    expect(IMAGE_GEN_OUTPUT_SUBDIR.replaceAll('\\', '/')).toBe('workspace/image-gen-output')
    expect(resolveImageGenOutputDir(rootDir)).toBe(join(rootDir, 'workspace', 'image-gen-output'))
  })

  test('resolveImageGenDatedDir = 输出根 + YYYY-MM-DD 桶（本地时区，字典序=时序）', () => {
    const date = new Date(2026, 0, 5) // 2026-01-05 本地
    expect(formatImageGenDateBucket(date)).toBe('2026-01-05')
    expect(resolveImageGenDatedDir(rootDir, date)).toBe(
      join(rootDir, 'workspace', 'image-gen-output', '2026-01-05')
    )
    // 年末/月末零填充钉扎
    expect(formatImageGenDateBucket(new Date(2026, 11, 31))).toBe('2026-12-31')
  })

  test('resolvePiBackendTokenPath appends pi-backend-token filename directly under rootDir', () => {
    expect(resolvePiBackendTokenPath(rootDir)).toBe(join(rootDir, 'pi-backend-token'))
  })

  test('PI_WORKSPACE_SUBDIR is "workspace"（key 守卫 B 案，会话 cwd 下沉落点）', () => {
    expect(PI_WORKSPACE_SUBDIR).toBe('workspace')
  })

  test('resolveWorkspaceDir appends workspace directly under rootDir', () => {
    expect(resolveWorkspaceDir(rootDir)).toBe(join(rootDir, 'workspace'))
  })
})

describe('pi-backend/paths — resolveRootDir / resolveElectronRootDir', () => {
  test('resolveRootDir: env override wins, else resolveAppDataRoot(env) (D2)', () => {
    // env override → returns override (D2: override 直指根, 不再内含 .dianjing)
    expect(resolveRootDir('/explicit/root', {}, 'linux').replaceAll('\\', '/')).toBe(
      '/explicit/root'
    )
    // null → 走 resolveAppDataRoot(env=..., platform=...)；linux fallback 为 ~/.config/Dianjing
    const resolved = resolveRootDir(null, {}, 'linux')
    expect(resolved.replaceAll('\\', '/')).toBe(
      join(process.env.HOME ?? '/root', '.config', 'Dianjing').replaceAll('\\', '/')
    )
  })

  test('resolveElectronRootDir: env override wins, else userData fallback (D2)', () => {
    expect(resolveElectronRootDir('/env/root', '/userData')).toBe('/env/root')
    expect(resolveElectronRootDir(null, '/userData')).toBe('/userData')
    // 空串视为已设置（与 ?? 语义一致）——readRootDir() 不会返空串（空串走 null 分支）
    expect(resolveElectronRootDir('', '/userData')).toBe('')
  })
})

describe('pi-backend/paths — resolveStudioDirs（2026-09-18：userDir = rootDir/workspace/.agents）', () => {
  test('with env override: builtinDir uses override; userDir = rootDir/workspace/.agents', () => {
    const dirs = resolveStudioDirs('/repo/root', '/opt/custom/studio')
    expect(dirs.builtinDir.replaceAll('\\', '/')).toBe('/opt/custom/studio')
    expect(dirs.userDir.replaceAll('\\', '/')).toBe('/repo/root/workspace/.agents')
  })

  test('without env override: builtinDir = rootDir/BUILTIN_STUDIO_SUBPATH; userDir = rootDir/workspace/.agents', () => {
    const rootDir = '/repo/root'
    const dirs = resolveStudioDirs(rootDir, null)
    expect(dirs.builtinDir).toBe(join(rootDir, 'src', 'app', 'ai', 'pi-backend', 'studio'))
    expect(dirs.userDir).toBe(join(rootDir, 'workspace', '.agents'))
  })

  test('userDir tracks rootDir (D2: 不再独立于 rootDir)', () => {
    const a = resolveStudioDirs('/repo/A', null)
    const b = resolveStudioDirs('/repo/B', null)
    expect(a.userDir).not.toBe(b.userDir)
    expect(a.userDir.replaceAll('\\', '/')).toBe('/repo/A/workspace/.agents')
    expect(b.userDir.replaceAll('\\', '/')).toBe('/repo/B/workspace/.agents')
  })

  test('两层资产语义零变化：内置只读 + 用户可写路径同源 (D2 验证)', () => {
    // 内置只读——builtinDir 走 rootDir + BUILTIN_STUDIO_SUBPATH（dev 源码树）
    // 用户可写——userDir 走 rootDir + workspace/.agents（与状态根同位）
    // 两者同源 = 同一 rootDir，registry / seed / service 的同 id 覆盖 +
    // _ 前缀跳过 + seed warn-only 语义由上游层承担，本函数不掺行为。
    const dirs = resolveStudioDirs('/state/root', null)
    expect(dirs.builtinDir.replaceAll('\\', '/')).toBe('/state/root/src/app/ai/pi-backend/studio')
    expect(dirs.userDir.replaceAll('\\', '/')).toBe('/state/root/workspace/.agents')
    // userDir 不嵌任何 `.dianjing` 子层（D2 关键断言）
    expect(dirs.userDir.replaceAll('\\', '/')).not.toContain('.dianjing')
  })
})

describe('pi-backend/paths — toDisplayPath（后端计算 UI 展示形态）', () => {
  // 测试纪律：注入 env 而非读 process.platform / process.env.APPDATA /
  // os.homedir()——保证 posix CI 也能覆盖 win32 分支；同段也复刻各形态边界。
  test('win32 + APPDATA 前缀命中 → %APPDATA% + 余段（尾巴反斜杠保留）', () => {
    const result = toDisplayPath(
      'C:\\Users\\x\\AppData\\Roaming\\Dianjing\\workspace\\image-gen-output',
      { platform: 'win32', appDataDir: 'C:\\Users\\x\\AppData\\Roaming' }
    )
    // slice 在原串上做——反斜杠分隔符原样保留
    expect(result).toBe('%APPDATA%\\Dianjing\\workspace\\image-gen-output')
  })

  test('win32 前缀不命中 → 原样返回绝对路径（DIANJING_ROOT_DIR 隔离场景）', () => {
    const result = toDisplayPath('D:\\spike\\root\\workspace\\image-gen-output', {
      platform: 'win32',
      appDataDir: 'C:\\Users\\x\\AppData\\Roaming'
    })
    expect(result).toBe('D:\\spike\\root\\workspace\\image-gen-output')
  })

  test('win32 appDataDir = null → 原样返回（无 env 信息时的安全兜底）', () => {
    const result = toDisplayPath('C:\\Users\\x\\AppData\\Roaming\\Dianjing\\workspace\\.agents', {
      platform: 'win32',
      appDataDir: null
    })
    expect(result).toBe('C:\\Users\\x\\AppData\\Roaming\\Dianjing\\workspace\\.agents')
  })

  test('darwin + home 前缀命中 → ~ + 余段（macOS 应用数据子目录形态）', () => {
    const result = toDisplayPath(
      '/Users/alice/Library/Application Support/Dianjing/workspace/.agents',
      { platform: 'darwin', homeDir: '/Users/alice' }
    )
    expect(result).toBe('~/Library/Application Support/Dianjing/workspace/.agents')
  })

  test('linux + home 前缀命中 → ~ + 余段（XDG_CONFIG_HOME 落形态）', () => {
    const result = toDisplayPath('/home/bob/.config/Dianjing/workspace/.agents', {
      platform: 'linux',
      homeDir: '/home/bob'
    })
    expect(result).toBe('~/.config/Dianjing/workspace/.agents')
  })

  test('非 win32 + home 外 → 原样返回绝对路径', () => {
    const result = toDisplayPath('/var/spike/root/workspace/.agents', {
      platform: 'linux',
      homeDir: '/home/bob'
    })
    expect(result).toBe('/var/spike/root/workspace/.agents')
  })

  test('非 win32 + homeDir = null → 原样返回', () => {
    const result = toDisplayPath('/home/bob/.config/Dianjing/workspace/.agents', {
      platform: 'linux',
      homeDir: null
    })
    expect(result).toBe('/home/bob/.config/Dianjing/workspace/.agents')
  })

  test('边界：相似前缀不命中——/home/user2 不被 /home/user 吞', () => {
    // 字符串前缀匹配 ≠ 路径边界匹配——必须显式加 '/' 守卫；否则
    // /home/user2/foo 会被误判为 /home/user 的子目录
    const result = toDisplayPath('/home/user2/Dianjing/workspace/.agents', {
      platform: 'linux',
      homeDir: '/home/user'
    })
    expect(result).toBe('/home/user2/Dianjing/workspace/.agents')
  })

  test('边界：home 前缀带尾随斜杠仍命中（normalize 剥尾 /）', () => {
    const result = toDisplayPath('/home/bob/.config/Dianjing/workspace/.agents', {
      platform: 'linux',
      homeDir: '/home/bob/'
    })
    expect(result).toBe('~/.config/Dianjing/workspace/.agents')
  })

  test('边界：win32 同名 path=appDataDir 自身也算命中（精确等于分支）', () => {
    const result = toDisplayPath('C:\\Users\\x\\AppData\\Roaming', {
      platform: 'win32',
      appDataDir: 'C:\\Users\\x\\AppData\\Roaming'
    })
    expect(result).toBe('%APPDATA%')
  })
})
