/**
 * MCP 接入阶段 1 进程级单例 accessor ——
 * pi-backend 进程只持有一个 MCPClientPool（中央连接池，蓝本 craft 架构层同款）。
 *
 * 设计动机：pool 同时被装配段（sync + getProxyToolDefs）与路由段（健康检查）消
 * 费；进程级共享避免双实例缓存漂移——保存连接后下次装配立即可见。
 *
 * 触发顺序：createMCPConnectionsStore + getMCPClientPool(rootDir) 同地初始化
 * （server.ts 在 createService 之前调一次首调，确保 pool 持有 downloadsRoot）
 * 后续装配 / 路由均经本 accessor 拿同一实例。
 *
 * 进程退出由 pi-backend 进程托管（main.ts 进程退出即终止）——不提供显式 close
 * 钩子（pool.disconnectAll 仍可经 instance 直接调，譬如进程 graceful shutdown）。
 *
 * 注入缝：测试可通过 `__resetMCPClientPoolForTests()` 还原——避免跨测试缓存
 * 漂移；生产代码不调。
 */

import { resolveMCPDownloadsDir } from '../paths'
import { MCPClientPool } from './mcp-pool'

let cachedRootDir: string | null = null
let cachedPool: MCPClientPool | null = null

/**
 * 首调构造 MCPClientPool，传入 downloadsRoot（image/audio 二进制存盘根；
 * paths.ts resolveMCPDownloadsDir 单源）。
 * 同 rootDir 重复调 = 返同一实例；rootDir 变更（测试用例 / 多 rootDir 场景）
 * = 重建——靠重置钩子显式触发，不隐式覆盖。
 */
export function getMCPClientPool(rootDir: string): MCPClientPool {
  if (cachedPool && cachedRootDir === rootDir) return cachedPool
  cachedPool = new MCPClientPool({ downloadsRoot: resolveMCPDownloadsDir(rootDir) })
  cachedRootDir = rootDir
  return cachedPool
}

/** 测试钩子：清缓存。生产代码禁调。 */
export function __resetMCPClientPoolForTests(): void {
  cachedRootDir = null
  cachedPool = null
}
