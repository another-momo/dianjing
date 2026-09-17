import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { Plugin } from 'vite'

import { devBridgeRuntimeDir } from '../orchestration/discovery'
import {
  attachStderrPassthrough,
  makeReadyMarker,
  stopChildGracefully
} from '../orchestration/lifecycle'
import { waitForChildReady } from './child-ready'
import { platformHasUnixSockets } from './server/paths'

interface AutomationEnvironmentOptions {
  authToken: string | null
  baseEnv: NodeJS.ProcessEnv
  corsOrigin: string
  discoveryPath: string | null
  httpPort: number
  socketPath: string | null
}

export function createAutomationEnvironment(
  options: AutomationEnvironmentOptions
): NodeJS.ProcessEnv {
  const { authToken, baseEnv, corsOrigin, discoveryPath, httpPort, socketPath } = options
  const childEnv = { ...baseEnv }
  delete childEnv.DIANJING_BRIDGE_SOCKET
  delete childEnv.DIANJING_BRIDGE_AUTH_TOKEN
  const childProcessEnv: NodeJS.ProcessEnv = {
    ...childEnv,
    PORT: String(httpPort),
    DIANJING_BRIDGE_AUTH_TOKEN: authToken ?? '',
    DIANJING_BRIDGE_CORS_ORIGIN: corsOrigin
  }
  if (socketPath) childProcessEnv.DIANJING_BRIDGE_SOCKET = socketPath
  if (discoveryPath) childProcessEnv.DIANJING_BRIDGE_DISCOVERY_PATH = discoveryPath
  return childProcessEnv
}

const CHILD_EXIT_TIMEOUT_MS = 2_000
const CHILD_HEALTH_ATTEMPTS = 40
const CHILD_HEALTH_DELAY_MS = 50

// 移植自上游 5951f45d6（fix(automation): wait for Portless MCP readiness）：
// configureServer 不能在 spawn 系统调用返回时就 resolve——子进程尚未监听时
// 浏览器的 /health 请求会打在未绑定 socket 上（Portless 下代理 URL 差异
// 更明显）。startChild 末尾轮询 /health 直至就绪再返回。
export async function waitForAutomationHealth(
  browserURL: string,
  fetcher: typeof fetch = fetch,
  options: { assertRunning?: () => void } = {}
): Promise<void> {
  const healthURL = `${browserURL.replace(/^ws/, 'http')}/health`
  for (let attempt = 0; attempt < CHILD_HEALTH_ATTEMPTS; attempt++) {
    options.assertRunning?.()
    let healthy = false
    try {
      const response = await fetcher(healthURL, { signal: AbortSignal.timeout(2000) })
      healthy = response.ok
    } catch (error) {
      if (attempt === CHILD_HEALTH_ATTEMPTS - 1) {
        console.warn(`[automation] Health check failed at ${healthURL}`, error)
      }
    }
    options.assertRunning?.()
    if (healthy) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, CHILD_HEALTH_DELAY_MS)
    })
  }
  throw new Error(`Automation bridge did not become healthy at ${healthURL}`)
}

interface AutomationPluginOptions {
  browserURL: string
  corsOrigin: string
  httpPort: number
  portlessServiceName: string | null
  runtimeId: string
}

// TODO: production — bundle the bridge as Tauri sidecar or spawn via shell plugin
export function automationPlugin(
  authToken: string | null,
  options: AutomationPluginOptions
): Plugin {
  let child: ReturnType<typeof spawn> | null = null
  let lifecycle = Promise.resolve()

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const next = lifecycle.then(operation, operation)
    lifecycle = next.catch(() => undefined)
    return next
  }

  async function stopChild(): Promise<void> {
    const running = child
    if (!running) return
    child = null
    await stopChildGracefully(running, { timeoutMs: CHILD_EXIT_TIMEOUT_MS })
  }

  async function startChild(): Promise<void> {
    const runtimeDir = devBridgeRuntimeDir(options.runtimeId)
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
    const socketPath = platformHasUnixSockets() ? join(runtimeDir, 'mcp.sock') : null
    const discoveryPath = join(runtimeDir, 'bridge.json')
    const command = ['bun', 'run', 'src/app/bridge/server/index.ts']
    const spawnCommand = options.portlessServiceName ? 'portless' : command[0]
    const spawnArgs = options.portlessServiceName
      ? ['run', '--name', options.portlessServiceName, ...command]
      : command.slice(1)
    const readyMarker = makeReadyMarker()
    const spawned = spawn(spawnCommand, spawnArgs, {
      stdio: ['ignore', 'inherit', 'pipe'],
      env: {
        ...createAutomationEnvironment({
          authToken,
          baseEnv: process.env,
          corsOrigin: options.corsOrigin,
          discoveryPath,
          httpPort: options.httpPort,
          socketPath
        }),
        DIANJING_BRIDGE_READY_MARKER: readyMarker
      }
    })
    const ready = waitForChildReady(spawned, readyMarker)
    child = spawned

    spawned.on('error', (err) => {
      console.error(`[automation] Failed to spawn bridge: ${err.message}`)
      if (child === spawned) child = null
    })

    attachStderrPassthrough(spawned, {
      onEaddrinuse: () => {
        console.error(
          `\x1b[31m[automation] Bridge bind failed (${options.browserURL}${socketPath ? ` or socket ${socketPath}` : ''}). Is another Dianjing Studio instance running?\x1b[0m`
        )
        spawned.kill()
        if (child === spawned) child = null
      }
    })

    spawned.on('exit', (code) => {
      if (code && code !== 0) console.error(`[automation] Bridge exited with code ${code}`)
      if (child === spawned) child = null
    })

    try {
      await ready
    } catch (error) {
      spawned.kill()
      throw error
    }
    await waitForAutomationHealth(options.browserURL, fetch, {
      assertRunning() {
        if (child !== spawned || spawned.exitCode !== null || spawned.signalCode !== null) {
          throw new Error('MCP child exited before becoming ready')
        }
      }
    })
  }

  return {
    name: 'open-pencil-automation',
    async configureServer() {
      await enqueue(startChild)
    },
    async buildEnd() {
      await enqueue(stopChild)
    }
  }
}
