/**
 * In-process fixture tests for CraftMcpClient.
 *
 * Hard constraint: zero ports, zero subprocesses, zero public network — only the
 * real MCP protocol stack over InMemoryTransport. The SDK methods themselves
 * are never stubbed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { CraftMcpClient, type HttpMcpClientConfig } from '@/app/ai/pi-backend/mcp/client'

const FIXTURE_SERVER_INFO = { name: 'fixture-server', version: '9.9.9-fixture' }

function makeServer() {
  const server = new McpServer(FIXTURE_SERVER_INFO)
  server.tool(
    'echo',
    'Echoes the input message back as text',
    { msg: z.string() },
    async ({ msg }) => ({
      content: [{ type: 'text', text: msg }]
    })
  )
  return server
}

function dummyHttpConfig(): HttpMcpClientConfig {
  // Unreachable in production (tests never call .connect() against it without transportOverride).
  // A unique non-routable host keeps the test self-contained if anything accidentally tries to dial.
  return { transport: 'http', url: 'http://0.0.0.0:1' }
}

describe('CraftMcpClient (in-process fixture)', () => {
  let server: McpServer
  let clientTransport: InMemoryTransport
  let serverTransport: InMemoryTransport

  beforeEach(async () => {
    server = makeServer()
    // One linked pair per test — both halves are tied to each other; server gets one,
    // client gets the other.
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    clientTransport = clientT
    serverTransport = serverT
    await server.connect(serverTransport)
  })

  afterEach(async () => {
    await server.close()
  })

  it('connects, lists tools, roundtrips callTool, exposes server info, and closes cleanly', async () => {
    const client = new CraftMcpClient(dummyHttpConfig(), clientTransport)

    try {
      await client.connect()

      const tools = await client.listTools()
      const echo = tools.find((t) => t.name === 'echo')
      expect(echo).toBeDefined()
      expect(echo?.description).toBe('Echoes the input message back as text')

      const result = await client.callTool('echo', { msg: 'hi' })
      const typed = result as { content: Array<{ type: string; text?: string }> }
      expect(typed.content).toHaveLength(1)
      expect(typed.content[0]?.type).toBe('text')
      expect(typed.content[0]?.text).toBe('hi')

      const info = client.getServerInfo()
      expect(info).toBeDefined()
      expect(info?.name).toBe(FIXTURE_SERVER_INFO.name)
      expect(info?.version).toBe(FIXTURE_SERVER_INFO.version)
    } finally {
      await client.close()
    }
  })

  it('connect() health-check fails when the server side disconnects before client connect', async () => {
    // A separate linked pair where the server side connects then immediately closes —
    // the client's connect attempt should fail (either at handshake or at the post-connect
    // listTools health check) rather than hang on the SDK's default 60s timeout.
    const [orphanClient, orphanServer] = InMemoryTransport.createLinkedPair()
    const orphanServerHandle = makeServer()
    await orphanServerHandle.connect(orphanServer)
    await orphanServerHandle.close()

    const client = new CraftMcpClient(dummyHttpConfig(), orphanClient)

    try {
      // Loose semantic match: either the wrapped health-check error or a raw SDK error
      // (e.g. "Not connected") both indicate the failed-connect path we exercise here.
      await expect(client.connect()).rejects.toThrow(/health check|Not connected|closed/)
    } finally {
      await client.close()
    }
  })
})
