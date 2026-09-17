import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_IMAGE_GEN_TIMEOUT_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  LOCAL_AUTOMATION_APP_VERSION_KEY,
  LOCAL_AUTOMATION_HTTP_URL_KEY,
  LOCAL_AUTOMATION_TOKEN_KEY,
  LOCAL_AUTOMATION_URL_KEY,
  RUNTIME_AUTOMATION_TOKEN_KEY,
  RUNTIME_BRIDGE_URL_KEY,
  RUNTIME_ELECTRON_KEY,
  RUNTIME_GLOBALS,
  isRuntimeGlobalKey,
  readBridgeAppAttachTimeoutMs,
  readBridgeAuthToken,
  readBridgeCORSOrigin,
  readBridgeDiscoveryPathOverride,
  readBridgeReadyMarker,
  readBridgeRoot,
  readBridgeSocketPath,
  readBridgeTcpPort,
  readDevAutomationAuthToken,
  readDevBridgePort,
  readDevOrigin,
  readElectronBackendPort,
  readElectronBridgePort,
  readElectronLoopbackPort,
  readFullSmokeMode,
  readImageGenTimeoutMs,
  readMaxSessions,
  readPiAuthToken,
  readPiBackendPort,
  readPortlessURL,
  readRootDir,
  readRPCTimeoutMs,
  readSessionMaxAgeDays,
  readShowWindow,
  readSmokeMode,
  readStudioBuiltinDir,
  readTauriDevHost
} from '@/app/orchestration/env'

// 所有 reader 接受 EnvSource 参数——测试可注入任意键值集合，避开真实 process.env。
// 每个 test 用小 fresh env，确保互不污染。

describe('orchestration/env — runtime-globals constants', () => {
  test('constant values match vite define + runtime global names (verbatim source-of-truth)', () => {
    // 与 bridge/runtime.ts / url.ts / vite.config.ts / desktop-electron/main/main.ts
    // 的 declare global 与 define 键字面量必须同源——任何漂移即字面量契约破裂。
    expect(RUNTIME_AUTOMATION_TOKEN_KEY).toBe('__DIANJING_RUNTIME_AUTOMATION_TOKEN__')
    expect(RUNTIME_BRIDGE_URL_KEY).toBe('__DIANJING_RUNTIME_BRIDGE_URL__')
    expect(RUNTIME_ELECTRON_KEY).toBe('__DIANJING_ELECTRON__')
    expect(LOCAL_AUTOMATION_TOKEN_KEY).toBe('__DIANJING_LOCAL_AUTOMATION_TOKEN__')
    expect(LOCAL_AUTOMATION_URL_KEY).toBe('__DIANJING_LOCAL_AUTOMATION_URL__')
    expect(LOCAL_AUTOMATION_HTTP_URL_KEY).toBe('__DIANJING_LOCAL_AUTOMATION_HTTP_URL__')
    expect(LOCAL_AUTOMATION_APP_VERSION_KEY).toBe('__DIANJING_APP_VERSION__')
  })

  test('RUNTIME_GLOBALS aggregates all keys (used by isRuntimeGlobalKey)', () => {
    expect(Object.keys(RUNTIME_GLOBALS).sort()).toEqual([
      'LOCAL_AUTOMATION_APP_VERSION_KEY',
      'LOCAL_AUTOMATION_HTTP_URL_KEY',
      'LOCAL_AUTOMATION_TOKEN_KEY',
      'LOCAL_AUTOMATION_URL_KEY',
      'RUNTIME_AUTOMATION_TOKEN_KEY',
      'RUNTIME_BRIDGE_URL_KEY',
      'RUNTIME_ELECTRON_KEY'
    ])
  })

  test('isRuntimeGlobalKey returns true for known keys, false for unknown', () => {
    expect(isRuntimeGlobalKey('__DIANJING_RUNTIME_AUTOMATION_TOKEN__')).toBe(true)
    expect(isRuntimeGlobalKey('__NOT_A_REAL_KEY__')).toBe(false)
    expect(isRuntimeGlobalKey('')).toBe(false)
  })
})

