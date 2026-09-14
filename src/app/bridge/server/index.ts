#!/usr/bin/env node
import { ENV_PREFIX, READY_MARKER_PREFIX } from '@/app/orchestration/brand'
import {
  readBridgeTcpPort,
  readMCPAppAttachTimeoutMs,
  readMCPAuthToken,
  readMCPCORSOrigin,
  readMCPReadyMarker,
  readMCPSocketPath
} from '@/app/orchestration/env'

import { startServer } from './server'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    `Dianjing Studio automation bridge\n\n` +
      `Start the Dianjing Studio automation bridge (editor WebSocket + /rpc HTTP relay).\n\n` +
      `On macOS/Linux, the bridge listens on a Unix domain socket by default\n` +
      `with optional TCP for browser clients. On Windows, only TCP is available.\n\n` +
      `Options:\n` +
      `  --help, -h    Show this help message\n\n` +
      `Environment variables:\n` +
      `  PORT                         TCP port (default: 7600, set to 0 to disable TCP)\n` +
      `  ${ENV_PREFIX}MCP_SOCKET        Override Unix socket path (recorded in the discovery file)\n` +
      `  ${ENV_PREFIX}MCP_DISCOVERY_PATH Override discovery file (mcp.json) location; defaults to the\n` +
      `                               platform path. Parent dir created 0o700. Mainly for test isolation.\n` +
      `  ${ENV_PREFIX}MCP_AUTH_TOKEN    Bearer token for /rpc auth\n` +
      `  ${ENV_PREFIX}MCP_CORS_ORIGIN   Allowed CORS origin\n` +
      `  ${ENV_PREFIX}MCP_APP_TIMEOUT_MS  If set, close the bridge and remove its discovery\n` +
      `                               file after no app is attached for this many ms. The\n` +
      `                               grace period starts at startup and after disconnects.\n` +
      `                               Unset/0 disables it (default) — do not set this for\n` +
      `                               manual use, since nothing may ever register.\n`
  )
  process.exit(0)
}

let port: number
try {
  port = readBridgeTcpPort()
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
const withTcp = port > 0

let appAttachTimeoutMs: number | undefined
try {
  appAttachTimeoutMs = readMCPAppAttachTimeoutMs()
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

let authToken: string | null | undefined
try {
  authToken = readMCPAuthToken()
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

const handle = await startServer({
  httpPort: withTcp ? port : 0,
  withTcp,
  socketPath: readMCPSocketPath(),
  authToken,
  corsOrigin: readMCPCORSOrigin(),
  appAttachTimeoutMs
})

const readyMarker = readMCPReadyMarker()
if (readyMarker && new RegExp(`^${READY_MARKER_PREFIX}[a-f0-9-]{36}$`).test(readyMarker)) {
  process.stderr.write(`${readyMarker}
`)
}

process.stderr.write(`Dianjing Studio automation bridge
`)
if (handle.socketPath) process.stderr.write(`  Socket: ${handle.socketPath}\n`)
if (handle.httpPort) process.stderr.write(`  HTTP:   http://127.0.0.1:${handle.httpPort}\n`)

// Graceful shutdown on signals
const shutdown = async () => {
  process.stderr.write('\nShutting down automation bridge...\n')
  await handle.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown().catch(() => process.exit(1)))
process.on('SIGTERM', () => void shutdown().catch(() => process.exit(1)))
