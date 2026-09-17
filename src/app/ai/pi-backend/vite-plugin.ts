/**
 * T20 vite 插件：pi 后端进程管理器（owner 拍板 2026-08-23：后端是独立进程）。
 *
 * 形态照抄 automation 桥（src/app/bridge/vite-plugin.ts，2026-08-23
 * 实证）：configureServer spawn `bun run src/app/ai/pi-backend/main.ts` 子进程，
 * buildEnd 回收（kill + 超时 SIGKILL 兜底）；/api/pi-chat 经 config() hook 注入
 * server.proxy 转发到后端端口——前端 transport 保持同源调用零改动。
 * T27：子进程意外崩溃（非 buildEnd 主动回收）自动复活——最多 3 次、间隔退避，
 * 一次 /health 就绪即清零计数；超过次数打印明确指引并停手。
 *
 * OPENROUTER_API_KEY 经 env 继承进入后端进程；缺 key 时后端自助读
 * .dianjing/key-env 注入（main.ts，T25 D3），仍缺则 service 在首个 prompt
 * 处如实报错（不阻断 vite 启动）。
 *
 * T28（决策单 #1）：插件实例生成 32-hex 随机 token，经 env DIANJING_PI_TOKEN
 * 传给后端子进程（崩溃复活沿用同一枚）；config() hook 的 server.proxy 给
 * /api/pi 转发统一注入 Authorization: Bearer 头——后端除 /health 外全端点鉴权，
 * 前端同源调用零改动，token 不落盘不打印。
 *
 * T38：dev 拓扑下 7600 桥的 discovery 文件已被上游 0f981ff2（经 T34 合入）隔离到
 * tmpdir 路径（桥插件 startChild 的 DIANJING_BRIDGE_DISCOVERY_PATH），不再是平台
 * 默认路径；本插件经 bridgeRuntimeId 选项同源推导该路径并注入后端子进程 env，
 * 后端 tools.ts 的 readDiscoveryFile()（getDiscoveryPath 吃同一 env）才能找到
 * 活桥。算法漂移由 tests/engine/rebuild/pi-backend/dev-discovery.test.ts 钉扎。
 */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import type { Plugin } from 'vite'

// vite.config.ts 加载链文件——Storybook 配置 loader 不注册 @/ 别名，@/ 引用会断链
// （orchestration-consolidation 2026-09-14 CI 修红）。本文件改用相对 import，
// 配合下方逐行 oxlint-disable 绕过 no-deep-parent-relative-imports 规则。
// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { devBridgeDiscoveryPath } from '../../orchestration/discovery'
// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { readPiBackendPort } from '../../orchestration/env'
// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { waitForHealthPolling } from '../../orchestration/health'
// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { attachStderrPassthrough, stopChildGracefully } from '../../orchestration/lifecycle'
// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { MAX_AUTO_RESTARTS, nextRestartDelay } from '../../orchestration/restart'
// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { generateToken } from '../../orchestration/token'
import { PI_BACKEND_DEFAULT_PORT } from './config'
import { BUILTIN_STUDIO_SUBPATH } from './paths'

const CHILD_EXIT_TIMEOUT_MS = 2_000
const HEALTH_TIMEOUT_MS = 15_000
const HEALTH_INTERVAL_MS = 150

export interface PiBackendPluginOptions {
  /**
   * T38：dev 桥（automation vite 插件）的 runtimeId（vite.config 里
   * devAutomationRoute() 的返回值，单源）。给定时把同源推导的桥 discovery
   * 路径注入后端子进程 env DIANJING_BRIDGE_DISCOVERY_PATH。
   */
  bridgeRuntimeId?: string
}

/**
 * T38：与桥 vite 插件 startChild 同源的 discovery 路径推导——
 * tmpdir()/dianjing-bridge/sha256(runtimeId)[:16]/bridge.json。
 * 算法实现已迁入 @/app/orchestration/discovery，本处 re-export 保持既有
 * 测试（tests/engine/rebuild/pi-backend/dev-discovery.test.ts）的 import 路径与硬
 * 编码 digest 钉扎不变。一致性由该测试钉扎。
 */
export { devBridgeDiscoveryPath }

