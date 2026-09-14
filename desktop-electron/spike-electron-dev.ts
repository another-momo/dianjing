/**
 * spike-electron-spike：L3「真窗口 + sidecar 全家桶」启动器。
 *
 * 为什么是 bun 包装而不是 shell：
 *   - 跨平台：Windows cmd / PowerShell / bash 三套 env 注入语法不一致，
 *     bun 里统一用 process.env 赋值最稳；
 *   - 端口/产物存在性校验放一处：dist-main/main.mjs 缺失时直接 fail-fast，
 *     提示先跑 spike:electron:build，省一次手动排错。
 *
 * 仅设 DIANJING_SHOW=1——其余 env（端口 / token / rootDir）由 main.ts 内
 * randomPort + 内部 randomBytes 自举；不开 L3 想另起 sidecar 调试口时自己加
 * env 即可（DIANJING_BRIDGE_PORT / DIANJING_PI_BACKEND_PORT_ELECTRON
 * / DIANJING_LOOPBACK_PORT / DIANJING_ROOT_DIR）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const mainBundle = resolve(here, 'dist-main', 'main.mjs')
if (!existsSync(mainBundle)) {
  throw new Error(`main bundle 缺失：${mainBundle}——先跑 bun run spike:electron:build`)
}

const electronExe = resolve(root, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(electronExe)) {
  throw new Error(`electron 二进制缺失：${electronExe}`)
}

const child = spawn(electronExe, [mainBundle, '--no-sandbox', '--disable-gpu'], {
  cwd: root,
  env: {
    ...process.env,
    DIANJING_SHOW: '1',
    // main.ts 缺省 rootDir=app.getPath('userData')（面向打包形态）——dev 启
    // 动器显式钉到 <worktree>/.dianjing（保留多 worktree 隔离意图）。D2 起
    // override 直指状态根本身，spike 自己拼子目录：让 pi-backend 读到
    // <worktree>/.dianjing/key-env（dist/ 会被 vite build 清空，不能放凭证）
    DIANJING_ROOT_DIR: process.env.DIANJING_ROOT_DIR ?? join(root, '.dianjing')
  },
  stdio: 'inherit'
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
process.on('SIGINT', () => { child.kill('SIGINT') })
process.on('SIGTERM', () => { child.kill('SIGTERM') })