describe('orchestration/env — readBridgeTcpPort', () => {
  test('defaults to 7600 when env.PORT is undefined', () => {
    expect(readBridgeTcpPort({})).toBe(7600)
  })

  test('parses valid port including 0 (disable TCP)', () => {
    expect(readBridgeTcpPort({ PORT: '0' })).toBe(0)
    expect(readBridgeTcpPort({ PORT: '7600' })).toBe(7600)
    expect(readBridgeTcpPort({ PORT: '65535' })).toBe(65535)
    expect(readBridgeTcpPort({ PORT: '  8080  ' })).toBe(8080)
  })

  test('throws on non-digit strings (rejects "7600abc" — Number.parseInt would silently parse)', () => {
    expect(() => readBridgeTcpPort({ PORT: '7600abc' })).toThrow(/PORT must be an integer/)
    expect(() => readBridgeTcpPort({ PORT: '0x50' })).toThrow(/PORT must be an integer/)
    expect(() => readBridgeTcpPort({ PORT: '' })).toThrow(/PORT must be an integer/)
  })

  test('throws when port is out of range (negative or > 65535)', () => {
    expect(() => readBridgeTcpPort({ PORT: '-1' })).toThrow(/PORT must be an integer/)
    expect(() => readBridgeTcpPort({ PORT: '65536' })).toThrow(/PORT must be an integer/)
  })
})

describe('orchestration/env — readBridgeAuthToken', () => {
  test('undefined → undefined (let startServer auto-generate)', () => {
    expect(readBridgeAuthToken({})).toBeUndefined()
  })

  test('empty string → null (explicit disable auth)', () => {
    expect(readBridgeAuthToken({ DIANJING_BRIDGE_AUTH_TOKEN: '' })).toBeNull()
  })

  test('non-empty string is trimmed', () => {
    expect(readBridgeAuthToken({ DIANJING_BRIDGE_AUTH_TOKEN: 'tok-xyz' })).toBe('tok-xyz')
    expect(readBridgeAuthToken({ DIANJING_BRIDGE_AUTH_TOKEN: '  tok  ' })).toBe('tok')
  })

  test('whitespace-only throws (silent fallback protection)', () => {
    expect(() => readBridgeAuthToken({ DIANJING_BRIDGE_AUTH_TOKEN: '   ' })).toThrow(
      /whitespace-only/
    )
  })
})

describe('orchestration/env — readBridgeCORSOrigin / Socket / Discovery / Root', () => {
  test('readBridgeCORSOrigin returns null for unset/empty and trimmed value otherwise', () => {
    expect(readBridgeCORSOrigin({})).toBeNull()
    expect(readBridgeCORSOrigin({ DIANJING_BRIDGE_CORS_ORIGIN: '' })).toBeNull()
    expect(readBridgeCORSOrigin({ DIANJING_BRIDGE_CORS_ORIGIN: '  http://x  ' })).toBe('http://x')
  })

  test('readBridgeSocketPath trims and treats empty as null', () => {
    expect(readBridgeSocketPath({})).toBeNull()
    expect(readBridgeSocketPath({ DIANJING_BRIDGE_SOCKET: '/tmp/x.sock' })).toBe('/tmp/x.sock')
    expect(readBridgeSocketPath({ DIANJING_BRIDGE_SOCKET: '  ' })).toBeNull()
  })

  test('readBridgeDiscoveryPathOverride trims and treats empty as null', () => {
    expect(readBridgeDiscoveryPathOverride({})).toBeNull()
    expect(readBridgeDiscoveryPathOverride({ DIANJING_BRIDGE_DISCOVERY_PATH: '/tmp/x.json' })).toBe(
      '/tmp/x.json'
    )
  })

  test('readBridgeRoot returns null for unset and trimmed value otherwise', () => {
    expect(readBridgeRoot({})).toBeNull()
    expect(readBridgeRoot({ DIANJING_BRIDGE_ROOT: '/path' })).toBe('/path')
    expect(readBridgeRoot({ DIANJING_BRIDGE_ROOT: '  ' })).toBeNull()
  })
})

