import { existsSync } from 'node:fs'

export const TYPE_SHAPE_ROOTS = [
  'src',
  'packages/core/src',
  'packages/vue/src',
  'tests',
  'tools'
] as const

const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.worktrees'])

export function isTypeShapeSourcePath(path: string): boolean {
  if (path.endsWith('.d.ts')) return false
  return path.split(/[\\/]/).every((segment) => !EXCLUDED_DIRECTORIES.has(segment))
}

export async function discoverTypeShapeFiles(
  roots: readonly string[] = TYPE_SHAPE_ROOTS
): Promise<string[]> {
  const files: string[] = []
  for (const root of roots) {
    // 根目录可能已整体退役（如 scripts/ 的 tauri menu 生成器删除后目录消失）——
    // Windows 上 Bun.Glob.scan 对缺失根抛 ENOENT（Linux 返回空），统一跳过
    if (!existsSync(root)) continue
    for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan(root)) {
      // Windows 上 glob 产出反斜杠——统一正斜杠，保证输出跨平台一致
      const normalized = path.replaceAll('\\', '/')
      if (!isTypeShapeSourcePath(normalized)) continue
      files.push(`${root}/${normalized}`)
    }
  }
  return files.sort()
}
