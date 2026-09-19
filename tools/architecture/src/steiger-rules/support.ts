import { readFileSync } from 'node:fs'
import path from 'node:path'

export type TreeEntry = {
  type: 'file' | 'folder'
  path: string
  children?: TreeEntry[]
}

export type Diagnostic = {
  message: string
  location: { path: string; line?: number; column?: number }
}

export type RuleResult = { diagnostics: Diagnostic[] }
export type Rule = { name: string; check: (root: TreeEntry) => RuleResult }

type FileRuleCheck = (sourceRel: string) => string | null

type TextRuleCheck = (
  sourceRel: string,
  content: string
) => Array<{ message: string; line?: number; column?: number }>

export const FILE_PREFIX_GROUP_ALLOWLIST = new Set([
  'packages/core/src/lint/rules::no',
  'tests/engine::visual',
  // T91f：tests/e2e/fonts 的 3 个 cjk- 前缀文件中 2 个是上游 follow-pure 布局
  // （fork 只新增 labels-fallback 一个），收拢为 cjk/ 子目录会对上游文件制造
  // 永久性合并摩擦——用规则自带豁免而非重构上游目录。
  'tests/e2e/fonts::cjk',
  // 2026-09-19 broker P0：pi-backend 的 path- 三件（normalize / decision /
  // observe）是同域判定栈兄弟档——收拢子目录会给 key-guard / load-image /
  // export-image-to-file / assembly 等消费方制造 import churn，用规则自带
  // 豁免（与楼上 cjk 同口径）。
  'src/app/ai/pi-backend::path'
])

type ImportRef = {
  specifier: string
  line: number
  column: number
}

export const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.vue', '.js', '.jsx', '.mjs', '.mts'])
export const ROOT_MARKDOWN_ALLOWLIST = new Set([
  'AGENTS.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'README.md',
  'SECURITY.md'
])
export const PACKAGE_ALIASES: Record<string, string> = {
  '#core/': 'packages/core/src/',
  '#vue/': 'packages/vue/src/'
}

export const PACKAGE_ALIAS_OWNERS: Record<string, string> = {
  '#core/': 'packages/core/src/',
  '#vue/': 'packages/vue/src/'
}

function normalizePath(filePath: string) {
  return filePath.split(path.sep).join('/')
}

export function relativePath(rootPath: string, filePath: string) {
  return normalizePath(path.relative(rootPath, filePath))
}

export function collectFiles(entry: TreeEntry, files: string[] = []) {
  if (entry.type === 'file') {
    if (TEXT_EXTENSIONS.has(path.extname(entry.path))) files.push(entry.path)
    return files
  }
  for (const child of entry.children ?? []) collectFiles(child, files)
  return files
}

export function collectFolders(entry: TreeEntry, folders: TreeEntry[] = []) {
  if (entry.type !== 'folder') return folders
  folders.push(entry)
  for (const child of entry.children ?? []) collectFolders(child, folders)
  return folders
}

function importsIn(content: string): ImportRef[] {
  const imports: ImportRef[] = []
  const patterns = [
    /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gm,
    /^\s*import\(\s*['"]([^'"]+)['"]\s*\)/gm
  ]

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const before = content.slice(0, match.index)
      const lines = before.split('\n')
      imports.push({
        specifier: match[1],
        line: lines.length,
        column: lines.at(-1)?.length ?? 0
      })
    }
  }
  return imports
}

function resolveImport(sourceRel: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return `src/${specifier.slice(2)}`

  for (const [alias, target] of Object.entries(PACKAGE_ALIASES)) {
    if (specifier.startsWith(alias)) return `${target}${specifier.slice(alias.length)}`
  }

  if (specifier.startsWith('.')) {
    return normalizePath(path.join(path.dirname(sourceRel), specifier))
  }

  return null
}

export function createTextRule(name: string, checkText: TextRuleCheck): Rule {
  return {
    name,
    check(root) {
      const diagnostics: Diagnostic[] = []
      for (const file of collectFiles(root)) {
        const sourceRel = relativePath(root.path, file)
        const content = readFileSync(file, 'utf8')
        for (const result of checkText(sourceRel, content)) {
          diagnostics.push({
            message: result.message,
            location: { path: file, line: result.line, column: result.column }
          })
        }
      }
      return { diagnostics }
    }
  }
}

export function createFileRule(name: string, checkFile: FileRuleCheck): Rule {
  return {
    name,
    check(root) {
      const diagnostics: Diagnostic[] = []
      for (const file of collectFiles(root)) {
        const sourceRel = relativePath(root.path, file)
        const message = checkFile(sourceRel)
        if (!message) continue
        diagnostics.push({ message, location: { path: file } })
      }
      return { diagnostics }
    }
  }
}

export function createImportRule(
  name: string,
  checkImport: (sourceRel: string, specifier: string, resolved: string | null) => string | null
): Rule {
  return {
    name,
    check(root) {
      const diagnostics: Diagnostic[] = []
      for (const file of collectFiles(root)) {
        const sourceRel = relativePath(root.path, file)
        const content = readFileSync(file, 'utf8')
        for (const imported of importsIn(content)) {
          const resolved = resolveImport(sourceRel, imported.specifier)
          const message = checkImport(sourceRel, imported.specifier, resolved)
          if (!message) continue
          diagnostics.push({
            message,
            location: { path: file, line: imported.line, column: imported.column }
          })
        }
      }
      return { diagnostics }
    }
  }
}

export function filePrefix(filePath: string): string | null {
  const name = path.basename(filePath).replace(/\.(test|spec|bench)?\.?[cm]?[tj]sx?$|\.vue$/, '')
  const match = /^([a-z][a-z0-9]+)-[a-z0-9-]+$/.exec(name)
  return match?.[1] ?? null
}
