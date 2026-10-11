import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveWorkspaceRoot } from './helpers/lint.ts'

const execute = promisify(execFile)
const root = await resolveWorkspaceRoot(import.meta.dir)

// storybook 出清（2026-10-09 拍板）后原钉扎件 FillSwatchTrigger.stories.ts 不在树——
// 残留不变量 = env.d.ts 与 packages/vue global.d.ts 两份 '*.vue' 模块声明在任一加载
// 序下共存不冲突；消费件用一次性合成 fixture（wildcard 声明使 .vue import 无需实体
// 文件），不再依赖仓内任何会被删除的真实文件。
const CONSUMER = "import Fixture from './Fixture.vue'\nvoid Fixture\n"

test.each(['app-first', 'sdk-first'])(
  'Vue module declarations stay load-order agnostic (%s)',
  async (order) => {
    const directory = await mkdtemp(join(tmpdir(), 'open-pencil-vue-module-'))
    try {
      const declarations = [join(root, 'src/env.d.ts'), join(root, 'packages/vue/src/global.d.ts')]
      if (order === 'sdk-first') declarations.reverse()
      const consumer = join(directory, 'consumer.ts')
      await writeFile(consumer, CONSUMER)
      const project = join(directory, 'tsconfig.json')
      await writeFile(
        project,
        JSON.stringify({
          extends: join(root, 'tsconfig.json'),
          include: [],
          files: [...declarations, consumer]
        })
      )
      const result = await execute(
        process.execPath,
        [
          join(root, 'node_modules/@typescript/native-preview/bin/tsgo'),
          '--noEmit',
          '--project',
          project
        ],
        { cwd: root, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }
      )
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  30_000
)
