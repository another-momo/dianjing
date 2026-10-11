import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The workspace root, found by its lockfile rather than by counting directories. */
export function workspaceRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'bun.lock'))) return dir
    if (dirname(dir) === dir) throw new Error(`No workspace root above ${from}`)
  }
}

const repoRoot = workspaceRoot()

export function repoPath(...segments: string[]): string {
  return join(repoRoot, ...segments)
}

export function coreSourcePath(...segments: string[]): string {
  return repoPath('packages/core/src', ...segments)
}

export function testPath(...segments: string[]): string {
  return repoPath('tests', ...segments)
}

export function publicPath(...segments: string[]): string {
  return repoPath('public', ...segments)
}
