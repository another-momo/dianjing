/**
 * McpClientPool tests — registerClient seam (protected) lets a fake PoolClient
 * inject responses without touching the MCP SDK or transport stack.
 *
 * Tests cover:
 *  - sync with two healthy fake clients (proxy name emission)
 *  - failure isolation (one failing source doesn't break sync)
 *  - per-connection connect timeout (resolver-controlled, never hangs the test)
 *  - parallel connect (wall time much less than serial sum)
 *  - proxy-name collision (first-wins + warn) (#864)
 *  - $schema stripping in getProxyToolDefs (pi-side AJV workaround)
 *  - callTool happy path / unknown proxy name / disconnected source
 *  - binary chain: image block → file written under downloadsRoot → placeholder text
 *  - ensureConnected config-change reconnect + no-change no-op
 *
 * Imports client.ts via mcp-pool.ts → client.ts transitively imports
 * @modelcontextprotocol/sdk at module top-level. The SDK is a direct
 * dependency — node_modules must be installed (run `bun install` first).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import type { PoolCallToolOptions, PoolClient } from '@/app/ai/pi-backend/mcp/client'
import { McpClientPool, type SdkMcpServerConfig } from '@/app/ai/pi-backend/mcp/mcp-pool'

// ============================================================
// Fake PoolClient — exercises registerClient seam without real MCP
// ============================================================

interface FakeClientOptions {
  tools?: Tool[]
  /** Delay before listTools resolves (ms). */
  listToolsDelayMs?: number
  /** listTools rejects with this error (failure isolation case). */
  listToolsError?: Error
  /** Holds the resolver for connect-completion — tests can choose when to settle. */
  pendingResolver?: { resolve: () => void; promise: Promise<void> }
  /** Per-callTool behavior. */
  callToolImpl?: (
    name: string,
    args: Record<string, unknown>,
    options?: PoolCallToolOptions
  ) => Promise<unknown>
}

function makeFakeClient(options: FakeClientOptions = {}): PoolClient {
  return {
    listTools: async () => {
      if (options.listToolsDelayMs) {
        await new Promise((r) => setTimeout(r, options.listToolsDelayMs))
      }
      if (options.pendingResolver) await options.pendingResolver.promise
      if (options.listToolsError) throw options.listToolsError
      return options.tools ?? []
    },
    callTool: options.callToolImpl ?? (async () => ({ content: [] })),
    close: async () => {
      if (options.pendingResolver) options.pendingResolver.resolve()
    }
  }
}

// ============================================================
// Test fixture: extend pool to inject fake clients (override protected seam)
// ============================================================

class TestablePool extends McpClientPool {
  /** slug → fake client to install on connect() */
  fakes = new Map<string, PoolClient>()

  protected override async registerClient(slug: string, _client: PoolClient): Promise<void> {
    // Use the injected fake (bypasses CraftMcpClient construction entirely).
    const fake = this.fakes.get(slug)
    if (!fake) throw new Error(`No fake registered for slug ${slug}`)
    await super.registerClient(slug, fake)
  }
}

const STDIO_CONFIG: SdkMcpServerConfig = {
  type: 'stdio',
  command: 'noop',
  args: []
}

const HTTP_CONFIG: SdkMcpServerConfig = {
  type: 'http',
  url: 'http://0.0.0.0:1'
}

// ============================================================
// Common fixtures
// ============================================================

const TOOL_ALPHA: Tool = {
  name: 'alpha',
  description: 'alpha tool',
  inputSchema: { type: 'object', properties: { x: { type: 'string' } } }
}

const TOOL_BETA: Tool = {
  name: 'beta',
  description: 'beta tool',
  inputSchema: { type: 'object', properties: { y: { type: 'number' } } }
}

const TOOL_WITH_SCHEMA: Tool = {
  name: 'meta',
  description: 'has schema key',
  inputSchema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { q: { type: 'string' } }
  }
}

// 1x1 transparent PNG (89 bytes)
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

// ============================================================
// Tests
// ============================================================

