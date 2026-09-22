// Modified from craft-agents-oss (Apache-2.0) — Copyright 2026 Craft Docs Ltd. — https://craft.do
/**
 * MCP client using official @modelcontextprotocol/sdk
 * Supports both HTTP and stdio transports for remote and local MCP servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * HTTP transport config for remote MCP servers
 */
export interface HttpMCPClientConfig {
  transport: 'http'
  url: string
  headers?: Record<string, string>
}

/**
 * Stdio transport config for local MCP servers (spawns subprocess)
 */
export interface StdioMCPClientConfig {
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

/**
 * Unified config supporting both transport types
 */
export type MCPClientConfig = HttpMCPClientConfig | StdioMCPClientConfig

/**
 * Sensitive environment variables that should NOT be passed to MCP subprocesses.
 * These could contain API keys, tokens, or credentials that MCP servers don't need
 * and shouldn't have access to.
 */
const BLOCKED_ENV_VARS = new Set([
  // Craft Agent auth (set by the app itself)
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',

  // AWS credentials
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',

  // Common API keys/tokens
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN'
])

/**
 * Per-call options for PoolClient.callTool.
 * Forwarded to the MCP SDK's RequestOptions so aborts become protocol-level
 * cancellation notifications instead of orphaned in-flight requests.
 */
export interface PoolCallToolOptions {
  /** Cancels the in-flight request when aborted */
  signal?: AbortSignal
  /** Request timeout in ms (SDK default applies when omitted) */
  timeoutMs?: number
}

/**
 * Interface for clients managed by MCPClientPool.
 * Implemented by CraftMCPClient; tests inject fakes through the same seam.
 */
export interface PoolClient {
  listTools(): Promise<Tool[]>
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: PoolCallToolOptions
  ): Promise<unknown>
  close(): Promise<void>
}

export class CraftMCPClient {
  private client: Client
  private transport: Transport
  private connected = false

  /**
   * @param config MCP connection config (http or stdio).
   * @param transportOverride Optional pre-built Transport; bypasses config-driven transport
   *   construction. Used by in-process tests (InMemoryTransport fixture) — production code
   *   should always pass a real config and let the transport be built here.
   */
  constructor(config: MCPClientConfig, transportOverride?: Transport) {
    this.client = new Client({
      name: 'dianjing',
      version: '0.1.0'
    })

    if (transportOverride) {
      // Test-injection seam: caller supplies a wired-up Transport (e.g. InMemoryTransport
      // linked to a fixture server). Skip the config-driven transport creation below.
      this.transport = transportOverride
    } else if (config.transport === 'stdio') {
      // Stdio transport for local MCP servers - merge with process env,
      // but filter out sensitive credentials to prevent leaking secrets to subprocesses
      const processEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !BLOCKED_ENV_VARS.has(key)) {
          processEnv[key] = value
        }
      }
      this.transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...processEnv, ...config.env }
      })
    } else {
      // HTTP transport for remote MCP servers
      this.transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers
        }
      })
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return

    await this.client.connect(this.transport)

    // Verify connection works by listing tools
    try {
      await this.client.listTools()
    } catch (error) {
      await this.client.close()
      throw new Error(
        `MCP connection failed health check: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    this.connected = true
  }

  async listTools(): Promise<Tool[]> {
    if (!this.connected) {
      await this.connect()
    }

    const result = await this.client.listTools()
    return result.tools
  }

  /**
   * Returns server name/version reported during the MCP handshake.
   * Available after `connect()` resolves; undefined otherwise.
   */
  getServerInfo(): { name: string; version: string } | undefined {
    const info = this.client.getServerVersion()
    if (!info) return undefined
    return { name: info.name, version: info.version }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: PoolCallToolOptions
  ): Promise<unknown> {
    if (!this.connected) {
      await this.connect()
    }

    const requestOptions: { signal?: AbortSignal; timeout?: number } = {}
    if (options?.signal) requestOptions.signal = options.signal
    if (options?.timeoutMs !== undefined) requestOptions.timeout = options.timeoutMs

    const result = await this.client.callTool({ name, arguments: args }, undefined, requestOptions)
    return result
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.close()
      this.connected = false
    }
  }
}