describe('orchestration/env — readBridgeAppAttachTimeoutMs', () => {
  test('undefined / unset → undefined (timeout disabled)', () => {
    expect(readBridgeAppAttachTimeoutMs({})).toBeUndefined()
    expect(readBridgeAppAttachTimeoutMs({ DIANJING_BRIDGE_APP_TIMEOUT_MS: '' })).toBeUndefined()
    expect(readBridgeAppAttachTimeoutMs({ DIANJING_BRIDGE_APP_TIMEOUT_MS: '  ' })).toBeUndefined()
  })

  test('valid integer returns the value', () => {
    expect(readBridgeAppAttachTimeoutMs({ DIANJING_BRIDGE_APP_TIMEOUT_MS: '5000' })).toBe(5000)
  })

  test('rejects non-digit strings (mirrors bridge/server/index.ts strict parse)', () => {
    expect(() => readBridgeAppAttachTimeoutMs({ DIANJING_BRIDGE_APP_TIMEOUT_MS: '5s' })).toThrow(
      /non-negative integer/
    )
  })
})

describe('orchestration/env — readRPCTimeoutMs / DEFAULT_RPC_TIMEOUT_MS', () => {
  test('DEFAULT_RPC_TIMEOUT_MS is 300_000 (T54 raised from 20s → 300s)', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(300_000)
  })

  test('returns default when env unset or non-numeric', () => {
    expect(readRPCTimeoutMs()).toBe(DEFAULT_RPC_TIMEOUT_MS)
    expect(readRPCTimeoutMs(123, {})).toBe(123)
    expect(readRPCTimeoutMs(undefined, { DIANJING_RPC_TIMEOUT_MS: 'abc' })).toBe(
      DEFAULT_RPC_TIMEOUT_MS
    )
  })

  test('returns parsed numeric value when set', () => {
    expect(readRPCTimeoutMs(undefined, { DIANJING_RPC_TIMEOUT_MS: '60000' })).toBe(60_000)
  })

  test('honors caller-provided fallback override', () => {
    expect(readRPCTimeoutMs(7, {})).toBe(7)
  })
})

describe('orchestration/env — readBridgeReadyMarker', () => {
  test('returns null for unset or empty', () => {
    expect(readBridgeReadyMarker({})).toBeNull()
    expect(readBridgeReadyMarker({ DIANJING_BRIDGE_READY_MARKER: '' })).toBeNull()
    expect(readBridgeReadyMarker({ DIANJING_BRIDGE_READY_MARKER: '   ' })).toBeNull()
  })

  test('returns trimmed value when set', () => {
    expect(readBridgeReadyMarker({ DIANJING_BRIDGE_READY_MARKER: 'marker-x' })).toBe('marker-x')
  })
})