describe('McpClientPool.sync', () => {
  let pool: TestablePool

  beforeEach(() => {
    pool = new TestablePool()
  })

  it('mounts two sources and emits mcp__{slug}__{tool} proxy tool defs', async () => {
    pool.fakes.set('alpha', makeFakeClient({ tools: [TOOL_ALPHA] }))
    pool.fakes.set('beta', makeFakeClient({ tools: [TOOL_BETA] }))

    const failures = await pool.sync({
      alpha: STDIO_CONFIG,
      beta: { ...STDIO_CONFIG, command: 'noop-beta' }
    })

    expect(failures).toEqual([])
    expect(pool.getConnectedSlugs().sort()).toEqual(['alpha', 'beta'])
    const names = pool
      .getProxyToolDefs()
      .map((d) => d.name)
      .sort()
    expect(names).toEqual(['mcp__alpha__alpha', 'mcp__beta__beta'])
  })

  it('isolates failures: one bad source does not block the healthy one', async () => {
    pool.fakes.set('bad', makeFakeClient({ listToolsError: new Error('boom') }))
    pool.fakes.set('good', makeFakeClient({ tools: [TOOL_ALPHA] }))

    const failures = await pool.sync({
      bad: STDIO_CONFIG,
      good: STDIO_CONFIG
    })

    expect(failures).toEqual(['bad'])
    expect(pool.getConnectedSlugs()).toEqual(['good'])
    expect(pool.getProxyToolDefs().map((d) => d.name)).toEqual(['mcp__good__alpha'])
  })

  it('honors per-connection connect timeout — slugs that hang land in failures', async () => {
    // Resolver-pattern fake: listTools never resolves until the test releases it.
    // connectTimeoutMs=50 means the pool's timeout fires well before any reasonable
    // test timeout, so the test itself never hangs.
    const resolverHolder: { resolve: () => void } = { resolve: () => {} }
    const pending = new Promise<void>((r) => {
      resolverHolder.resolve = r
    })

    const slowPool = new TestablePool({ connectTimeoutMs: 50 })
    slowPool.fakes.set(
      'slow',
      makeFakeClient({ pendingResolver: { resolve: resolverHolder.resolve, promise: pending } })
    )

    try {
      const start = Date.now()
      const failures = await slowPool.sync({ slow: STDIO_CONFIG })
      const elapsed = Date.now() - start

      expect(failures).toEqual(['slow'])
      expect(slowPool.getConnectedSlugs()).toEqual([])
      // Loose upper bound — proves the timeout fired (50ms + slack) rather than hanging.
      expect(elapsed).toBeLessThan(2000)
    } finally {
      // Release the pending fake so the test can exit cleanly.
      resolverHolder.resolve()
    }
  })

  it('connects in parallel — wall time far less than the serial sum', async () => {
    const parallelPool = new TestablePool()
    parallelPool.fakes.set('a', makeFakeClient({ tools: [TOOL_ALPHA], listToolsDelayMs: 100 }))
    parallelPool.fakes.set('b', makeFakeClient({ tools: [TOOL_BETA], listToolsDelayMs: 100 }))

    const start = Date.now()
    const failures = await parallelPool.sync({ a: STDIO_CONFIG, b: STDIO_CONFIG })
    const elapsed = Date.now() - start

    expect(failures).toEqual([])
    // Serial would be ≥200ms; parallel should finish well under 180ms with slack.
    // Wider upper bound to absorb CI scheduler jitter without flaking.
    expect(elapsed).toBeLessThan(180)
  })
})

describe('McpClientPool proxy-name handling', () => {
  let pool: TestablePool
  let warnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    pool = new TestablePool()
    // Silence the expected collision warning; capture call count instead.
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('keeps the first of two tools whose names sanitize to the same proxy name (#864)', async () => {
    // `pat.batch` and `pat_batch` both sanitize to `mcp__pat__pat_batch`.
    pool.fakes.set(
      'pat',
      makeFakeClient({
        tools: [
          { name: 'pat.batch', description: 'dotted', inputSchema: { type: 'object' } },
          { name: 'pat_batch', description: 'underscored', inputSchema: { type: 'object' } }
        ]
      })
    )

    const failures = await pool.sync({ pat: STDIO_CONFIG })

    expect(failures).toEqual([])
    const defs = pool.getProxyToolDefs()
    expect(defs).toHaveLength(1)
    expect(defs[0]?.name).toBe('mcp__pat__pat_batch')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('Proxy name collision')

    // Dispatch via the kept original name works; the skipped one is unrouteable.
    const kept = await pool.callTool('mcp__pat__pat_batch', {})
    expect(kept.isError).toBe(false)
  })

  it('strips $schema from inputSchema but keeps the tool in the list', async () => {
    pool.fakes.set('meta', makeFakeClient({ tools: [TOOL_WITH_SCHEMA] }))

    await pool.sync({ meta: STDIO_CONFIG })

    const defs = pool.getProxyToolDefs()
    expect(defs).toHaveLength(1)
    const def = defs[0]
    expect(def?.name).toBe('mcp__meta__meta')
    expect(def?.inputSchema).not.toHaveProperty('$schema')
    expect(def?.inputSchema).toMatchObject({
      type: 'object',
      properties: { q: { type: 'string' } }
    })
  })
})

