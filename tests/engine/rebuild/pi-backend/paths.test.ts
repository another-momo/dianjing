import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  BUILTIN_STUDIO_SUBPATH,
  KEY_ENV_FILENAME,
  PI_AGENT_SUBDIR,
  PI_BACKEND_TOKEN_FILENAME,
  PI_SESSIONS_SUBDIR,
  PI_SESSIONS_ARCHIVE_SUBDIR,
  PI_WORKSPACE_SUBDIR,
  SKILLS_SUBDIR,
  USER_STUDIO_SUBPATH,
  resolveAgentDir,
  resolveArchiveDir,
  resolveElectronRootDir,
  resolveKeyEnvPath,
  resolvePiBackendTokenPath,
  resolveRootDir,
  resolveSessionsDir,
  resolveSkillsDir,
  resolveStateDir,
  resolveStudioDirs,
  resolveWorkspaceDir
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

  test('USER_STUDIO_SUBPATH is just "studio" (no STATE_DIR_NAME layer, D2)', () => {
    // D2 起 USER_STUDIO_SUBPATH 不再嵌入 `.dianjing`——userDir 随 rootDir 走
    expect(USER_STUDIO_SUBPATH).toBe('studio')
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

  test('resolveSkillsDir appends skills under rootDir/studio (与 workflows/profiles 同根)', () => {
    expect(resolveSkillsDir(rootDir)).toBe(join(rootDir, 'studio', 'skills'))
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

describe('pi-backend/paths — resolveStudioDirs (D2: userDir 随 rootDir 走)', () => {
  test('with env override: builtinDir uses override; userDir = rootDir/studio', () => {
    const dirs = resolveStudioDirs('/repo/root', '/opt/custom/studio')
    expect(dirs.builtinDir.replaceAll('\\', '/')).toBe('/opt/custom/studio')
    expect(dirs.userDir.replaceAll('\\', '/')).toBe('/repo/root/studio')
  })

  test('without env override: builtinDir = rootDir/BUILTIN_STUDIO_SUBPATH; userDir = rootDir/studio', () => {
    const rootDir = '/repo/root'
    const dirs = resolveStudioDirs(rootDir, null)
    expect(dirs.builtinDir).toBe(join(rootDir, 'src', 'app', 'ai', 'pi-backend', 'studio'))
    expect(dirs.userDir).toBe(join(rootDir, 'studio'))
  })

  test('userDir tracks rootDir (D2: 不再独立于 rootDir)', () => {
    const a = resolveStudioDirs('/repo/A', null)
    const b = resolveStudioDirs('/repo/B', null)
    expect(a.userDir).not.toBe(b.userDir)
    expect(a.userDir.replaceAll('\\', '/')).toBe('/repo/A/studio')
    expect(b.userDir.replaceAll('\\', '/')).toBe('/repo/B/studio')
  })

  test('两层资产语义零变化：内置只读 + 用户可写路径同源 (D2 验证)', () => {
    // 内置只读——builtinDir 走 rootDir + BUILTIN_STUDIO_SUBPATH（dev 源码树）
    // 用户可写——userDir 走 rootDir + 'studio'（与状态根同位）
    // 两者同源 = 同一 rootDir，registry / seed / service 的同 id 覆盖 +
    // _ 前缀跳过 + seed warn-only 语义由上游层承担，本函数不掺行为。
    const dirs = resolveStudioDirs('/state/root', null)
    expect(dirs.builtinDir.replaceAll('\\', '/')).toBe('/state/root/src/app/ai/pi-backend/studio')
    expect(dirs.userDir.replaceAll('\\', '/')).toBe('/state/root/studio')
    // userDir 不嵌任何 `.dianjing` 子层（D2 关键断言）
    expect(dirs.userDir.replaceAll('\\', '/')).not.toContain('.dianjing')
  })
})