export function piBackendPlugin(options: PiBackendPluginOptions = {}): Plugin {
  const port = readPiBackendPort(PI_BACKEND_DEFAULT_PORT)
  // T28：每 vite 进程一枚鉴权 token（子进程 env 注入 + proxy 补头，两侧共享）
  const authToken = generateToken()
  // T38：dev 桥 discovery 路径（同源推导；无 runtimeId 时不注入，后端落平台默认路径）
  const bridgeDiscoveryPath = options.bridgeRuntimeId
    ? devBridgeDiscoveryPath(options.bridgeRuntimeId)
    : undefined
  let child: ReturnType<typeof spawn> | null = null
  let restartCount = 0
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  async function stopChild(): Promise<void> {
    const running = child
    child = null
    await stopChildGracefully(running, { timeoutMs: CHILD_EXIT_TIMEOUT_MS })
  }

  async function waitForHealth(spawned: ReturnType<typeof spawn>): Promise<void> {
    await waitForHealthPolling({
      intervalMs: HEALTH_INTERVAL_MS,
      timeoutMs: HEALTH_TIMEOUT_MS,
      isAlive: () => spawned.exitCode === null,
      probe: async () => {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        return res.ok
      },
      onReady: () => {
        // T27：一次健康就绪即清零崩溃计数——自动复活只针对「连续」崩溃
        restartCount = 0
        console.error(`[pi-backend] ready (http://127.0.0.1:${port})`)
      },
      onTimeout: () => {
        console.warn(`[pi-backend] ${HEALTH_TIMEOUT_MS}ms 内未等到 /health 就绪（端口 ${port}）`)
      }
    })
  }

  // T27：崩溃后的有限次自动复活（退避间隔见 RESTART_BACKOFF_MS）
  function scheduleRestart(): void {
    const delay = nextRestartDelay(restartCount)
    if (delay === null) {
      console.error(
        `[pi-backend] 后端进程已连续崩溃 ${MAX_AUTO_RESTARTS} 次，停止自动复活——` +
          `修复后重启 vite dev server，或 bun run dev:backend 单起后端看启动报错`
      )
      return
    }
    restartCount++
    console.error(
      `[pi-backend] ${delay}ms 后自动重启后端进程（第 ${restartCount}/${MAX_AUTO_RESTARTS} 次）`
    )
    restartTimer = setTimeout(() => {
      restartTimer = null
      spawnBackend()
    }, delay)
  }

  function spawnBackend(): void {
    const spawned = spawn('bun', ['run', 'src/app/ai/pi-backend/main.ts'], {
      stdio: ['ignore', 'inherit', 'pipe'],
      env: {
        ...process.env,
        DIANJING_PI_BACKEND_PORT: String(port),
        // T28：鉴权 token 经 env 注入（后端见 token 即不走 standalone 落盘路径）
        DIANJING_PI_TOKEN: authToken,
        // studio 内置资产目录：dev 形态指向仓内源目录（与 Electron main 注入
        // 同名 env 对齐）。缺省时 paths.ts 兜底 join(rootDir, 内置子路径） 落进
        // 状态根——该路径永不存在，ensureUserStudioSeed 早返，seed 从不生效。
        // spawn 的相对入口路径本已硬假设 cwd=仓根，此处同源。
        DIANJING_STUDIO_BUILTIN_DIR: resolve(process.cwd(), BUILTIN_STUDIO_SUBPATH),
        // T38：dev 桥 discovery 隔离路径注入（后端 readDiscoveryFile 经
        // getDiscoveryPath 吃该 env；不注入则盲读平台默认路径找不到活桥）
        ...(bridgeDiscoveryPath ? { DIANJING_BRIDGE_DISCOVERY_PATH: bridgeDiscoveryPath } : {})
      }
    })
    child = spawned

    spawned.on('error', (err) => {
      console.error(`[pi-backend] 无法 spawn 后端进程：${err.message}`)
      // T27：spawn 失败（如 bun 不在 PATH）视同崩溃走有限复活；exit 不一定再触发
      if (child === spawned) {
        child = null
        scheduleRestart()
      }
    })
    attachStderrPassthrough(spawned)
    spawned.on('exit', (code) => {
      // child 已被 stopChild 置 null = 主动回收（buildEnd/重启 vite），不复活
      if (child !== spawned) return
      child = null
      if (!code || code === 0) return // 正常退出不复活
      console.error(`[pi-backend] 后端进程退出，code=${code}`)
      scheduleRestart()
    })

    void waitForHealth(spawned)
  }

  return {
    name: 'openpencil-pi-backend',
    apply: 'serve',
    config() {
      return {
        server: {
          proxy: {
            // T21：前缀从 /api/pi-chat 扩到 /api/pi（catalog/credentials/providers
            // 管理端点同走后端；/api/pi-chat 含于前缀内，前端零改动）
            '/api/pi': {
              target: `http://127.0.0.1:${port}`,
              changeOrigin: false,
              // T28：转发统一补鉴权头（http-proxy headers 选项），后端全端点鉴权后
              // 前端同源调用零改动；直连后端端口的请求无此头 → 401
              headers: { authorization: `Bearer ${authToken}` }
            }
          }
        }
      }
    },
    configureServer() {
      spawnBackend()
    },
    async buildEnd() {
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
      await stopChild()
    }
  }
}
