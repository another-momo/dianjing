/**
 * P2 打包链——把 NATIVE_EXTERNALS（yoga-layout / photon-node / clipboard）三
 * 个 npm 包从 node_modules 复制到 desktop-electron/native-externals/，供
 * electron-builder extraResources 平铺到 resources/app/native-externals/。
 *
 * **不在仓库追踪**——这些是 vendored 二进制（photon_rs_bg.wasm 等），
 * 升级 npm 时跑本脚本刷新。.gitignore 已排除 desktop-electron/native-
 * externals/。
 */
import { existsSync, mkdirSync, cpSync, copyFileSync, rmSync, readlinkSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..', '..')
const bunNodeModules = join(projectRoot, 'node_modules', '.bun', 'node_modules')

interface ExternalsEntry {
  readonly from: string
  readonly to: string
}

const ENTRIES: readonly ExternalsEntry[] = [
  // yoga-layout：package.json 里通过 npm: 改名 @open-pencil/yoga-layout（仓内
  // 复刻版，3.3.0-grid.3）；.bun/node_modules 下是 .bun/@open-pencil+yoga-layout@.../
  // 形式存的真实包名（含 + 锁标记），不能直接 join 拼
  { from: join(bunNodeModules, '@open-pencil', 'yoga-layout'), to: 'yoga-layout' },
  { from: join(bunNodeModules, '@silvia-odwyer', 'photon-node'), to: '@silvia-odwyer/photon-node' },
  { from: join(bunNodeModules, '@mariozechner', 'clipboard'), to: '@mariozechner/clipboard' }
]

// clipboard 原生 .node 按打包平台选变体——napi-rs 平台包是 os/cpu 过滤的
// optional 依赖，bun 只装当前平台（macos runner 上 win32 变体不存在，硬写
// 会让 mac 打包链炸在 staging）。且 staged 布局是平铺目录不是 node_modules
// 树：主包 index.js 的裸 specifier 回退 require('@mariozechner/clipboard-
// <platform>') 从主包目录出发解不到兄弟目录（win 打包态 MODULE_NOT_FOUND
// 实证，napi 静默降级至今未被察觉）；napi-rs loader 永远先试同目录本地文
// 件——把 .node 摆进主包目录让「本地优先」分支命中，win/mac 同法。
// darwin 用 universal 变体：一次 staging 供 arm64 + x64 双架构 dmg 共用。
const CLIPBOARD_VARIANTS: Record<string, { pkg: string; file: string }> = {
  win32: { pkg: 'clipboard-win32-x64-msvc', file: 'clipboard.win32-x64-msvc.node' },
  darwin: { pkg: 'clipboard-darwin-universal', file: 'clipboard.darwin-universal.node' }
}

const stagingDir = join(projectRoot, 'desktop-electron', 'native-externals')

function resolveBunLink(source: string): string {
  const stat = statSync(source, { throwIfNoEntry: false })
  if (!stat) throw new Error(`源不存在：${source}（bun install 还没跑？）`)
  if (stat.isSymbolicLink()) return resolveBunLink(resolve(dirname(source), readlinkSync(source)))
  return source
}

function stage(): void {
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })

  for (const entry of ENTRIES) {
    if (!existsSync(entry.from)) {
      throw new Error(`NATIVE_EXTERNAL 源缺失：${entry.from}`)
    }
    const realSource = resolveBunLink(entry.from)
    const target = join(stagingDir, entry.to)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(realSource, target, { recursive: true, dereference: true })
    console.log(`[stage] ${entry.from} -> ${target}`)
  }

  // clipboard 平台 .node → 主包目录本地优先加载位（见 CLIPBOARD_VARIANTS 注释）
  const variant = CLIPBOARD_VARIANTS[process.platform]
  if (!variant) {
    console.warn(`[stage] ${process.platform} 无 clipboard 变体登记——sidecar 内 clipboard 走 pi SDK 的 null 降级`)
  } else {
    const variantSource = join(bunNodeModules, '@mariozechner', variant.pkg)
    if (!existsSync(variantSource)) {
      throw new Error(`clipboard ${process.platform} 变体缺失：${variantSource}（bun install 未装本平台 optional 包？）`)
    }
    const realVariant = resolveBunLink(variantSource)
    copyFileSync(join(realVariant, variant.file), join(stagingDir, '@mariozechner', 'clipboard', variant.file))
    console.log(`[stage] clipboard 变体 ${variant.file} -> @mariozechner/clipboard/ 主包目录`)
  }
  console.log(`[stage] 完成：${stagingDir}`)
}

stage()