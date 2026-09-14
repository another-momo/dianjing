import { join } from 'node:path'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { main: join(import.meta.dirname, 'main.ts') },
  platform: 'node',
  format: ['esm'],
  target: 'node20',
  outDir: join(import.meta.dirname, '..', 'dist-main'),
  clean: true,
  dts: false,
  sourcemap: false,
  external: ['electron', 'node:fs', 'node:http', 'node:crypto', 'node:path'],
  deps: {
    // 打包形态 resources/app/ 无 node_modules（electron-builder.yml files 显式
    // 排除）——@open-pencil/* 是根 package.json dependencies（workspace:*），
    // tsdown 默认把 dependencies external 化会在产物里留下裸 import，安装版
    // 主进程启动即炸 ERR_MODULE_NOT_FOUND（dev 形态有仓根 node_modules 兜底，
    // 该坑潜伏至 ④ 打包 L3 才浮出）。主进程只用到 constants 一类叶子模块，
    // 内联零代价。
    alwaysBundle: [/^@open-pencil\//]
  }
})
