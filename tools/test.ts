import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

interface PackageJSON {
  scripts?: Record<string, string>
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} failed in ${cwd}`))
    })
  })
}

for (const entry of await readdir('tools', { withFileTypes: true })) {
  if (!entry.isDirectory()) continue

  // 角色分组容器目录（checks/ci/dev/generate）自身无 manifest——两级布局的工具包
  // 由 bun --filter 覆盖，这里只管扁平自有工具
  const cwd = join('tools', entry.name)
  const manifest = join(cwd, 'package.json')
  if (!existsSync(manifest)) continue
  const packageJSON = JSON.parse(await readFile(manifest, 'utf8')) as PackageJSON
  if (packageJSON.scripts?.test) await run('bun', ['test'], cwd)
}
