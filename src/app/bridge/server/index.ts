#!/usr/bin/env node
import { startServer } from './server'

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(
    `openpencil automation bridge\n\n` +
      `Start the OpenPencil automation bridge (editor WebSocket + /rpc HTTP relay).\n\n` +
      `On macOS/Linux, the bridge listens on a Unix domain socket by default\n` +
      `with optional TCP for browser clients. On Windows, only TCP is available.\n\n` +
      `Options:\n` +
      `  --help, -h    Show this help message\n\n` +
      `Environment variables:\n` +
      `  PORT                         TCP port (default: 7600, set to 0 to disable TCP)\n` +
      `  OPENPENCIL_MCP_SOCKET        Override Unix socket path (recorded in the discovery file)\n` +
      `  OPENPENCIL_MCP_DISCOVERY_PATH Override discovery file (mcp.json) location; defaults to the\n` +
      `                               platform path. Parent dir created 0o700. Mainly for test isolation.\n` +
      `  OPENPENCIL_MCP_AUTH_TOKEN    Bearer token for /rpc auth\n` +
      `  OPENPENCIL_MCP_CORS_ORIGIN   Allowed CORS origin\n` +
      `  OPENPENCIL_MCP_APP_TIMEOUT_MS  If set, close the bridge and remove its discovery\n` +
      `                               file after no app is attached for this many ms. The\n` +
      `                               grace period starts at startup and after disconnects.\n` +
      `                               Unset/0 disables it (default) — do not set this for\n` +
      `                               manual use, since nothing may ever register.\n`
  )
  process.exit(0)
}

const rawPortText = (process.env.PORT ?? '7600').trim()
// Reject non-digit strings (including hex like "0x50" and partially-numeric like
// "7600abc") — Number.parseInt would silently parse these, masking misconfig.
if (!/^\d+$/.test(rawPortText)) {
  process.stderr.write(`Error: PORT must be an integer in 0–65535, got "${process.env.PORT}"\n`)
  process.exit(1)
}
const rawPort = Number.parseInt(rawPortText, 10)
// Validate PORT: must be an integer in 0–65535. 0 means "disable TCP".
if (rawPort < 0 || rawPort > 65535) {
  process.stderr.write(`Error: PORT must be an integer in 0–65535, got "${process.env.PORT}"\n`)
  process.exit(1)
}
const port = rawPort
const withTcp = port > 0

const MAX_APP_TIMEOUT_MS = 2_147_483_647
const rawAppTimeoutText = process.env.OPENPENCIL_MCP_APP_TIMEOUT_MS?.trim()
let appAttachTimeoutMs: number | undefined
if (rawAppTimeoutText) {
  if (!/^\d+$/.test(rawAppTimeoutText)) {
    process.stderr.write(
      `Error: OPENPENCIL_MCP_APP_TIMEOUT_MS must be a non-negative integer, got "${rawAppTimeoutText}"\n`
    )
    process.exit(1)
  }
  appAttachTimeoutMs = Number.parseInt(rawAppTimeoutText, 10)
  if (!Number.isSafeInteger(appAttachTimeoutMs) || appAttachTimeoutMs > MAX_APP_TIMEOUT_MS) {
    process.stderr.write(
      `Error: OPENPENCIL_MCP_APP_TIMEOUT_MS must be an integer in 0–${MAX_APP_TIMEOUT_MS}, got "${rawAppTimeoutText}"\n`
    )
    process.exit(1)
  }
}

const handle = await startServer({
  httpPort: withTcp ? port : 0,
  withTcp,
  socketPath: process.env.OPENPENCIL_MCP_SOCKET?.trim() || null,
  // Auth token: undefined → auto-generate, empty string → disable auth,
  // non-empty → use trimmed value. Whitespace-only is rejected to prevent a
  // silent fallback to an auto-generated token when the operator intended to
  // set an explicit one.
  authToken: (() => {
    const raw = process.env.OPENPENCIL_MCP_AUTH_TOKEN
    if (raw === undefined) return undefined
    if (raw === '') return null
    const trimmed = raw.trim()
    if (!trimmed) {
      process.stderr.write(
        'Error: OPENPENCIL_MCP_AUTH_TOKEN is whitespace-only. Set a real token, or use an empty string to disable auth.\n'
      )
      process.exit(1)
    }
    return trimmed
  })(),
  corsOrigin: process.env.OPENPENCIL_MCP_CORS_ORIGIN?.trim() || null,
  appAttachTimeoutMs
})

const readyMarker = process.env.OPENPENCIL_MCP_READY_MARKER
if (readyMarker && /^open-pencil-ready:[a-f0-9-]{36}$/.test(readyMarker)) {
  process.stderr.write(`${readyMarker}
`)
}

process.stderr.write(`OpenPencil automation bridge
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
