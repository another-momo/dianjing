/**
 * T45 C1 补证：旧端点 /api/pi/brand/manifest 更名后的实际行为（应不命中只读路由）。
 * 起一个 tempRoot 后端（复制 studio 资产），带 token curl 旧路径记录状态码。
 * 运行：bun spikes/probes/probe-t45-old-route.mjs（仓根）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const PORT = 7910 + Math.floor(Math.random() * 200)
const tempRoot = mkdtempSync(join(tmpdir(), 't45-oldroute-'))

for (const sub of ['workflows', 'profiles']) {
  const srcDir = join(repoRoot, 'src/app/ai/pi-backend/studio', sub)
  mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/studio', sub), { recursive: true })
  for (const f of readdirSync(srcDir)) {
    copyFileSync(join(srcDir, f), join(tempRoot, 'src/app/ai/pi-backend/studio', sub, f))
  }
}
// 与 smoke 同纪律：prompt 段一并复制，避免 service 启动期读盘差异
// T46：base.md 已落位——种子侧复制后 failures 应收零
mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/studio'), { recursive: true })
copyFileSync(
  join(repoRoot, 'src/app/ai/pi-backend/studio/base.md'),
  join(tempRoot, 'src/app/ai/pi-backend/studio/base.md')
)
// T67（2026-09-01）：system-prompt-marketing.md 孤儿化退役删除，复制清单只余 base
mkdirSync(join(tempRoot, 'src/app/ai/pi-backend/prompts'), { recursive: true })
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
  join(repoRoot, 'spikes/s-pi/backend-smoke/pi-backend-auth.mjs')
)

try {
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  if (!up) throw new Error('backend 未就绪')
  const token = readBackendToken(tempRoot)

  const oldRes = await fetch(`http://127.0.0.1:${PORT}/api/pi/brand/manifest`, {
    headers: authHeaders(token)
  })
  const oldBody = await oldRes.text()
  console.log(`旧路径 GET /api/pi/brand/manifest → ${oldRes.status} ${oldBody.slice(0, 80)}`)

  const newRes = await fetch(`http://127.0.0.1:${PORT}/api/pi/studio/manifest`, {
    headers: authHeaders(token)
  })
  const m = await newRes.json()
  console.log(
    `新路径 200=${newRes.ok}；modes=[${m.modes.map((x) => `${x.id}(${x.types.length}types)`).join(', ')}]；profiles=${m.profiles.length}；failures=${m.failures.length}（${m.failures.map((f) => `${f.kind}:${f.path}`).join('|')}）`
  )
} finally {
  if (process.platform === 'win32' && backend.pid) {
    spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    backend.kill('SIGTERM')
  }
  await new Promise((r) => setTimeout(r, 800))
  rmSync(tempRoot, { recursive: true, force: true })
}
