/**
 * Electron spike：pi-backend / automation bridge 两个 sidecar 的单文件打包。
 *
 * 产物：desktop-electron/dist-sidecar/{pi-backend,bridge}.mjs（ESM 单文件，
 * gitignored）。被测进程是系统 node——产物必须纯 Node API + ESM（pi SDK
 * 依赖链 ESM-only，不能出 CJS）。
 *
 * 依赖策略：除 napi/wasm 原生包外全部内联（alwaysBundle）；原生包 externals，
 * 运行时经 createRequire/dynamic import 从产物旁的 node_modules 解析（pi SDK
 * 对二者均有 null 降级，缺失不炸启动，Electron 打包期再随产物分发）。
 *
 * 别名：与 vite/aliases.ts 同源——sidecar 直接打 packages/* 源码
 * （根 tsconfig paths 已由 tsdown 自动应用，此处仅为显式兜底不需要）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'tsdown'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = join(here, '..')

// 外部化清单（运行时从产物旁的 node_modules 解析，Electron 打包期随产物分发）：
//  - photon：napi+wasm 图像库，无法内联（pi SDK 有 null 降级）
//  - clipboard：可选剪贴板 napi（同上）
//  - yoga-layout：wasm 初始化走 top-level await，内联时 rolldown 在循环依赖
//    下生成非 async 包装器包裹 await（产物语法错误），外部化绕开
const NATIVE_EXTERNALS = ['@silvia-odwyer/photon-node', '@mariozechner/clipboard', 'yoga-layout']

// css-tree 用 createRequire 动态读 JSON 数据文件（lib/data-patch.js 的
// ../data/patch.json、lib/data.js 的 mdn-data/*.json——bundler-opaque），
// 单文件形态下相对产物路径必然失配——把 .json 的 require 调用内联为字面量
const jsonRequireInlinePlugin = {
  name: 'json-require-inline',
  async transform(code: string, id: string) {
    if (!code.includes('createRequire') || !code.includes('.json')) return null
    const re = /require\(\s*['"]([^'"]+\.json)['"]\s*\)/g
    if (!re.test(code)) return null
    re.lastIndex = 0
    const replacements: Array<[string, string]> = []
    for (const match of code.matchAll(re)) {
      const spec = match[1]
      const resolved = spec.startsWith('.')
        ? { id: join(id, '..', spec) }
        : await this.resolve(spec, id, { skipSelf: true })
      if (!resolved) throw new Error(`json-require-inline: 无法解析 ${spec}（${id}）`)
      const json = await readFile(resolved.id, 'utf8')
      JSON.parse(json) // fail-fast：坏 JSON 在构建期炸，不进产物
      replacements.push([match[0], `(${json.trim()})`])
    }
    let out = code
    for (const [from, to] of replacements) out = out.replace(from, () => to)
    return out
  }
}
// vite `?raw` 约定的 rolldown 等价物（仓内 unplugin-raw 只接 vite）
const rawLoaderPlugin = {
  name: 'openpencil-raw-loader',
  resolveId(id: string, importer: string | undefined) {
    if (!id.endsWith('?raw')) return null
    return this.resolve(id.slice(0, -'?raw'.length), importer, { skipSelf: true }).then(
      (resolved) => (resolved ? `${resolved.id}?raw` : null)
    )
  },
  async load(id: string) {
    if (!id.endsWith('?raw')) return null
    const content = await readFile(id.slice(0, -'?raw'.length), 'utf8')
    return `export default ${JSON.stringify(content)}`
  }
}

// 根 tsconfig paths 未覆盖 @open-pencil/fig|kiwi（vite/aliases.ts 才有）——
// 单文件产物里它们必须是内联源码而非外部依赖（否则 ESM 启动即炸）。
// 顺序在前者优先；未命中的 id 交回 tsconfig paths / node 解析。
const pkgSources: Record<string, string> = {
  '@open-pencil/core': 'packages/core/src',
  '@open-pencil/scene-graph': 'packages/scene-graph/src',
  '@open-pencil/pen': 'packages/pen/src',
  '@open-pencil/kiwi': 'packages/kiwi/src',
  '@open-pencil/fig': 'packages/fig/src',
  '@open-pencil/dom-css': 'packages/dom-css/src',
  '@open-pencil/vue': 'packages/vue/src'
}
const aliasPlugin = {
  name: 'openpencil-source-alias',
  resolveId(id: string, importer: string | undefined) {
    for (const [pkg, srcDir] of Object.entries(pkgSources)) {
      if (id !== pkg && !id.startsWith(`${pkg}/`)) continue
      const rest = id.slice(pkg.length + 1)
      const target = rest ? join(root, srcDir, rest) : join(root, srcDir, 'index.ts')
      return this.resolve(target, importer, { skipSelf: true })
    }
    return null
  }
}

// P2：打包形态下的 NATIVE_EXTERNALS 解析基准。spike 阶段 sidecar 借助 Node
// ESM 向上爬 worktree 根的 node_modules 找到这三个包（photon/clipboard 还
// 借助 bun 硬链接躺在 .bun/node_modules/）；桌面打包形态没有 node_modules
// 兜底，必须把外部化的导入 specifier 改成相对路径，指向随产物分发的
// ./native-externals/ 子树。rolldown 写盘前在 generateBundle 钩子里做字符
// 串替换（每个 specifier 在产物里只出现一次，重写确定性高；保留原始
// 标识在单文件内联其他模块名相同的风险由 onlyExternalImportSpec 收敛）。
const onlyExternalImportSpec: Record<string, string> = {
  // 解析基准 ../native-externals/ —— sidecar 在 dist-sidecar/，往上爬一级到
  // desktop-electron/native-externals/。打包形态下 electron-builder extraResources
  // 把 desktop-electron/{dist-sidecar,native-externals}/ 两份平铺到
  // resources/app/{dist-sidecar,native-externals}/，相对路径相同不变。
  'yoga-layout': '../native-externals/yoga-layout/dist/src/index.js',
  '@silvia-odwyer/photon-node': '../native-externals/@silvia-odwyer/photon-node/photon_rs.js',
  '@mariozechner/clipboard': '../native-externals/@mariozechner/clipboard/index.js'
}
const externalRewritePlugin = {
  name: 'openpencil-external-rewrite',
  async generateBundle(_opts: unknown, bundle: Record<string, { type: string; code?: string; fileName: string }>) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk' || !chunk.code) continue
      let next = chunk.code
      for (const [from, to] of Object.entries(onlyExternalImportSpec)) {
        // 静态 `from "x"`:直接替换
        next = next.split(`from"${from}"`).join(`from"${to}"`)
        // 动态 `import("x")` / `import(\`x\`)` / `t('x)` 等 rolldown 短变量
        // 化形态都收口——三种引号各试一次，命中即替换
        next = next.split(`("${from}")`).join(`("${to}")`)
        next = next.split(`('${from}')`).join(`('${to}')`)
        next = next.split(`(\`${from}\`)`).join(`(\`${to}\`)`)
      }
      if (next !== chunk.code) chunk.code = next
    }
  }
}

function sidecar(name: string, entry: string) {
  return {
    entry: { [name]: entry },
    platform: 'node' as const,
    format: ['esm' as const],
    target: 'node20',
    outDir: join(here, 'dist-sidecar'),
    tsconfig: join(root, 'tsconfig.json'),
    sourcemap: false,
    clean: false,
    hash: false,
    dts: false,
    // P2 体积收口：minify=true（生产产物可读性不再重要）。rolldown 默认
    // 行为对 css-tree jsonRequireInlinePlugin 内联的 JSON 字面量亦做压
    // 缩（含去空白、保留语义）；若断言失败则回滚 false 并标注原因。
    minify: true,
    plugins: [rawLoaderPlugin, aliasPlugin, jsonRequireInlinePlugin, externalRewritePlugin],
    deps: {
      // alwaysBundle 先于 neverBundle 判定（tsdown DepsPlugin 顺序），
      // 外部化清单必须在 alwaysBundle 断言里排除才会落到 external
      alwaysBundle: (id: string) =>
        !NATIVE_EXTERNALS.some((dep) => id === dep || id.startsWith(`${dep}/`)),
      neverBundle: [...NATIVE_EXTERNALS, /^node:/]
    },
    outputOptions: {
      // 单入口 + 关 code splitting → 真单文件；pi SDK 的变量型动态 import
      // 保持运行期语义（bedrock/OAuth 已由 main.ts 静态预注册接管）
      codeSplitting: false
    }
  }
}

export default defineConfig([
  sidecar('pi-backend', join(root, 'src/app/ai/pi-backend/main.ts')),
  sidecar('bridge', join(root, 'src/app/bridge/server/index.ts'))
])
