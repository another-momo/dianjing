/**
 * T20 pi 后端进程入口（独立 bun 进程）。
 *
 * 启动方式：
 *  - dev：vite 插件 spawn 子进程（../vite-plugin.ts，env 继承 + 端口注入）
 *  - 独立：`bun run dev:backend`
 *
 * 环境变量：
 *  - DIANJING_PI_BACKEND_PORT：监听端口（默认 7700，见 server.ts）
 *  - DIANJING_PI_TOKEN：T28 鉴权 token——vite 插件 spawn 时注入（proxy 补头，
 *    前端零改动）。未注入（standalone `bun run dev:backend`）时自生成 32-hex
 *    随机值写 <rootDir>/pi-backend-token（0o600，tmp+rename 原子落盘），
 *    控制台只打印文件路径不打印 token；直连后端的脚本从该文件读 token。
 *  - OPENROUTER_API_KEY：模型 key。T25 D3：缺失时自动读 rootDir/key-env
 *    自助注入（shell 脚本 source 不再是前置条件）；仍缺则 service 在首个
 *    prompt 处如实报错。key 只注入 process.env，不打印不落日志。
 *  - DIANJING_ROOT_DIR：状态根目录（pi-agent/ / pi-sessions/ 等落盘点），
 *    缺省 resolveAppDataRoot()——即 OS 标准应用数据目录下的 Dianjing
 *    子目录（D2 起：直接指向状态根本身，不再内含 .dianjing 子层）。
 *    Electron sidecar 形态下由 main 进程显式注入；dev/spike 形态下若需要
 *    钉到仓根之外（例如 worktree 隔离），由调用方拼好后传入。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy'
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'

import { readPiAuthToken, readPiBackendPort, readRootDir } from '@/app/orchestration/env'

import {
  PI_BACKEND_TOKEN_FILENAME,
  resolveKeyEnvPath,
  resolveRootDir,
  resolveStateDir
} from './paths'
import { createPiBackendServer, PI_BACKEND_DEFAULT_PORT } from './server'

// 单文件打包形态（tsdown/bun build）下 pi SDK 的变量型动态 import 解析不到
// 包内模块：bedrock provider 与 OAuth flow 经 SDK 公开注册口静态预注册
// （craft-agents-oss 同款做法）；源码直跑时等价于 SDK 默认懒加载，行为不变。
setBedrockProviderModule(bedrockProviderModule)
registerBunOAuthFlows()

// D2：状态根收口——env override 直指根（不再内含 .dianjing 子层），缺省
// 走 resolveAppDataRoot（OS 标准应用数据目录下的 Dianjing 子目录）。
const rootDir = resolveRootDir(readRootDir(), process.env)

// T25 D3：key-env 自助注入（仅补缺失项，不覆盖已有 env）
function injectKeyEnv(): void {
  if (process.env.OPENROUTER_API_KEY) return
  const keyEnvPath = resolveKeyEnvPath(rootDir)
  if (!existsSync(keyEnvPath)) return
  // T27：文件在但不可读（权限/损坏）不应炸启动——降级为「缺 key」路径，
  // service 会在首个 prompt 处如实报错；文案只含路径，不含任何内容
  let lines: string[]
  try {
    lines = readFileSync(keyEnvPath, 'utf-8').split(/\r?\n/)
  } catch (error) {
    console.error(
      `[pi-backend] key-env 存在但读取失败（${keyEnvPath}）：` +
        `${error instanceof Error ? error.message : String(error)}——按未配置 key 继续`
    )
    return
  }
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    const [, name, rawValue] = match
    if (process.env[name]) continue
    const value = rawValue.replace(/^["']|["']$/g, '')
    if (value) process.env[name] = value
  }
}

injectKeyEnv()

// T28：鉴权 token 解析——env 注入（vite 插件 spawn）优先；standalone 自生成落盘。
// token 卫生：只写文件/传参，永不打印本体（控制台只给文件路径）。
function resolveAuthToken(): string {
  const injected = readPiAuthToken()
  if (injected) return injected
  const token = randomBytes(16).toString('hex')
  const stateDir = resolveStateDir(rootDir)
  mkdirSync(stateDir, { recursive: true })
  const tokenPath = `${stateDir}/${PI_BACKEND_TOKEN_FILENAME}`
  // tmp + 同目录 rename 原子替换（同 index.json 先例），防崩溃留半个文件
  const tmpPath = `${tokenPath}.tmp`
  writeFileSync(tmpPath, token, { mode: 0o600 })
  renameSync(tmpPath, tokenPath)
  console.error(
    `[pi-backend] standalone 模式：鉴权 token 已写入 ${tokenPath} ` +
      `（直连后端需带 Authorization: Bearer 头，token 本体请读该文件）`
  )
  return token
}

const authToken = resolveAuthToken()

const port = readPiBackendPort(PI_BACKEND_DEFAULT_PORT)

const server = createPiBackendServer({ rootDir, authToken })

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[pi-backend] 端口 ${port} 已被占用——是否有另一个 pi 后端实例在运行？` +
        `（可用 DIANJING_PI_BACKEND_PORT 换端口）`
    )
  } else {
    console.error(`[pi-backend] 启动失败：${error.message}`)
  }
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  console.error(`[pi-backend] listening on http://127.0.0.1:${port} (pid ${process.pid})`)
})

function shutdown() {
  server.close(() => process.exit(0))
  // 兜底：长连接未排空时 2s 后强退
  setTimeout(() => process.exit(0), 2000)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
