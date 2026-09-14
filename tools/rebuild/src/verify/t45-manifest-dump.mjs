/**
 * 独立核验 V1 补充：dump /api/pi/studio/manifest 完整 JSON，
 * 检查 ① profiles 摘要无 body/markdown 键 ② 全 JSON 无绝对路径泄漏（盘符/斜杠绝对路径）。
 *
 * T48 修复（2026-08-31）：动态 import 绝对路径在 Windows 上须转 file:// URL
 * （node 报 ERR_UNSUPPORTED_ESM_URL_SCHEME），改 pathToFileURL——bun 容忍裸路径、node 不容忍。
 *
 * 注意（T48 独立核验 F2 登记）：本脚本覆写的 verify-t45-manifest-dump.json 是端点原始
 * body（压缩单行），非 oxfmt canonical——跑完本脚本须 `bunx oxfmt --write` 该 json
 * 再过 format:check，否则门禁红（C3→C4 顺序自踩，T47 修正记录 8 同类）。
 */
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const PORT = 7910 + (process.pid % 200)
const tempRoot = mkdtempSync(join(tmpdir(), 't45-verify-dump-'))

// T85：workflow references 按资产分目录（workflows/editable-design/references/）——
// 改递归整目录复制，references 文件随资产进 temp 布局（缺文件会进 manifest failures）
for (const sub of ['workflows', 'profiles']) {
  const srcDir = join(repoRoot, 'src/app/ai/pi-backend/studio', sub)
  const dstDir = join(tempRoot, 'src/app/ai/pi-backend/studio', sub)
  mkdirSync(dstDir, { recursive: true })
  cpSync(srcDir, dstDir, { recursive: true })
}
mkdirSync(join(tempRoot, 'src/app/ai/chat'), { recursive: true })
mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/prompts'), { recursive: true })
copyFileSync(
  join(repoRoot, 'src/app/ai/chat/system-prompt.md'),
  join(tempRoot, 'src/app/ai/chat/system-prompt.md')
)
// T67（2026-09-01）：system-prompt-marketing.md 孤儿化退役删除，复制清单只余 base
for (const f of ['system-prompt-base.md']) {
  copyFileSync(
    join(repoRoot, 'src/app/ai/pi-backend/prompts', f),
    join(tempRoot, 'src/app/ai/pi-backend/prompts', f)
  )
}

const backend = spawn('bun', ['run', join(repoRoot, 'src/app/ai/pi-backend/main.ts')], {
  cwd: tempRoot,
  env: { ...process.env, DIANJING_PI_BACKEND_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
})
backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))

const { readBackendToken, authHeaders } = await import(
  pathToFileURL(join(repoRoot, 'spikes/s-pi/backend-smoke/pi-backend-auth.mjs')).href
)

try {
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok
    } catch {
      await new Promise((r) => {
        setTimeout(r, 250)
      })
    }
  }
  if (!up) throw new Error('backend 未就绪')
  const token = readBackendToken(tempRoot)

  const res = await fetch(`http://127.0.0.1:${PORT}/api/pi/studio/manifest`, {
    headers: authHeaders(token)
  })
  const body = await res.text()
  writeFileSync(join(repoRoot, 'tools', 'rebuild', 'verify-t45-manifest-dump.json'), body)
  const m = JSON.parse(body)
  console.log('status:', res.status)
  console.log('top-level keys:', Object.keys(m).join(','))
  console.log('modes:', JSON.stringify(m.modes, null, 1))
  console.log('profiles:', JSON.stringify(m.profiles, null, 1))
  console.log('failures:', JSON.stringify(m.failures, null, 1))
  // 泄漏检查：body/markdown 键 + 绝对路径模式（盘符 / 以 / 或 \ 开头）
  const leaks = []
  if (/"body"\s*:|"markdown"\s*:/.test(body)) leaks.push('body/markdown 键泄漏')
  if (/"[A-Za-z]:[\\/]/.test(body)) leaks.push('Windows 盘符绝对路径泄漏')
  for (const f of m.failures) {
    if (/^([A-Za-z]:[\\/]|[\\/])/.test(f.path)) leaks.push(`failure.path 绝对化: ${f.path}`)
  }
  console.log('泄漏检查:', leaks.length === 0 ? 'CLEAN' : leaks.join(' | '))
} finally {
  if (process.platform === 'win32' && backend.pid) {
    spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    backend.kill('SIGTERM')
  }
  await new Promise((r) => {
    setTimeout(r, 800)
  })
  rmSync(tempRoot, { recursive: true, force: true })
}
