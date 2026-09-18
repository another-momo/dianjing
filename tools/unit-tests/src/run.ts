#!/usr/bin/env bun

import {
  isSoloUnitTest,
  listHeavyUnitTests,
  listUnitTests,
  type UnitTestGroup,
  unitTestGroupNames
} from './shards'

/**
 * Runs `bun test` over one shard group.
 *
 *   bun tools/unit-tests/src/run.ts [group] [--include-heavy | --heavy-only] [-- <bun test args>]
 *
 * Quick runs (the default) skip heavy fixture files and heavy-marked blocks;
 * `--include-heavy` runs everything and `--heavy-only` runs only the heavy
 * fixture files. Arguments after `--` go to `bun test` unchanged.
 */
const separator = process.argv.indexOf('--')
const ownArgs = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator)
const bunTestArgs = separator === -1 ? [] : process.argv.slice(separator + 1)
const flags = new Set(ownArgs.filter((arg) => arg.startsWith('--')))
const group = (ownArgs.find((arg) => !arg.startsWith('--')) ?? 'all') as UnitTestGroup

if (!unitTestGroupNames().includes(group)) {
  throw new Error(
    `Unknown unit test group: ${group}. Expected one of: ${unitTestGroupNames().join(', ')}`
  )
}

const heavyOnly = flags.has('--heavy-only')
const includeHeavy = heavyOnly || flags.has('--include-heavy')
const files = heavyOnly
  ? await listHeavyUnitTests(group)
  : await listUnitTests(group, { includeHeavy })

if (files.length === 0) {
  console.log(`No unit tests found for shard ${group}`)
  process.exit(0)
}

async function runBunTest(paths: string[]): Promise<number> {
  const child = Bun.spawn([process.execPath, 'test', ...bunTestArgs, ...paths], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, BUN_HEAVY_TESTS: includeHeavy ? 'true' : 'false' }
  })
  return child.exited
}

// fork patch（T91j）：SOLO 清单文件拆独立进程跑，规避多文件同进程事件投递 stall
const soloFiles = files.filter(isSoloUnitTest)
const batchFiles = files.filter((file) => !isSoloUnitTest(file))

if (batchFiles.length > 0) {
  const batchExit = await runBunTest(batchFiles)
  if (batchExit !== 0) process.exit(batchExit)
}
for (const file of soloFiles) {
  const soloExit = await runBunTest([file])
  if (soloExit !== 0) process.exit(soloExit)
}
process.exit(0)
