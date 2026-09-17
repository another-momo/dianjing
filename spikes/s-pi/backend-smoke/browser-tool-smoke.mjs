/**
 * T20 P4b 浏览器工具链冒烟（真实 Chromium + 活模型 openrouter/free + 7600 桥）：
 * 用户视角全链——打开 app（编辑器自动连桥）→ 先跑 node 侧 tool-smoke.mjs
 * （API 级全链断言，本脚本等待期间页面保持打开）→ 再从真实聊天输入框发话
 * → ChatPanel 工具卡片 pending→done → 画布 frame 经 7600 桥按名复查 → 截图证据。
 *
 * 前置：vite dev server 已起（OPENROUTER_API_KEY 注入进程环境）。
 * 运行：node spikes/s-pi/backend-smoke/browser-tool-smoke.mjs [baseUrl]
 * 退出码 0 = 全过；截图证据落 smoke-screenshots/t20-*.png（仓根下，独立于状态根）。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium } from '@playwright/test'

const base = process.argv[2] ?? 'http://localhost:1420'
const root = process.cwd()
const UI_FRAME_NAME = `ui-t20-${String(Date.now()).slice(-6)}`

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

function discoveryPath() {
  // D2 状态根：与 src/app/orchestration/app-data.ts resolveAppDataRoot 真源对齐
  // win32 = %APPDATA%/Dianjing（roaming）；darwin = ~/Library/Application Support/Dianjing；
  // linux = $XDG_CONFIG_HOME/Dianjing || ~/.config/Dianjing
  let dir
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    dir = appData && appData.length > 0 ? appData : join(homedir(), 'AppData', 'Roaming')
  } else if (process.platform === 'darwin') {
    dir = join(homedir(), 'Library', 'Application Support')
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME?.trim()
    dir = xdgConfig && xdgConfig.length > 0 ? xdgConfig : join(homedir(), '.config')
  }
  // 存量兼容：新版桥写 bridge.json，缺省时回退旧版 mcp.json
  const primary = join(dir, 'Dianjing', 'bridge.json')
  return existsSync(primary) ? primary : join(dir, 'Dianjing', 'mcp.json')
}

function readDiscovery() {
  try {
    return JSON.parse(readFileSync(discoveryPath(), 'utf8'))
  } catch {
    return null
  }
}

async function bridgeRpc(toolName, toolArgs) {
  const disco = readDiscovery()
  if (!disco) throw new Error('discovery 文件不可读')
  const res = await fetch(`http://127.0.0.1:${disco.httpPort}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(disco.authToken ? { authorization: `Bearer ${disco.authToken}` } : {})
    },
    body: JSON.stringify({ command: 'tool', args: { name: toolName, args: toolArgs } })
  })
  return res.json()
}

async function bridgeHealth() {
  const disco = readDiscovery()
  if (!disco?.httpPort) return null
  return fetch(`http://127.0.0.1:${disco.httpPort}/health`)
    .then((r) => r.json())
    .catch(() => null)
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

  // 等编辑器连上 7600 桥（WorkspaceView mount → connectAutomation 注册）
  let bridgeUp = false
  for (let i = 0; i < 60 && !bridgeUp; i++) {
    await page.waitForTimeout(500)
    bridgeUp = (await bridgeHealth())?.status === 'ok'
  }
  check('编辑器已连 7600 桥（health status=ok）', bridgeUp)

  // 段 1：node 侧 API 全链冒烟（页面保持打开 = 桥执行端在线）
  const toolSmoke = spawn('node', ['spikes/s-pi/backend-smoke/tool-smoke.mjs', base], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let toolSmokeOut = ''
  toolSmoke.stdout.on('data', (d) => (toolSmokeOut += d))
  toolSmoke.stderr.on('data', (d) => (toolSmokeOut += d))
  const toolSmokeCode = await new Promise((resolve) => toolSmoke.on('exit', resolve))
  console.log(
    toolSmokeOut
      .split('\n')
      .map((l) => `    [api] ${l}`)
      .join('\n')
  )
  check('API 级工具链冒烟（tool-smoke.mjs）退出码 0', toolSmokeCode === 0)

  // 段 2：真实 UI 发话 → 工具卡片可见
  await page.getByRole('tab', { name: 'AI' }).click()
  const input = page.getByRole('textbox', { name: /Describe a change|描述/ })
  await input.waitFor({ timeout: 10000 })

  // 基线：UI 回合前的 FRAME 计数（模型对 name 参数的逐字服从非确定——
  // meta 路由实测会改名，画布断言用计数差而非名字命中）
  const before = await bridgeRpc('find_nodes', { type: 'FRAME' })
  const beforeCount = before?.result?.count ?? 0

  await input.fill(
    `请调用 create_shape 工具创建一个 FRAME：type=FRAME, x=600, y=400, width=200, height=100, name="${UI_FRAME_NAME}"。必须实际调用工具。完成后回复「已完成」。`
  )
  await input.press('Enter')

  // 工具卡片出现——限定 assistant 消息容器（用户气泡也含 prompt 文本里的
  // "create_shape" 字样，全页匹配会误中自身）；卡片名经 toolDisplayName 转换
  // （create_shape → "Create Shape"，ChatMessage.vue:29-34）
  const assistant = page.locator('[data-test-id="chat-message-assistant"]').last()
  const toolCard = assistant.getByText('Create Shape', { exact: false }).first()
  await toolCard.waitFor({ timeout: 120000 })
  check('工具卡片出现（assistant 消息内 Create Shape 可见）', await toolCard.isVisible())
  await page.screenshot({ path: join(root, 'smoke-screenshots', 't20-tool-card-pending.png') })

  // 等 done 态（卡片状态文本随 locale：zh=完成 / en=Done——dialogs.ts:161 为 en
  // 值，运行实例为 zh locale，正则双写兼容）
  const doneChip = assistant.getByText(/^(Done|完成)$/, { exact: false }).first()
  await doneChip.waitFor({ timeout: 120000 })
  check('工具卡片状态迁移到完成态', await doneChip.isVisible())
  const errorChip = assistant.getByText(/^(Error|错误)$/)
  check('工具卡片非错误态', (await errorChip.count()) === 0)

  // 助手文本收尾（限定 assistant 容器内的文本气泡，避开用户气泡里的 prompt 字样）
  const reply = assistant.locator('[data-test-id="chat-text-bubble"]').last()
  await reply.waitFor({ timeout: 120000 })
  // 元素在 text-start 即挂载（内容尚空），须等首个 delta 到达再读——否则竞态空读
  await page
    .waitForFunction(
      (el) => (el?.textContent ?? '').trim().length > 0,
      await reply.elementHandle(),
      {
        timeout: 120000
      }
    )
    .catch(() => null)
  const replyText = await reply.textContent()
  check('助手文本回复非空', (replyText ?? '').trim().length > 0, replyText?.slice(0, 60))
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(root, 'smoke-screenshots', 't20-tool-card-done.png') })

  // 展开卡片详情 → pre 里的 id 与画布回读对账（A3 证据链闭环）
  // T21：details 现在是桥原始结果 {id, name, type}（不再映射 nodeId）
  await toolCard.click()
  await page.waitForTimeout(400)
  const detailPre = assistant.locator('pre').last()
  const detailText = (await detailPre.textContent().catch(() => '')) ?? ''
  const nodeIdMatch = detailText.match(/"id"\s*:\s*"([^"]+)"/)
  check('卡片详情含节点 id', !!nodeIdMatch, detailText.slice(0, 200))
  const uiNodeId = nodeIdMatch?.[1]
  await page.screenshot({ path: join(root, 'smoke-screenshots', 't20-tool-card-detail.png') })

  // 段 3：画布复查——UI 回合后 FRAME 计数 +1，且卡片 nodeId 经桥回读存在
  const after = await bridgeRpc('find_nodes', { type: 'FRAME' })
  const afterCount = after?.result?.count ?? 0
  check(
    `画布复查：UI 回合后 FRAME 计数增加（${beforeCount} → ${afterCount}）`,
    after?.ok === true && afterCount >= beforeCount + 1,
    JSON.stringify(after).slice(0, 200)
  )
  if (uiNodeId) {
    const uiReadBack = await bridgeRpc('get_node', { id: uiNodeId })
    check(
      '卡片 nodeId 画布回读存在（UI↔画布对账）',
      uiReadBack?.ok === true && uiReadBack?.result?.type === 'FRAME',
      JSON.stringify(uiReadBack).slice(0, 200)
    )
  }
  await page.screenshot({ path: join(root, 'smoke-screenshots', 't20-canvas.png') })
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
console.log('\nT20 浏览器工具链冒烟全过')
