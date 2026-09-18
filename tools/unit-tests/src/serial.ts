#!/usr/bin/env bun
import { spawn } from 'node:child_process'
/**
 * Serial unit-test runner for tests/engine/ (rebuild/v2).
 *
 * Batches tests by first-level subdirectory under tests/engine/ (root-level
 * scattered files form their own batch). Runs `bun test <files>` per batch,
 * stops on first failure (same exit code), and prints pass/fail summaries
 * per batch. Heavy-only filtering (--heavy-only) shares isHeavyUnitTest
 * from shards.ts — single source, no local mirror.
 *
 * Usage: bun tools/unit-tests/src/serial.ts [--heavy-only] [batch ...]
 *   batch — run only the named batches (tests/engine 一级目录名, `_root`
 *   for root-level files); unknown names fail loudly (typo guard).
 *   改动域明确时只跑受影响批次，全量交 CI 或后台长跑。
 * Exit 0 = all batches pass; non-zero = first failing batch's exit code.
 */
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

import { isHeavyUnitTest } from './shards'

const ROOT = resolve(import.meta.dirname, '../../..')
const TESTS_ROOT = resolve(ROOT, 'tests/engine')

const args = new Set(process.argv.slice(2))
const heavyOnly = args.has('--heavy-only')
const onlyBatches = process.argv.slice(2).filter((a) => !a.startsWith('--'))

async function listBatchFiles(): Promise<Map<string, string[]>> {
  const entries = await readdir(TESTS_ROOT, { withFileTypes: true })
  const batches = new Map<string, string[]>()
  // root-level scattered .test.ts files → batch "_root"
  const rootLevel: string[] = []
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.test.ts')) {
      rootLevel.push(relative(ROOT, join(TESTS_ROOT, e.name)).split('\\').join('/'))
    } else if (e.isDirectory()) {
      const dirPath = join(TESTS_ROOT, e.name)
      const files: string[] = []
      await collectTestFiles(dirPath, ROOT, files)
      if (files.length > 0) batches.set(e.name, files)
    }
  }
  if (rootLevel.length > 0) batches.set('_root', rootLevel)
  return batches
}

async function collectTestFiles(absDir: string, root: string, out: string[]): Promise<void> {
  const entries = await readdir(absDir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(absDir, e.name)
    if (e.isDirectory()) {
      await collectTestFiles(p, root, out)
    } else if (e.isFile() && e.name.endsWith('.test.ts')) {
      out.push(relative(root, p).split('\\').join('/'))
    }
  }
}

function heavyFilter(files: string[]): string[] {
  if (!heavyOnly) return files
  return files.filter(isHeavyUnitTest)
}

async function runBatch(name: string, files: string[], progress: string): Promise<number> {
  if (files.length === 0) {
    console.log(`[serial] ${progress} batch ${name}: 0 files, skip`)
    return 0
  }
  console.log(`[serial] ${progress} batch ${name}: ${files.length} files`)
  const t0 = Date.now()
  return new Promise((resolveRun) => {
    const proc = spawn('bun', ['test', ...files], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, BUN_HEAVY_TESTS: heavyOnly ? 'true' : 'false' }
    })
    proc.on('close', (code) => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      const status = code === 0 ? 'PASS' : `FAIL (exit ${code ?? 'null'})`
      console.log(`[serial] ${progress} batch ${name}: ${status} in ${elapsed}s`)
      resolveRun(code ?? 1)
    })
  })
}

async function main(): Promise<void> {
  const batches = await listBatchFiles()
  // stable, alphabetical ordering for predictable output
  const allNames = [...batches.keys()].sort()
  const unknown = onlyBatches.filter((n) => !allNames.includes(n))
  if (unknown.length > 0) {
    console.error(`[serial] unknown batch: ${unknown.join(', ')} (have: ${allNames.join(', ')})`)
    process.exit(2)
  }
  const names = onlyBatches.length > 0 ? allNames.filter((n) => onlyBatches.includes(n)) : allNames
  let totalFiles = 0
  let passedBatches = 0
  let failedBatches = 0
  const t0All = Date.now()
  for (const [index, name] of names.entries()) {
    const rawFiles = batches.get(name)
    if (!rawFiles) continue
    const files = heavyFilter(rawFiles)
    if (files.length === 0) continue
    totalFiles += files.length
    const code = await runBatch(name, files, `(${index + 1}/${names.length})`)
    if (code === 0) passedBatches++
    else {
      failedBatches++
      console.error(`[serial] stopping: batch ${name} failed`)
      process.exit(code)
    }
  }
  const elapsedAll = ((Date.now() - t0All) / 1000).toFixed(1)
  console.log(
    `[serial] done: ${passedBatches}/${passedBatches + failedBatches} batches passed, ${totalFiles} files in ${elapsedAll}s${heavyOnly ? ' (heavy-only)' : ''}`
  )
}

main().catch((e) => {
  console.error('[serial] fatal:', e)
  process.exit(2)
})
