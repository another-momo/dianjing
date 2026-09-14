/**
 * 移植自上游 5951f45d6 的 tests/engine/mcp/server/security.test.ts CORS 段
 * （Batch 2c 裁撤时已删原文件；本文件按移植裁定精简——enableEval/mcpRoot
 * 已随外壳裁撤移除，只保留 preflight 对 corsOrigin 的回归断言）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '@/app/bridge/server/server'

const TEST_AUTH_TOKEN = 'test-cors-token'
const SOCKET_DIR = join(tmpdir(), 'open-pencil-bridge-cors')
let testCounter = 0

function testSocketPath(): string | null {
  if (process.platform === 'win32') return null
  return join(SOCKET_DIR, `bridge-test-${process.pid}-${++testCounter}.sock`)
}

describe('Automation bridge CORS', () => {
  let handle: Awaited<ReturnType<typeof startServer>> | null = null

  beforeEach(async () => {
    await mkdir(SOCKET_DIR, { recursive: true, mode: 0o700 })
  })

  afterEach(async () => {
    if (handle) await handle.close()
    handle = null
  })

  test('accepts authenticated health preflight from the configured worktree origin', async () => {
    const origin = 'https://feature.open-pencil.localhost'
    handle = await startServer({
      httpPort: 0,
      withTcp: true,
      socketPath: testSocketPath(),
      authToken: TEST_AUTH_TOKEN,
      corsOrigin: origin
    })
    const httpPort = handle.httpPort
    if (!httpPort) throw new Error('withTcp: true did not produce an HTTP port')

    const response = await fetch(`http://127.0.0.1:${httpPort}/health`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization'
      }
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization')
  })
})