describe('orchestration/env — pi backend readers', () => {
  test('readPiBackendPort uses fallback when unset', () => {
    expect(readPiBackendPort(7700, {})).toBe(7700)
  })

  test('readPiBackendPort parses numeric env value', () => {
    expect(readPiBackendPort(7700, { DIANJING_PI_BACKEND_PORT: '8800' })).toBe(8800)
  })

  test('readPiBackendPort falls back on non-numeric (Number(...) form)', () => {
    // 与原位 Number(env ?? default) 行为一致：非数字走默认
    expect(readPiBackendPort(7700, { DIANJING_PI_BACKEND_PORT: 'abc' })).toBe(7700)
  })

  test('readPiAuthToken: undefined → null, trim empty to null', () => {
    expect(readPiAuthToken({})).toBeNull()
    expect(readPiAuthToken({ DIANJING_PI_TOKEN: '' })).toBeNull()
    expect(readPiAuthToken({ DIANJING_PI_TOKEN: '   ' })).toBeNull()
  })

  test('readPiAuthToken: returns trimmed value', () => {
    expect(readPiAuthToken({ DIANJING_PI_TOKEN: '  token  ' })).toBe('token')
  })

  test('readMaxSessions default 200', () => {
    expect(readMaxSessions({})).toBe(200)
    expect(readMaxSessions({ DIANJING_MAX_SESSIONS: '50' })).toBe(50)
  })

  test('readSessionMaxAgeDays default 30', () => {
    expect(readSessionMaxAgeDays({})).toBe(30)
    expect(readSessionMaxAgeDays({ DIANJING_SESSION_MAX_AGE_DAYS: '7' })).toBe(7)
  })

  test('readStudioBuiltinDir: trim and treat empty as null', () => {
    expect(readStudioBuiltinDir({})).toBeNull()
    expect(readStudioBuiltinDir({ DIANJING_STUDIO_BUILTIN_DIR: '/opt/studio' })).toBe('/opt/studio')
    expect(readStudioBuiltinDir({ DIANJING_STUDIO_BUILTIN_DIR: '   ' })).toBeNull()
  })

  test('readRootDir: trim and treat empty as null', () => {
    expect(readRootDir({})).toBeNull()
    expect(readRootDir({ DIANJING_ROOT_DIR: '/var/data' })).toBe('/var/data')
    expect(readRootDir({ DIANJING_ROOT_DIR: '  ' })).toBeNull()
  })
})

describe('orchestration/env — readImageGenTimeoutMs', () => {
  test('DEFAULT_IMAGE_GEN_TIMEOUT_MS is 240_000 (S3 §4 baseline)', () => {
    expect(DEFAULT_IMAGE_GEN_TIMEOUT_MS).toBe(240_000)
  })

  test('returns default when env unset or non-numeric', () => {
    expect(readImageGenTimeoutMs()).toBe(DEFAULT_IMAGE_GEN_TIMEOUT_MS)
    expect(readImageGenTimeoutMs(undefined, { DIANJING_IMAGE_GEN_TIMEOUT_MS: 'bad' })).toBe(
      DEFAULT_IMAGE_GEN_TIMEOUT_MS
    )
  })

  test('returns parsed numeric value when set', () => {
    expect(readImageGenTimeoutMs(undefined, { DIANJING_IMAGE_GEN_TIMEOUT_MS: '300000' })).toBe(
      300_000
    )
  })
})

