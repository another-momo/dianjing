import { resolve } from 'node:path'

import { normalizePath, type ServerOptions } from 'vite'

const WATCHED_MARKDOWN_ROOTS = ['/src/', '/packages/core/src/', '/packages/vue/src/']

function ignoreMarkdownOutsideSource(path: string): boolean {
  const normalized = normalizePath(path)
  if (!normalized.endsWith('.md')) return false
  return !WATCHED_MARKDOWN_ROOTS.some((root) => normalized.includes(root))
}

export const WATCH_IGNORED = [
  '**/desktop/**',
  '**/packages/docs/**',
  '**/tests/**',
  '**/.github/**',
  '**/.pi/**',
  ignoreMarkdownOutsideSource
]

export function createDevServerOptions(host: string | undefined, rootDir: string): ServerOptions {
  return {
    port: 1420,
    strictPort: true,
    host: host || false,
    // T25 D3：一条命令起全栈——vite 起来后自动开浏览器；Tauri dev（host 注入）
    // 走原生窗口，不弹浏览器
    open: !host,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421
        }
      : undefined,
    watch: {
      // Ignore nested checkouts, not an active checkout whose own path contains .worktrees.
      ignored: [...WATCH_IGNORED, `${normalizePath(resolve(rootDir, '.worktrees'))}/**`]
    }
  }
}
