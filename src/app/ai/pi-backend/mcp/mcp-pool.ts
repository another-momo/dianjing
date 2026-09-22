// Modified from craft-agents-oss (Apache-2.0) — Copyright 2026 Craft Docs Ltd. — https://craft.do
/**
 * Centralized MCP Client Pool
 *
 * Owns all MCP source connections in the pi-backend process.
 * Receives proxy tool definitions for tool registration and routes tool calls
 * through this pool instead of managing MCP connections per backend.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import {
  detectExtensionFromMagic,
  sanitizeFilename,
  saveBinaryResponse
} from './binary-detection.ts'
import {
  CraftMCPClient,
  type MCPClientConfig,
  type PoolCallToolOptions,
  type PoolClient
} from './client.ts'
import { proxyToolName } from './proxy-tool-name.ts'

/**
 * MCP source configuration (subset of backend types inlined — phase 1 only
 * supports http and stdio; sse is dropped per the phase-1 scope cut).
 */
export type SdkMCPServerConfig =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }

/**
 * Proxy tool definition — the format passed to backends for registration.
 * Uses mcp__{slug}__{toolName} naming convention.
 */
export interface ProxyToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Result of an MCP tool call, matching the subprocess protocol format.
 */
export interface MCPToolResult {
  content: string
  isError: boolean
  /** Source slug for error attribution (set on failure) */
  sourceSlug?: string
}

/** Maximum characters retained from a tool result before truncation. */
const LARGE_RESULT_THRESHOLD = 50_000

/**
 * Convert SdkMCPServerConfig to CraftMCPClient config.
 */
function sdkConfigToClientConfig(config: SdkMCPServerConfig): MCPClientConfig | null {
  switch (config.type) {
    case 'http':
      return {
        transport: 'http',
        url: config.url,
        headers: config.headers
      }
    case 'stdio':
      return {
        transport: 'stdio',
        command: config.command,
        args: config.args,
        env: config.env
      }
    default:
      return null
  }
}

/**
 * Check if an MCP source's config has changed in a way that requires reconnection.
 * Compares URL changes and auth header refresh. Ignores stdio sources since they
 * don't use OAuth tokens.
 */
function mcpConfigChanged(oldConfig: SdkMCPServerConfig, newConfig: SdkMCPServerConfig): boolean {
  if (oldConfig.type !== newConfig.type) return true

  if (oldConfig.type === 'http' && newConfig.type === 'http') {
    if (oldConfig.url !== newConfig.url) return true
    const oldAuth = oldConfig.headers?.['Authorization']
    const newAuth = newConfig.headers?.['Authorization']
    if (oldAuth !== newAuth) return true
  }

  return false
}