describe('orchestration/env — dev / vite topology readers', () => {
  test('readDevAutomationAuthToken: null when unset, trimmed value when set', () => {
    expect(readDevAutomationAuthToken({})).toBeNull()
    expect(readDevAutomationAuthToken({ DIANJING_DEV_TOKEN: 'abc' })).toBe('abc')
    expect(readDevAutomationAuthToken({ DIANJING_DEV_TOKEN: '  xyz  ' })).toBe('xyz')
  })

  test('readDevBridgePort: defaults to AUTOMATION_HTTP_PORT (7600) when unset', () => {
    expect(readDevBridgePort({})).toBe(7600)
    expect(readDevBridgePort({ DIANJING_DEV_BRIDGE_PORT: '7700' })).toBe(7700)
  })

  test('readDevBridgePort: throws when out of [1024, 65535] range or non-integer', () => {
    expect(() => readDevBridgePort({ DIANJING_DEV_BRIDGE_PORT: '80' })).toThrow(/between 1024/)
    expect(() => readDevBridgePort({ DIANJING_DEV_BRIDGE_PORT: '70000' })).toThrow(/between 1024/)
    expect(() => readDevBridgePort({ DIANJING_DEV_BRIDGE_PORT: '1.5' })).toThrow(/between 1024/)
  })

  test('readDevOrigin: null when unset, returns origin when valid http(s)', () => {
    expect(readDevOrigin({})).toBeNull()
    expect(readDevOrigin({ DIANJING_DEV_ORIGIN: 'http://localhost:1420' })).toBe(
      'http://localhost:1420'
    )
    expect(readDevOrigin({ DIANJING_DEV_ORIGIN: 'https://x.y' })).toBe('https://x.y')
  })

  test('readDevOrigin: throws on non-http schemes or invalid URLs', () => {
    expect(() => readDevOrigin({ DIANJING_DEV_ORIGIN: 'ftp://x' })).toThrow(/HTTP\(S\) origin/)
    expect(() => readDevOrigin({ DIANJING_DEV_ORIGIN: 'not-a-url' })).toThrow(/HTTP\(S\) origin/)
  })

  test('readPortlessURL: null when unset, value when set', () => {
    expect(readPortlessURL({})).toBeNull()
    expect(readPortlessURL({ PORTLESS_URL: 'https://x' })).toBe('https://x')
    expect(readPortlessURL({ PORTLESS_URL: '' })).toBeNull()
  })

  test('readTauriDevHost: null when unset, value when set', () => {
    expect(readTauriDevHost({})).toBeNull()
    expect(readTauriDevHost({ TAURI_DEV_HOST: 'tauri.local' })).toBe('tauri.local')
    expect(readTauriDevHost({ TAURI_DEV_HOST: '' })).toBeNull()
  })
})

describe('orchestration/env — Electron readers', () => {
  test('readElectronBridgePort: null when unset, parsed number when set', () => {
    expect(readElectronBridgePort({})).toBeNull()
    expect(readElectronBridgePort({ DIANJING_BRIDGE_PORT: '7600' })).toBe(7600)
    expect(readElectronBridgePort({ DIANJING_BRIDGE_PORT: 'abc' })).toBeNull()
  })

  test('readElectronBackendPort: null when unset, parsed number when set', () => {
    expect(readElectronBackendPort({})).toBeNull()
    expect(readElectronBackendPort({ DIANJING_PI_BACKEND_PORT_ELECTRON: '8800' })).toBe(8800)
  })

  test('readElectronLoopbackPort: defaults to 0 (random port) when unset', () => {
    expect(readElectronLoopbackPort({})).toBe(0)
    expect(readElectronLoopbackPort({ DIANJING_LOOPBACK_PORT: '8080' })).toBe(8080)
  })
})

describe('orchestration/env — boolean flag readers (Electron)', () => {
  test('readSmokeMode: strict === "1" comparison (preserved from main.ts)', () => {
    expect(readSmokeMode({})).toBe(false)
    expect(readSmokeMode({ DIANJING_SMOKE: '1' })).toBe(true)
    expect(readSmokeMode({ DIANJING_SMOKE: 'true' })).toBe(false)
    expect(readSmokeMode({ DIANJING_SMOKE: '0' })).toBe(false)
  })

  test('readFullSmokeMode: strict === "1" comparison', () => {
    expect(readFullSmokeMode({})).toBe(false)
    expect(readFullSmokeMode({ DIANJING_FULL_SMOKE: '1' })).toBe(true)
  })

  test('readShowWindow: false only for smoke OR DIANJING_SHOW="0"', () => {
    expect(readShowWindow({})).toBe(true)
    expect(readShowWindow({ DIANJING_SHOW: '1' })).toBe(true)
    expect(readShowWindow({ DIANJING_SHOW: '0' })).toBe(false)
    expect(readShowWindow({ DIANJING_SMOKE: '1' })).toBe(false)
    // DIANJING_SHOW=1 保留兼容：与缺省同
    expect(readShowWindow({ DIANJING_SHOW: '1', DIANJING_SMOKE: '1' })).toBe(false)
  })
})
