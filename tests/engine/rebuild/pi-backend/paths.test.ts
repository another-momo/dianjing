import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  BUILTIN_STUDIO_SUBPATH,
  KEY_ENV_FILENAME,
  PI_AGENT_SUBDIR,
  PI_BACKEND_TOKEN_FILENAME,
  PI_SESSIONS_ARCHIVE_SUBDIR,
  PI_SESSIONS_SUBDIR,
  SKILLS_SUBDIR,
  STATE_DIR_NAME,
  USER_STUDIO_SUBPATH,
  resolveAgentDir,
  resolveArchiveDir,
  resolveElectronRootDir,
  resolveHostRootDir,
  resolveKeyEnvPath,
  resolvePiBackendTokenPath,
  resolveRootDir,
  resolveSessionsDir,
  resolveSkillsDir,
  resolveStateDir,
  resolveStudioDirs
} from '@/app/ai/pi-backend/paths'

describe('pi-backend/paths — constants', () => {
  test('STATE_DIR_NAME is the canonical ".openpencil" (verbatim source-of-truth)', () => {
    expect(STATE_DIR_NAME).toBe('.openpencil')
  })

  test('subdir / filename constants match the original inline literals', () => {
    // 这些常量被原位 .openpencil/pi-agent、.openpencil/skills、.openpencil/studio
    // 等拼接字面量替换——值与原文一致即可保证下游拼接结果不变。
    expect(PI_AGENT_SUBDIR).toBe('pi-agent')
    expect(PI_SESSIONS_SUBDIR).toBe('pi-sessions')
    expect(PI_SESSIONS_ARCHIVE_SUBDIR).toBe('pi-sessions-archive')
    expect(KEY_ENV_FILENAME).toBe('key-env')
    expect(SKILLS_SUBDIR).toBe('skills')
    expect(PI_BACKEND_TOKEN_FILENAME).toBe('pi-backend-token')
  })

  test('USER_STUDIO_SUBPATH is ".openpencil/studio" (posix join)', () => {
    expect(USER_STUDIO_SUBPATH.replaceAll('\\', '/')).toBe('.openpencil/studio')
  })

  test('BUILTIN_STUDIO_SUBPATH is the dev source-tree location', () => {
    expect(BUILTIN_STUDIO_SUBPATH.replaceAll('\\', '/')).toBe('src/app/ai/pi-backend/studio')
  })
})

describe('pi-backend/paths — resolveStateDir and friends', () => {
  const rootDir = '/tmp/open-pencil-test-root'

  test('resolveStateDir returns rootDir + STATE_DIR_NAME', () => {
    expect(resolveStateDir(rootDir)).toBe(join(rootDir, '.openpencil'))
  })

  test('resolveAgentDir appends pi-agent', () => {
    expect(resolveAgentDir(rootDir)).toBe(join(rootDir, '.openpencil', 'pi-agent'))
  })

  test('resolveSessionsDir appends pi-sessions', () => {
    expect(resolveSessionsDir(rootDir)).toBe(join(rootDir, '.openpencil', 'pi-sessions'))
  })

  test('resolveArchiveDir appends pi-sessions-archive', () => {
    expect(resolveArchiveDir(rootDir)).toBe(join(rootDir, '.openpencil', 'pi-sessions-archive'))
  })

  test('resolveKeyEnvPath appends key-env filename', () => {
    expect(resolveKeyEnvPath(rootDir)).toBe(join(rootDir, '.openpencil', 'key-env'))
  })

  test('resolveSkillsDir appends skills', () => {
    expect(resolveSkillsDir(rootDir)).toBe(join(rootDir, '.openpencil', 'skills'))
  })

  test('resolvePiBackendTokenPath appends pi-backend-token filename', () => {
    expect(resolvePiBackendTokenPath(rootDir)).toBe(
      join(rootDir, '.openpencil', 'pi-backend-token')
    )
  })
})

describe('pi-backend/paths — resolveRootDir / resolveHostRootDir / resolveElectronRootDir', () => {
  test('resolveRootDir: env override wins, else process.cwd() (main.ts semantics)', () => {
    // env override → returns override
    expect(resolveRootDir('/explicit/root')).toBe('/explicit/root')
    // null/undefined → falls back to process.cwd()
    expect(resolveRootDir(null)).toBe(process.cwd())
  })

  test('resolveHostRootDir: always process.cwd() (host.ts implicit-cwd contract)', () => {
    // host.ts 不读 env，纯 cwd 契约
    expect(resolveHostRootDir()).toBe(process.cwd())
  })

  test('resolveElectronRootDir: env override wins, else userData fallback', () => {
    expect(resolveElectronRootDir('/env/root', '/userData')).toBe('/env/root')
    expect(resolveElectronRootDir(null, '/userData')).toBe('/userData')
    // 空串视为已设置（与 ?? 语义一致）——readRootDir() 不会返空串（空串走 null 分支）
    expect(resolveElectronRootDir('', '/userData')).toBe('')
  })
})

describe('pi-backend/paths — resolveStudioDirs', () => {
  test('with env override: builtinDir uses override; userDir always under homedir', () => {
    const dirs = resolveStudioDirs('/repo/root', '/opt/custom/studio')
    expect(dirs.builtinDir).toBe('/opt/custom/studio')
    expect(dirs.userDir).toBe(join(homedir(), '.openpencil', 'studio'))
  })

  test('without env override: builtinDir is rootDir + BUILTIN_STUDIO_SUBPATH', () => {
    const rootDir = '/repo/root'
    const dirs = resolveStudioDirs(rootDir, null)
    expect(dirs.builtinDir).toBe(join(rootDir, 'src', 'app', 'ai', 'pi-backend', 'studio'))
    expect(dirs.userDir).toBe(join(homedir(), '.openpencil', 'studio'))
  })

  test('userDir is independent of rootDir (always ~/.openpencil/studio)', () => {
    const a = resolveStudioDirs('/repo/A', null)
    const b = resolveStudioDirs('/repo/B', null)
    expect(a.userDir).toBe(b.userDir)
  })
})
