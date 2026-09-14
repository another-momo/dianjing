/**
 * T19 P5b 浏览器冒烟（真实 Chromium + 活模型 openrouter/free）：
 * 验证前端零改动链路——attach 注册 override transport → Chat 类 POST /api/pi-chat
 * → SSE 流式渲染 → 后端 session 历史跨回合生效。
 *
 * 前置：vite dev server 已起（T25 D3 后门退役：pi 为唯一路径；key 经 env 或 .dianjing/key-env 自助注入）。
 * 运行：node spikes/s-pi/backend-smoke/browser-smoke.mjs [baseUrl]
 * （T27 修正头注释 stale 路径——本脚本 T19 从 tests/engine/rebuild/ 迁来后未更新）
 * 退出码 0 = 全过；截图证据落 .dianjing/p5b-*.png（gitignored）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium } from '@playwright/test'

const base = process.argv[2] ?? 'http://localhost:1420'
const root = process.cwd()
const MARKER = '8246'

// 本机 playwright 缓存与 @playwright/test 期望版本可能错位：优先环境变量，
// 否则挑缓存里版本号最高的 headless shell
function resolveChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  }
  const cache = join(homedir(), 'AppData', 'Local', 'ms-playwright')
  const candidates = readdirSync(cache)
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse()
  for (const dir of candidates) {
    const exe = join(cache, dir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
    if (existsSync(exe)) return exe
  }
  return undefined
}

const failures = []
function check(label, cond, detail) {
  if (cond) console.log(`  PASS ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

const browser = await chromium.launch({
  executablePath: resolveChromiumExecutable(),
  args: ['--enable-unsafe-swiftshader']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200))
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 200)}`))

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: '设计' }).waitFor({ timeout: 20000 })

  // attach.ts 应已注册 override；确认 window.openPencil.setChatTransport 存在且已生效
  // （间接验证：切到 AI 面板后应直接出现聊天输入框而非 provider 配置引导）
  await page.getByRole('tab', { name: 'AI' }).click()

  const input = page.getByRole('textbox', { name: /Describe a change|描述/ })
  await input.waitFor({ timeout: 10000 })
  check('AI 面板直接出现聊天输入框（isConfigured 门控生效）', true)

  // 读取浏览器侧 sessionId 对账后端 index（测试脚本跨进程读取，非应用代码路径）
  const sessionId = await page.evaluate(() =>
    // oxlint-disable-next-line open-pencil/no-direct-storage-access
    window.sessionStorage.getItem('openpencil.pi-backend.session-id')
  )
  check(
    'sessionStorage 有 pi sessionId',
    typeof sessionId === 'string' && sessionId.length > 8,
    sessionId
  )

  // 回合 1：中文 + 锚点
  await input.fill(`请记住这个数字：${MARKER}。只回复「记住了」两个字。`)
  await input.press('Enter')
  const remembered = page.getByText(/记住/).last()
  await remembered.waitFor({ timeout: 120000 })
  await page.waitForTimeout(1500)
  check('R1 流式回复渲染（含「记住」）', await remembered.isVisible())
  await page.screenshot({ path: join(root, '.dianjing', 'p5b-turn1.png') })

  // 回合 2：追问锚点——只有后端 pi session 历史能提供 8246
  await input.fill('我刚才让你记住的数字是什么？只回答数字本身。')
  await input.press('Enter')
  const anchor = page.getByText(new RegExp(MARKER)).last()
  await anchor.waitFor({ timeout: 120000 })
  await page.waitForTimeout(1000)
  check('R2 回复含锚点 8246（前端→后端 session 连续性端到端）', await anchor.isVisible())
  await page.screenshot({ path: join(root, '.dianjing', 'p5b-turn2.png') })

  // 前后端 session 对账：浏览器 sessionId 出现在后端 index.json
  const indexPath = join(root, '.dianjing', 'pi-sessions', 'index.json')
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {}
  check('后端 index.json 记录浏览器 sessionId', !!index[sessionId], Object.keys(index).join(','))
  const jsonlFile = index[sessionId]?.file
  check(
    '浏览器 session 的 JSONL 含锚点两回合',
    !!jsonlFile &&
      existsSync(jsonlFile) &&
      readFileSync(jsonlFile, 'utf8').includes(MARKER) &&
      readFileSync(jsonlFile, 'utf8').includes('只回答数字本身')
  )
} finally {
  await browser.close()
}

const fatalConsole = consoleErrors.filter(
  (e) => !e.includes('canvaskit') && !e.includes('WebGPU') && !e.includes('fonts')
)
check(
  '无致命 console 错误（canvaskit/webgpu/fonts 已知告警除外）',
  fatalConsole.length === 0,
  fatalConsole.join(' | ')
)

if (failures.length) {
  console.error(`\nFAIL ${failures.length} 项：${failures.join(' / ')}`)
  process.exit(1)
}
console.log('\nT19 浏览器冒烟全过')