describe('McpClientPool.callTool', () => {
  let pool: TestablePool

  beforeEach(() => {
    pool = new TestablePool()
  })

  it('roundtrips a text block from a connected source', async () => {
    pool.fakes.set(
      'echo',
      makeFakeClient({
        tools: [TOOL_ALPHA],
        callToolImpl: async () => ({ content: [{ type: 'text', text: 'hello world' }] })
      })
    )

    await pool.sync({ echo: STDIO_CONFIG })

    const result = await pool.callTool('mcp__echo__alpha', { x: 'hi' })
    expect(result.isError).toBe(false)
    expect(result.content).toBe('hello world')
  })

  it('returns isError for an unknown proxy tool name', async () => {
    const result = await pool.callTool('mcp__nope__nada', {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Unknown MCP proxy tool')
  })

  it('unregisters proxy tools on disconnect — post-disconnect calls fail as unknown', async () => {
    // Pool semantics: disconnect() also removes the slug's proxy mappings, so a
    // post-disconnect call hits the unknown-proxy path, not the stale-client guard.
    pool.fakes.set(
      'gone',
      makeFakeClient({
        tools: [TOOL_ALPHA],
        callToolImpl: async () => ({ content: [{ type: 'text', text: 'should not reach' }] })
      })
    )
    await pool.sync({ gone: STDIO_CONFIG })
    await pool.disconnect('gone')

    const result = await pool.callTool('mcp__gone__alpha', {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Unknown MCP proxy tool')
  })

  it('saves binary image blocks to downloadsRoot and emits a placeholder path', async () => {
    const downloadRoot = mkdtempSync(join(tmpdir(), 'mcp-pool-test-'))
    const binaryPool = new TestablePool({ downloadsRoot: downloadRoot })
    binaryPool.fakes.set(
      'img',
      makeFakeClient({
        tools: [TOOL_ALPHA],
        callToolImpl: async () => ({
          content: [{ type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }]
        })
      })
    )

    try {
      await binaryPool.sync({ img: STDIO_CONFIG })

      const result = await binaryPool.callTool('mcp__img__alpha', {})
      expect(result.isError).toBe(false)

      // Placeholder text includes absolute path of the saved file.
      expect(result.content).toMatch(/^\[Image saved: .+\.(png|bin) \(\d+(\.\d+)? ?(B|KB|MB)\)\]$/)
      const match = result.content.match(/\[Image saved: (.+?) \(/)
      expect(match).not.toBeNull()
      const savedPath = match![1]!
      expect(savedPath.startsWith(downloadRoot)).toBe(true)

      // File actually exists with non-zero size (PNG header bytes).
      const bytes = readFileSync(savedPath)
      expect(statSync(savedPath).size).toBeGreaterThan(0)
      expect(bytes[0]).toBe(0x89)
      expect(bytes[1]).toBe(0x50)
    } finally {
      rmSync(downloadRoot, { recursive: true, force: true })
    }
  })
})

describe('McpClientPool.ensureConnected', () => {
  it('reconnects when the config changes (Authorization header refresh)', async () => {
    const initialConfig: SdkMcpServerConfig = {
      type: 'http',
      url: 'http://0.0.0.0:1',
      headers: { Authorization: 'Bearer old' }
    }
    const refreshedConfig: SdkMcpServerConfig = {
      type: 'http',
      url: 'http://0.0.0.0:1',
      headers: { Authorization: 'Bearer new' }
    }

    let callToolCalls = 0
    const pool = new TestablePool()
    pool.fakes.set(
      'srv',
      makeFakeClient({
        tools: [TOOL_ALPHA],
        callToolImpl: async () => {
          callToolCalls++
          return { content: [{ type: 'text', text: 'ok' }] }
        }
      })
    )

    await pool.ensureConnected('srv', initialConfig)
    await pool.ensureConnected('srv', refreshedConfig)

    // ensureConnected should have triggered disconnect (via mcpConfigChanged) + reconnect.
    // Active config should reflect the refreshed token.
    const active = pool.activeConfigs.get('srv')
    expect(active).toMatchObject({ type: 'http', headers: { Authorization: 'Bearer new' } })
    expect(callToolCalls).toBe(0) // ensureConnected never invokes callTool
  })

  it('is a no-op when the config has not changed', async () => {
    let connectCalls = 0
    const countingPool = new (class extends TestablePool {
      override async connect(slug: string, config: SdkMcpServerConfig): Promise<void> {
        connectCalls++
        return super.connect(slug, config)
      }
    })()
    countingPool.fakes.set('stable', makeFakeClient({ tools: [TOOL_ALPHA] }))

    await countingPool.ensureConnected('stable', HTTP_CONFIG)
    await countingPool.ensureConnected('stable', HTTP_CONFIG)
    await countingPool.ensureConnected('stable', HTTP_CONFIG)

    expect(connectCalls).toBe(1)
  })
})
