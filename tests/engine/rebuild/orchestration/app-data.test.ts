import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveAppDataRoot } from '@/app/orchestration/app-data'
import { USER_DATA_DIR_NAME } from '@/app/orchestration/brand'

// D2：状态根收口——resolveAppDataRoot 是三形态（pi-backend dev/host、
// Electron、桥 discovery）共用的「OS 标准应用数据目录」单源。本测试钉
// 三大平台的解析语义（含 APPDATA/XDG_CONFIG_HOME 缺省 fallback 与缺失
// 行为），保证上游改算法立即可见。

describe('orchestration/app-data — resolveAppDataRoot', () => {
  describe('win32', () => {
    test('uses APPDATA when set (roaming)', () => {
      const env = { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }
      const dir = resolveAppDataRoot(env, 'win32')
      expect(dir.replaceAll('\\', '/')).toBe('C:/Users/test/AppData/Roaming/Dianjing')
    })

    test('falls back to homedir/AppData/Roaming when APPDATA missing', () => {
      const env = {}
      const dir = resolveAppDataRoot(env, 'win32')
      expect(dir.replaceAll('\\', '/')).toBe(
        join(homedir(), 'AppData', 'Roaming', USER_DATA_DIR_NAME).replaceAll('\\', '/')
      )
    })

    test('falls back when APPDATA is whitespace-only', () => {
      const env = { APPDATA: '   ' }
      const dir = resolveAppDataRoot(env, 'win32')
      expect(dir.replaceAll('\\', '/')).toBe(
        join(homedir(), 'AppData', 'Roaming', USER_DATA_DIR_NAME).replaceAll('\\', '/')
      )
    })
  })

  describe('darwin', () => {
    test('uses homedir/Library/Application Support/<USER_DATA_DIR_NAME>', () => {
      const env = {}
      const dir = resolveAppDataRoot(env, 'darwin')
      expect(dir.replaceAll('\\', '/')).toBe(
        join(homedir(), 'Library', 'Application Support', USER_DATA_DIR_NAME).replaceAll('\\', '/')
      )
    })

    test('ignores APPDATA / XDG_CONFIG_HOME on darwin (those are non-canonical)', () => {
      const env = { APPDATA: '/should/ignore', XDG_CONFIG_HOME: '/should/ignore' }
      const dir = resolveAppDataRoot(env, 'darwin')
      expect(dir.replaceAll('\\', '/')).toBe(
        join(homedir(), 'Library', 'Application Support', USER_DATA_DIR_NAME).replaceAll('\\', '/')
      )
    })
  })

  describe('linux', () => {
    test('uses XDG_CONFIG_HOME when set', () => {
      const env = { XDG_CONFIG_HOME: '/srv/xdg' }
      const dir = resolveAppDataRoot(env, 'linux')
      expect(dir.replaceAll('\\', '/')).toBe('/srv/xdg/Dianjing')
    })

    test('falls back to homedir/.config when XDG_CONFIG_HOME missing', () => {
      const env = {}
      const dir = resolveAppDataRoot(env, 'linux')
      expect(dir).toBe(join(homedir(), '.config', USER_DATA_DIR_NAME))
    })

    test('falls back when XDG_CONFIG_HOME is whitespace-only', () => {
      const env = { XDG_CONFIG_HOME: '   ' }
      const dir = resolveAppDataRoot(env, 'linux')
      expect(dir).toBe(join(homedir(), '.config', USER_DATA_DIR_NAME))
    })
  })

  describe('cross-platform invariants', () => {
    test('appended segment is always USER_DATA_DIR_NAME (single source of truth)', () => {
      // USER_DATA_DIR_NAME 真源 = brand.ts；任何漂移立即可见
      expect(resolveAppDataRoot({}, 'win32').endsWith(USER_DATA_DIR_NAME)).toBe(true)
      expect(resolveAppDataRoot({}, 'darwin').endsWith(USER_DATA_DIR_NAME)).toBe(true)
      expect(resolveAppDataRoot({}, 'linux').endsWith(USER_DATA_DIR_NAME)).toBe(true)
    })

    test('null / undefined env is tolerated (treated as empty env)', () => {
      // 测试纪律：函数本身不读真实 env——null/undefined 视为「空 env」
      expect(() => resolveAppDataRoot(null, 'linux')).not.toThrow()
      expect(() => resolveAppDataRoot(undefined, 'linux')).not.toThrow()
      // darwin 不读 env，恒为 homedir/Library/Application Support/Dianjing
      expect(resolveAppDataRoot(null, 'darwin').replaceAll('\\', '/')).toBe(
        join(homedir(), 'Library', 'Application Support', USER_DATA_DIR_NAME).replaceAll('\\', '/')
      )
      expect(resolveAppDataRoot(undefined, 'linux')).toBe(
        join(homedir(), '.config', USER_DATA_DIR_NAME)
      )
    })
  })
})