/** Default per-connection connect timeout in milliseconds. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

export class MCPClientPool {
  /** Active MCP clients keyed by source slug */
  private clients = new Map<string, PoolClient>()

  /** Configs used for active MCP connections (for change detection during sync) */
  protected activeConfigs = new Map<string, SdkMCPServerConfig>()

  /** Cached tool lists keyed by source slug */
  private toolCache = new Map<string, Tool[]>()

  /** Proxy tool name → { slug, originalName } (e.g., "mcp__linear__createIssue" → { slug: "linear", originalName: "createIssue" }) */
  private proxyTools = new Map<string, { slug: string; originalName: string }>()

  /** Optional debug logger */
  private debugFn: ((msg: string) => void) | undefined

  /** Root directory for binary downloads (image/audio blocks saved here). */
  private downloadsRoot?: string

  /** Per-connection connect timeout (ms); overridden via constructor for tests. */
  private connectTimeoutMs: number

  /** Called after sync() connects/disconnects sources, so clients can be notified */
  onToolsChanged?: () => void

  constructor(options?: {
    debug?: (msg: string) => void
    downloadsRoot?: string
    connectTimeoutMs?: number
  }) {
    this.debugFn = options?.debug
    this.downloadsRoot = options?.downloadsRoot
    this.connectTimeoutMs = options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  }

  private debug(msg: string): void {
    this.debugFn?.(`[MCPClientPool] ${msg}`)
  }

  // ============================================================
  // Connection Lifecycle
  // ============================================================

  /**
   * Register a client: connect, cache tools, build proxy mappings.
   * Shared logic for MCP sources (phase 2 will extend with API sources).
   */
  protected async registerClient(slug: string, client: PoolClient): Promise<void> {
    // listTools() triggers connect() internally for CraftMCPClient
    const tools = await client.listTools()
    this.clients.set(slug, client)
    this.toolCache.set(slug, tools)

    for (const tool of tools) {
      const proxyName = proxyToolName(slug, tool.name)
      const existing = this.proxyTools.get(proxyName)
      if (existing && existing.originalName !== tool.name) {
        // Two distinct MCP tool names sanitized to the same proxy name (e.g.
        // `pat.batch` and `pat_batch`). Keep the first; a silent overwrite would
        // route later calls to the wrong original tool (#864). Known limitation:
        // the skipped tool is not callable this session — deterministic
        // disambiguation (suffixing) is a possible follow-up if this ever hits
        // a real server. Warn loudly so a "missing" tool is diagnosable.
        console.warn(
          `[MCPClientPool] Proxy name collision on ${proxyName} (source ${slug}): keeping ${existing.originalName}, skipping ${tool.name} — the skipped tool will not be callable`
        )
        this.debug(
          `Proxy name collision on ${proxyName}: keeping ${existing.originalName}, skipping ${tool.name}`
        )
        continue
      }
      this.proxyTools.set(proxyName, { slug, originalName: tool.name })
    }

    this.debug(`Connected source ${slug}: ${tools.length} tools`)
  }

  /**
   * Connect to an MCP source server (remote HTTP / stdio).
   * If already connected, this is a no-op.
   */
  async connect(slug: string, config: SdkMCPServerConfig): Promise<void> {
    if (this.clients.has(slug)) return
    const clientConfig = sdkConfigToClientConfig(config)
    if (!clientConfig) {
      this.debug(`Unknown MCP server type for ${slug}: ${(config as { type: string }).type}`)
      return
    }
    await this.registerClient(slug, new CraftMCPClient(clientConfig))
    this.activeConfigs.set(slug, config)
  }

  /**
   * Ensure one source is connected with the given config, without touching
   * other pool members (unlike sync(), which reconciles the full set).
   * Reconnects when the config changed (e.g. refreshed OAuth token).
   *
   * @throws Error on connection failure (propagated from connect()).
   */
  async ensureConnected(slug: string, config: SdkMCPServerConfig): Promise<void> {
    if (this.clients.has(slug)) {
      const oldConfig = this.activeConfigs.get(slug)
      if (!oldConfig || !mcpConfigChanged(oldConfig, config)) return
      this.debug(`Config changed for ${slug}, reconnecting with fresh credentials`)
      await this.disconnect(slug)
    }

    await this.connect(slug, config)
  }

  /**
   * Disconnect a source and remove its tools from the pool.
   */
  async disconnect(slug: string): Promise<void> {
    const client = this.clients.get(slug)
    if (client) {
      await client.close().catch(() => undefined)
      this.clients.delete(slug)
    }

    // Remove proxy tool entries for this slug
    for (const [proxyName, info] of this.proxyTools) {
      if (info.slug === slug) this.proxyTools.delete(proxyName)
    }
    this.toolCache.delete(slug)
    this.activeConfigs.delete(slug)
    this.debug(`Disconnected source: ${slug}`)
  }

  /**
   * Disconnect all sources and clear all state.
   */
  async disconnectAll(): Promise<void> {
    const closePromises = Array.from(this.clients.values()).map((c) =>
      c.close().catch(() => undefined)
    )
    await Promise.all(closePromises)
    this.clients.clear()
    this.toolCache.clear()
    this.proxyTools.clear()
    this.activeConfigs.clear()
    this.debug('Disconnected all MCP clients')
  }

  // ============================================================
  // Sync: Reconcile active sources
  // ============================================================

  /**
   * Race a connect promise against a per-connection timeout.
   * On timeout, rejects with a descriptive error; the caller (sync) catches
   * and records the slug in failures[] without propagating.
   */
  private async connectWithTimeout(slug: string, config: SdkMCPServerConfig): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Connect timeout after ${this.connectTimeoutMs}ms`)),
        this.connectTimeoutMs
      )
    })
    try {
      await Promise.race([this.connect(slug, config), timeoutPromise])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Sync the pool to match a desired set of MCP sources.
   * Connects new sources, disconnects removed ones, keeps existing ones.
   * Failures (connection errors and timeouts) are isolated: bad sources land
   * in the returned failures[] without throwing, so assembly can proceed with
   * the surviving sources.
   *
   * Per-connection connect timeout = `connectTimeoutMs` (default 15s). All
   * connection attempts run concurrently — total sync wait is bounded by the
   * slowest single connection rather than the sum across all sources.
   *
   * @param mcpServers - Map of slug → config for desired MCP sources
   * @returns List of slugs that failed to connect
   */
  async sync(mcpServers: Record<string, SdkMCPServerConfig>): Promise<string[]> {
    const desiredSlugs = new Set(Object.keys(mcpServers))
    const currentSlugs = new Set(this.clients.keys())

    // Disconnect sources no longer desired (sequential — minimal cost, isolates errors)
    for (const slug of currentSlugs) {
      if (!desiredSlugs.has(slug)) {
        await this.disconnect(slug)
      }
    }

    // Build work list: new sources to connect + existing sources whose config changed
    type ConnectWork = { slug: string; config: SdkMCPServerConfig; reconnect: boolean }
    const work: ConnectWork[] = []
    for (const [slug, config] of Object.entries(mcpServers)) {
      if (!currentSlugs.has(slug)) {
        work.push({ slug, config, reconnect: false })
        continue
      }
      const oldConfig = this.activeConfigs.get(slug)
      if (oldConfig && mcpConfigChanged(oldConfig, config)) {
        this.debug(`Config changed for ${slug}, reconnecting with fresh credentials`)
        await this.disconnect(slug)
        work.push({ slug, config, reconnect: true })
      }
    }

    // Kick off all connections in parallel, each wrapped with its own timeout
    const attempts = work.map(async ({ slug, config, reconnect }) => {
      try {
        await this.connectWithTimeout(slug, config)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        this.debug(`Failed to ${reconnect ? 'reconnect' : 'connect'} MCP source ${slug}: ${reason}`)
        return slug
      }
      return null
    })

    const results = await Promise.all(attempts)
    const failures = results.filter((s): s is string => s !== null)

    this.onToolsChanged?.()
    return failures
  }

  // ============================================================
  // Tool Discovery
  // ============================================================

  /**
   * Get cached tools for a source. Returns empty array if not connected.
   */
  getTools(slug: string): Tool[] {
    return this.toolCache.get(slug) || []
  }

  /**
   * Get all connected source slugs.
   */
  getConnectedSlugs(): string[] {
    return Array.from(this.clients.keys())
  }

  /**
   * Check if a source is connected.
   */
  isConnected(slug: string): boolean {
    return this.clients.has(slug)
  }

  /**
   * Generate proxy tool definitions for all connected sources (or a subset).
   * These are passed to backends for tool registration.
   */
  getProxyToolDefs(slugs?: string[]): ProxyToolDef[] {
    const targetSlugs = slugs || Array.from(this.toolCache.keys())
    const defs: ProxyToolDef[] = []
    const seen = new Set<string>()

    for (const slug of targetSlugs) {
      const tools = this.toolCache.get(slug) || []
      for (const tool of tools) {
        const name = proxyToolName(slug, tool.name)
        // Skip a name that collided after sanitization — keep the first, matching
        // registerClient so the emitted defs and the dispatch map stay in sync (#864).
        if (seen.has(name)) continue
        seen.add(name)
        // Strip $schema — AJV (Pi agent) fails on unregistered meta-schema URIs.
        // Same pattern as getToolDefsAsJsonSchema() in tool-defs.ts.
        const cleanSchema: Record<string, unknown> = { ...tool.inputSchema }
        delete cleanSchema.$schema
        defs.push({
          name,
          description: tool.description || `Tool from ${slug}`,
          inputSchema:
            Object.keys(cleanSchema).length > 0 ? cleanSchema : { type: 'object', properties: {} }
        })
      }
    }

    return defs
  }

  // ============================================================
  // Tool Execution
  // ============================================================

  /**
   * Truncate an oversized tool result, appending a clear marker so the model
   * knows content was dropped. Phase-1 simplification — no LLM summarization,
   * no on-disk persistence of full text.
   */
  private truncateIfLarge(text: string): string {
    if (text.length <= LARGE_RESULT_THRESHOLD) return text
    const originalLength = text.length
    return `${text.slice(0, LARGE_RESULT_THRESHOLD)}\n[Truncated: showing ${LARGE_RESULT_THRESHOLD} of ${originalLength} characters]`
  }

  /**
   * Execute an MCP tool by its proxy name (mcp__{slug}__{toolName}).
   * Returns a result matching the subprocess protocol format.
   */
  async callTool(
    proxyName: string,
    args: Record<string, unknown>,
    options?: PoolCallToolOptions
  ): Promise<MCPToolResult> {
    const info = this.proxyTools.get(proxyName)
    if (!info) {
      return {
        content: `Unknown MCP proxy tool: ${proxyName}`,
        isError: true
      }
    }

    const { slug, originalName } = info

    const client = this.clients.get(slug)
    if (!client) {
      return {
        content: `MCP client for source "${slug}" is not connected.`,
        isError: true,
        sourceSlug: slug
      }
    }

    try {
      const result = (await client.callTool(originalName, args, options)) as {
        content?: Array<{ type: string; text?: unknown; data?: string; mimeType?: string }>
        isError?: boolean
      }

      const contentBlocks = result.content || []
      const parts: string[] = []

      // Process each content block — handle text, image, audio
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          // Handle non-string text fields (e.g., objects from non-conforming servers)
          if (typeof block.text === 'string') {
            parts.push(block.text)
          } else if (block.text !== undefined && block.text !== null) {
            parts.push(JSON.stringify(block.text, null, 2))
          }
        } else if (
          (block.type === 'image' || block.type === 'audio') &&
          block.data &&
          this.downloadsRoot
        ) {
          // Decode base64 binary content and save to downloads root
          try {
            const buffer = Buffer.from(block.data, 'base64')
            const ext = detectExtensionFromMagic(buffer) || '.bin'
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const safeName = sanitizeFilename(proxyName)
            const filename = `${safeName}_${timestamp}${ext}`
            const saved = saveBinaryResponse(
              this.downloadsRoot,
              filename,
              buffer,
              block.mimeType ?? null
            )
            if (saved.type === 'file_download') {
              parts.push(
                `[${block.type.charAt(0).toUpperCase() + block.type.slice(1)} saved: ${saved.path} (${saved.sizeHuman})]`
              )
            }
          } catch {
            // Base64 decode failed — skip this block
            this.debug('base64 decode failed, skipping block')
          }
        }
      }

      // Combine parts (fallback to JSON.stringify if no content extracted)
      const text = parts.join('\n') || JSON.stringify(result)

      return {
        content: this.truncateIfLarge(text),
        isError: !!result.isError
      }
    } catch (err) {
      return {
        content: `MCP tool "${originalName}" (source: ${slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
        sourceSlug: slug
      }
    }
  }

  /**
   * Check if a tool name is an MCP proxy tool managed by this pool.
   */
  isProxyTool(toolName: string): boolean {
    return this.proxyTools.has(toolName)
  }
}
