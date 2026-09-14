import { describe, expect, test } from 'bun:test'

import {
  APP_ID,
  BRIDGE_DIR_NAME_DESKTOP,
  BRIDGE_DIR_NAME_UNIX,
  DEV_MCP_TMP_PREFIX,
  ENV_PREFIX,
  PRODUCT_NAME_DISPLAY,
  READY_MARKER_PREFIX,
  RUNTIME_GLOBAL_PREFIX,
  STATE_DIR_NAME,
  USER_DATA_DIR_NAME
} from '@/app/orchestration/brand'

// 改名期 ② 翻转后钉字面值——单一真源改了，本钉同步翻转。
// 这些值是消费面（product copy / bundle ID / 文件系统名 / env 前缀 / 运行时全局前缀）
// 的真源，钉死后任何漂移立即可见。

describe('orchestration/brand — product & filesystem constants', () => {
  test('PRODUCT_NAME_DISPLAY is "点睛设计" (verbatim source-of-truth)', () => {
    expect(PRODUCT_NAME_DISPLAY).toBe('点睛设计')
  })

  test('APP_ID is the platform app identifier', () => {
    expect(APP_ID).toBe('com.dianjing.app')
  })

  test('STATE_DIR_NAME is the canonical ".dianjing"', () => {
    expect(STATE_DIR_NAME).toBe('.dianjing')
  })

  test('BRIDGE_DIR_NAME_UNIX is the Unix bridge dir shortname', () => {
    expect(BRIDGE_DIR_NAME_UNIX).toBe('dianjing')
  })

  test('BRIDGE_DIR_NAME_DESKTOP is the macOS/Windows bridge dir display name', () => {
    expect(BRIDGE_DIR_NAME_DESKTOP).toBe('Dianjing')
  })

  test('USER_DATA_DIR_NAME is the Electron userData dir name (app.setName)', () => {
    expect(USER_DATA_DIR_NAME).toBe('Dianjing')
  })
})

describe('orchestration/brand — process / tmpdir constants', () => {
  test('DEV_MCP_TMP_PREFIX is "dianjing-mcp" (matches devMCPRuntimeDir path segment)', () => {
    expect(DEV_MCP_TMP_PREFIX).toBe('dianjing-mcp')
  })

  test('READY_MARKER_PREFIX ends with colon and matches makeReadyMarker shape', () => {
    // 必须以 `:` 收尾——`makeReadyMarker` 拼接 `${prefix}${uuid}` 后是 `dianjing-ready:<uuid>`
    expect(READY_MARKER_PREFIX).toBe('dianjing-ready:')
    // 桥 server 的 ready marker 正则断言 prefix 后直接接 36 字符 UUID
    expect(
      new RegExp(`^${READY_MARKER_PREFIX}[a-f0-9-]{36}$`).test(
        `${READY_MARKER_PREFIX}abcdef01-2345-6789-abcd-ef0123456789`
      )
    ).toBe(true)
  })
})

describe('orchestration/brand — environment & runtime global prefixes', () => {
  test('ENV_PREFIX is "DIANJING_" (all DIANJING_* env vars share this)', () => {
    expect(ENV_PREFIX).toBe('DIANJING_')
  })

  test('RUNTIME_GLOBAL_PREFIX is "__DIANJING_" (browser-side window globals)', () => {
    expect(RUNTIME_GLOBAL_PREFIX).toBe('__DIANJING_')
  })

  test('RUNTIME_GLOBAL_PREFIX template derivation reproduces the legacy literals', () => {
    // runtime-globals.ts 的 7 个 key 由 `${RUNTIME_GLOBAL_PREFIX}<NAME>__` 派生；
    // 钉死后任何漂移都会让 env.test.ts 既有断言红——双保险。
    expect(`${RUNTIME_GLOBAL_PREFIX}RUNTIME_AUTOMATION_TOKEN__`).toBe(
      '__DIANJING_RUNTIME_AUTOMATION_TOKEN__'
    )
    expect(`${RUNTIME_GLOBAL_PREFIX}RUNTIME_BRIDGE_URL__`).toBe('__DIANJING_RUNTIME_BRIDGE_URL__')
    expect(`${RUNTIME_GLOBAL_PREFIX}ELECTRON__`).toBe('__DIANJING_ELECTRON__')
    expect(`${RUNTIME_GLOBAL_PREFIX}LOCAL_AUTOMATION_TOKEN__`).toBe(
      '__DIANJING_LOCAL_AUTOMATION_TOKEN__'
    )
    expect(`${RUNTIME_GLOBAL_PREFIX}LOCAL_AUTOMATION_URL__`).toBe(
      '__DIANJING_LOCAL_AUTOMATION_URL__'
    )
    expect(`${RUNTIME_GLOBAL_PREFIX}LOCAL_AUTOMATION_HTTP_URL__`).toBe(
      '__DIANJING_LOCAL_AUTOMATION_HTTP_URL__'
    )
    expect(`${RUNTIME_GLOBAL_PREFIX}APP_VERSION__`).toBe('__DIANJING_APP_VERSION__')
  })
})
