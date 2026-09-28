import { resolve } from 'node:path'

export function createOpenPencilAliases(rootDir: string) {
  const emptyNodeModule = resolve(rootDir, 'vite/empty-node-module.ts')

  return [
    { find: /^fs$/, replacement: emptyNodeModule },
    { find: /^path$/, replacement: emptyNodeModule },
    { find: '@', replacement: resolve(rootDir, 'src') },
    { find: '#vue', replacement: resolve(rootDir, 'packages/vue/src') },
    { find: '#core', replacement: resolve(rootDir, 'packages/core/src') },
    { find: '#dom-css', replacement: resolve(rootDir, 'packages/dom-css/src') },
    {
      find: /^@open-pencil\/dom-css\/browser$/,
      replacement: resolve(rootDir, 'packages/dom-css/src/browser.ts')
    },
    {
      find: /^@open-pencil\/dom-css\/jsx-runtime$/,
      replacement: resolve(rootDir, 'packages/dom-css/src/jsx/runtime.ts')
    },
    {
      find: /^@open-pencil\/dom-css\/jsx-dev-runtime$/,
      replacement: resolve(rootDir, 'packages/dom-css/src/jsx/dev-runtime.ts')
    },
    {
      find: /^@open-pencil\/dom-css$/,
      replacement: resolve(rootDir, 'packages/dom-css/src/index.ts')
    },
    {
      find: /^@open-pencil\/scene-graph$/,
      replacement: resolve(rootDir, 'packages/scene-graph/src/index.ts')
    },
    { find: '@open-pencil/scene-graph', replacement: resolve(rootDir, 'packages/scene-graph/src') },
    { find: /^@open-pencil\/pen$/, replacement: resolve(rootDir, 'packages/pen/src/index.ts') },
    { find: '@open-pencil/pen', replacement: resolve(rootDir, 'packages/pen/src') },
    { find: /^@open-pencil\/kiwi$/, replacement: resolve(rootDir, 'packages/kiwi/src/index.ts') },
    { find: '@open-pencil/kiwi', replacement: resolve(rootDir, 'packages/kiwi/src') },
    { find: /^@open-pencil\/fig$/, replacement: resolve(rootDir, 'packages/fig/src/index.ts') },
    { find: '@open-pencil/fig', replacement: resolve(rootDir, 'packages/fig/src') },
    { find: /^@open-pencil\/vue$/, replacement: resolve(rootDir, 'packages/vue/src/index.ts') },
    { find: '@open-pencil/vue', replacement: resolve(rootDir, 'packages/vue/src') },
    { find: /^@open-pencil\/core$/, replacement: resolve(rootDir, 'packages/core/src/index.ts') },
    // `@open-pencil/core/text` 裸 spec 会命中 package.json exports 指到 dist/text（dev 下被
    // optimizeDeps 预打包成独立实例），与 core 内部 #core/text 互导（src）分裂成两份
    // fontManager/allowlist 单例——字体 provider 配置与枚举错接。精确 alias 钉到 src。
    {
      find: /^@open-pencil\/core\/text$/,
      replacement: resolve(rootDir, 'packages/core/src/text/index.ts')
    },
    { find: '@open-pencil/core', replacement: resolve(rootDir, 'packages/core/src') },
    {
      find: 'opentype.js',
      replacement: resolve(rootDir, 'node_modules/opentype.js/dist/opentype.mjs')
    },
    { find: 'mermaid', replacement: emptyNodeModule },
    { find: 'beautiful-mermaid', replacement: emptyNodeModule }
  ]
}
