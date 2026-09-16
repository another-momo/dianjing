/**
 * T23 会话查看/切换冒烟（T23-plan E1-E5，验收 B3/B4/B5/B6 的浏览器半）。
 *
 * 不需要 LLM key：
 *  - /api/pi-chat 用 playwright route 拦截——捕获请求体（sessionId 断言）并
 *    回灌固定 SSE 流（UIMessage stream v1），不经真实 LLM
 *  - 会话族谱由合成 v3 JSONL 种进后端真实 index.json（OLD/MID 两个会话，
 *    docKey 前缀 = 页面里真实铸造的 docUuid 的 sha1）
 *
 * 实证流程要点（2026-08-24 MCP 实测，勿回退）：
 *  - 恢复对话框是 role=alertdialog（按钮 丢弃/恢复/关闭），其 overlay 拦截
 *    一切指针事件——须先点"恢复"关掉再操作页面
 *  - 刷新后属性 tab 复位到"设计"：点会话触发器前须重新点
 *    [data-test-id=properties-tab-ai]（面板常驻但控件仅 AI tab 下可点）
 *  - 浏览器内 openFile 须用 vite 伺服路径 '/tests/fixtures/circle-text.fig'
 *    （绝对 OS 路径会被解析成 file:// 被浏览器拦截），且 promise 要 void 掉
 *  - clear 后 onSessionReset 异步铸新会话（crypto.subtle 微任务级），
 *    ChatPanel 用 setTimeout(100ms) 刷新触发器——断言前留足余量
 *
 * 覆盖：
 *  ① 首发后触发器从 "Sessions" 变为当前会话时间标签（title=完整 sessionId）
 *  ② 种子 OLD/MID → 刷新恢复 → 族内最新（MID）回填进 DOM（B6/A3 回归）
 *  ③ 下拉列出族内 2 条（新→旧、标题=首条用户文本、消息数），当前项带勾（B3）
 *  ④ 点旧会话 → DOM 切换；再发送 → 请求沿用旧 sessionId（B4 切换继续对话）
 *  ⑤ 第二文档（新 tab 开 circle-text.fig）：不铸造 docId、下拉为空族
 *    "No sessions yet" 禁用项（B5 异族隔离）
 *  ⑥ Clear 后发送铸同前缀新后缀；当前会话未入族谱时下拉顶部出现禁用的
 *    "new session" 占位项（currentSessionMissing，E5）
 *
 * 前置：dev server 已起（T25 D3 后门退役，无需 LLM key）。
 * 运行：node spikes/s-pi/backend-smoke/t23/sessions-bind-smoke.mjs [base=http://localhost:1420]
 *   ⚠ 必须用 node——bun 跑 playwright chromium.launch 会卡 CDP pipe 握手
 *   （2026-08-24 实证：bun 下 180s launch timeout，node 秒起；二进制本身正常）
 * 清理：finally 恢复 状态根 pi-sessions/index.json 原貌并删除种子 JSONL。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium, selectors } from '@playwright/test'

// 仓内测试属性是 data-test-id（playwright 默认 data-testid 不匹配，脚本无配置文件）
selectors.setTestIdAttribute('data-test-id')

const base = process.argv[2] ?? 'http://localhost:1420'
const root = process.cwd()
// 状态根对齐（债①补漏，2026-09-16 L3 实证）：会话种子必须落 app 状态根
// pi-sessions（app-data.ts resolveAppDataRoot + PI_SESSIONS_SUBDIR）——
// 旧仓根 pi-sessions 布局后端不读（L3 实证种子 ENOENT 且不可见）
function stateRoot() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    const base = appData && appData.length > 0 ? appData : join(homedir(), 'AppData', 'Roaming')
    return join(base, 'Dianjing')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Dianjing')
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim()
  const base = xdgConfig && xdgConfig.length > 0 ? xdgConfig : join(homedir(), '.config')
  return join(base, 'Dianjing')
}
const sessionsDir = join(stateRoot(), 'pi-sessions')
const indexPath = join(sessionsDir, 'index.json')
mkdirSync(sessionsDir, { recursive: true })

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function resolveChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  }
  // 优先 playwright 当前钉死的修订版——旧修订版二进制能起进程但 CDP 握手
  // 协议失配（2026-08-24 实证：1208 + playwright-core 1.62 下 locator 全废）
  const pinned = chromium.executablePath()
  if (existsSync(pinned)) return undefined // undefined = 走默认解析
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

const SESSION_ID_RE = /^doc-[0-9a-f]{40}-\d{8}T\d{6}Z$/
const SID_OLD_SUFFIX = '20200101T000000Z'
const SID_MID_SUFFIX = '20210101T000000Z'
// 勾选图标（icon-lucide-check 的 path）——reka DropdownMenu 无内置选中态属性，
// 当前项指示是自定义 svg，DOM 断言只能认 path
const CHECK_PATH = 'M20 6L9 17l-5-5'

const chatRequests = []
const historyRequests = []

const browser = await chromium.launch({
  executablePath: resolveChromiumExecutable(),
  args: ['--enable-unsafe-swiftshader']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (err) => console.error(`[pageerror] ${String(err).slice(0, 200)}`))

await page.route('**/api/pi-chat', async (route) => {
  const body = route.request().postData() ?? '{}'
  try {
    chatRequests.push(JSON.parse(body))
  } catch {
    chatRequests.push({ sessionId: null })
  }
  const sid = chatRequests.at(-1)?.sessionId ?? ''
  const sse = [
    'data: {"type":"start","messageId":"t23smoke"}',
    '',
    'data: {"type":"text-start","id":"t23t1"}',
    '',
    `data: {"type":"text-delta","id":"t23t1","delta":"T23-ECHO ${sid}"}`,
    '',
    'data: {"type":"text-end","id":"t23t1"}',
    '',
    'data: {"type":"finish","finishReason":"stop"}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  await route.fulfill({
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'x-vercel-ai-ui-message-stream': 'v1'
    },
    body: sse
  })
})
page.on('request', (req) => {
  if (req.url().includes('/api/pi/history')) historyRequests.push(req.url())
})

function activeDocId() {
  return page.evaluate(() => {
    const store = window.openPencil?.getStore?.()
    const root = store?.graph?.getNode(store.graph.rootId)
    return (
      root?.pluginData?.find(
        (e) => e.pluginId === 'openpencil.ai' && e.key === 'openpencil.ai/docId'
      )?.value ?? null
    )
  })
}

function sessionTriggerState() {
  return page.evaluate(() => {
    const trigger = document.querySelector('[data-test-id="chat-session-trigger"]')
    return { label: trigger?.textContent?.trim() ?? null }
  })
}

// 镜像 ChatPanel.sessionTimeLabel：后缀 UTC 时间戳 → 本地 MM-dd HH:mm
// （触发器悬浮提示是 Tip 组件 role=tooltip 而非 title 属性——label 是唯一的
//  DOM 常驻信号，精确 sessionId 归属用下拉勾选项交叉断言）
function sessionTimeLabel(sessionId) {
  const match = /-(\d{8})T(\d{6})Z$/.exec(sessionId)
  if (!match) return sessionId
  const [, day, time] = match
  const date = new Date(
    `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T` +
      `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`
  )
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 引导门解锁（provider-gate 断代补钉，2026-09-16 B2 L3 实证）：无指派 → 门卡
// 占位不渲染 composer（PiChatInput v-if=isGateReady）。真源 = provider-gate.ts
// deriveGateState：指派 provider/model 须在 catalog 且 provider 凭据已配。
// 冒烟前提：dev 进程带 MINIMAX_CN_API_KEY（dummy 即可）使 minimax-cn
// configured=true；经页面上下文拿 token 拉 catalog 取首模型 PUT 写指派端点
// /api/pi/design-assignment（指派 2026-09-16 后端化，真源 <状态根>/pi-agent/
// design-assignment.json），reload 后门开。
async function ensureDesignAssignment() {
  await page.evaluate(async () => {
    const token = window.__DIANJING_LOCAL_AUTOMATION_TOKEN__
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const catalog = await (await fetch('/api/pi/catalog', { headers })).json()
    const provider = (catalog.providers || []).find(
      (p) => p.auth?.configured && (p.models || []).length > 0
    )
    if (!provider) {
      throw new Error(
        'smoke 前提不满足：无已配置凭据的 provider（dev 需带 MINIMAX_CN_API_KEY env）'
      )
    }
    const putRes = await fetch('/api/pi/design-assignment', {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        assignment: { providerId: provider.id, modelId: provider.models[0].id }
      })
    })
    if (!putRes.ok) {
      throw new Error(`指派写入失败：${putRes.status} ${await putRes.text()}`)
    }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: '设计' }).waitFor({ timeout: 20000 })
}

async function activateAiTab() {
  await page.getByTestId('properties-tab-ai').click()
  await page.getByRole('textbox', { name: 'Describe a change' }).waitFor({ timeout: 10000 })
}

async function sendChat(text) {
  const before = chatRequests.length
  const input = page.getByRole('textbox', { name: 'Describe a change' })
  await input.click()
  await input.pressSequentially(text, { delay: 5 })
  await page.getByRole('button', { name: '发送消息' }).click()
  for (let i = 0; i < 60 && chatRequests.length === before; i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  await page
    .getByTestId('chat-messages')
    .filter({ hasText: 'T23-ECHO' })
    .first()
    .waitFor({ timeout: 15000 })
  return chatRequests.at(-1)
}

async function waitChatText(text) {
  for (let i = 0; i < 40; i++) {
    const found = await page
      .getByTestId('chat-messages')
      .filter({ hasText: text })
      .count()
      .then((n) => n > 0)
      .catch(() => false)
    if (found) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function openSessionMenu() {
  // 打开菜单异步拉族谱（handleSessionMenuOpen → listPiSessionFamily fetch）——
  // 必须等响应落定再读项，否则读到的是拉取前的占位态（空清单 + new session 占位）。
  // 无 docId 的文档不发请求（只读路径），waitForResponse 超时置空即可
  const [response] = await Promise.all([
    page
      .waitForResponse((r) => r.url().includes('/api/pi/sessions'), { timeout: 10000 })
      .catch(() => null),
    page.getByTestId('chat-session-trigger').click()
  ])
  await page.getByTestId('chat-session-menu').waitFor({ timeout: 10000 })
  if (response) await page.waitForTimeout(300) // vue 重渲染余量
  return page.evaluate((checkPath) => {
    const menu = document.querySelector('[data-test-id="chat-session-menu"]')
    return [...menu.querySelectorAll('[data-test-id="chat-session-item"], [role="menuitem"]')].map(
      (el) => ({
        text: el.textContent?.trim().replace(/\s+/g, ' ') ?? '',
        disabled: el.getAttribute('aria-disabled') === 'true',
        sid: el.getAttribute('data-session-id'),
        checked: el.innerHTML.includes(checkPath)
      })
    )
  }, CHECK_PATH)
}

function seedSessionFile(file, question, answer, isoTs) {
  const lines = [
    { type: 'session', version: 3, id: `t23-${file}`, timestamp: isoTs, cwd: root },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: isoTs, provider: 'openrouter', modelId: 'openrouter/free' },
    { type: 'thinking_level_change', id: 't1', parentId: 'm1', timestamp: isoTs, thinkingLevel: 'off' },
    {
      type: 'message',
      id: 'u1',
      parentId: 't1',
      timestamp: isoTs,
      message: { role: 'user', content: [{ type: 'text', text: question }], timestamp: 1 }
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: isoTs,
      message: { role: 'assistant', content: [{ type: 'text', text: answer }] }
    }
  ]
  writeFileSync(join(sessionsDir, file), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

const indexBackup = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null
const seedFiles = ['t23-bind-seed-old.jsonl', 't23-bind-seed-mid.jsonl']

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: '设计' }).waitFor({ timeout: 20000 })
  await ensureDesignAssignment()
  await activateAiTab()

  // ── ① 首发 + 触发器标签更新
  const triggerBefore = await sessionTriggerState()
  const first = await sendChat('t23 bind smoke first')
  check('① /api/pi-chat 请求已捕获', Boolean(first?.sessionId))
  check('① sessionId 三段式', SESSION_ID_RE.test(first?.sessionId ?? ''), first?.sessionId)

  const docId = await activeDocId()
  const prefix = docId ? `doc-${createHash('sha1').update(docId).digest('hex')}` : null
  check('① 首发后 docId 铸造、前缀匹配', Boolean(prefix && first.sessionId.startsWith(`${prefix}-`)))

  const triggerAfterSend = await sessionTriggerState()
  check(
    '① 触发器从 "Sessions" 变为当前会话时间标签',
    triggerBefore.label === 'Sessions' && triggerAfterSend.label === sessionTimeLabel(first.sessionId),
    `${triggerBefore.label} → ${triggerAfterSend.label}（期望 ${sessionTimeLabel(first.sessionId)}）`
  )

  // ── ② 种子 OLD/MID → 刷新恢复 → MID 回填
  const SID_OLD = `${prefix}-${SID_OLD_SUFFIX}`
  const SID_MID = `${prefix}-${SID_MID_SUFFIX}`
  seedSessionFile('t23-bind-seed-old.jsonl', 'T23-SEED-OLD-QUESTION', 'T23-SEED-OLD-ANSWER', '2020-01-01T00:00:00.000Z')
  seedSessionFile('t23-bind-seed-mid.jsonl', 'T23-SEED-MID-QUESTION', 'T23-SEED-MID-ANSWER', '2021-01-01T00:00:00.000Z')
  const index = indexBackup ? JSON.parse(indexBackup) : {}
  index[SID_OLD] = { file: join(sessionsDir, 't23-bind-seed-old.jsonl') }
  index[SID_MID] = { file: join(sessionsDir, 't23-bind-seed-mid.jsonl') }
  writeFileSync(indexPath, JSON.stringify(index, null, 2))

  await page.evaluate(() => window.openPencil?.getStore?.()?.persistRecoveryNow?.())
  await page.reload({ waitUntil: 'domcontentloaded' })
  const restoreBtn = page.getByRole('button', { name: '恢复', exact: true })
  await restoreBtn.waitFor({ state: 'visible', timeout: 20000 })
  await restoreBtn.click()

  const midBackfilled = await waitChatText('T23-SEED-MID-ANSWER')
  check('② 刷新恢复后族内最新会话（MID）回填进 DOM', midBackfilled)
  const oldBled = await page
    .getByTestId('chat-messages')
    .filter({ hasText: 'T23-SEED-OLD' })
    .count()
  check('② 旧会话（OLD）未混入回填', oldBled === 0)
  const triggerAfterRestore = await sessionTriggerState()
  check(
    '② 回填后触发器标签 = MID 会话时间',
    triggerAfterRestore.label === sessionTimeLabel(SID_MID),
    `${triggerAfterRestore.label}（期望 ${sessionTimeLabel(SID_MID)}）`
  )

  // ── ③ 下拉族谱清单
  await activateAiTab()
  const menu1 = await openSessionMenu()
  check('③ 下拉列出族内 2 条会话', menu1.length === 2, JSON.stringify(menu1))
  check(
    '③ 排序新→旧（MID 在前）且带标题与消息数',
    menu1[0]?.sid === SID_MID &&
      menu1[1]?.sid === SID_OLD &&
      menu1[0].text.includes('T23-SEED-MID-QUESTION') &&
      menu1[1].text.includes('T23-SEED-OLD-QUESTION') &&
      menu1.every((it) => it.text.includes('2 msgs')),
    JSON.stringify(menu1)
  )
  check('③ 当前会话（MID）带勾选、另项无勾', menu1[0]?.checked === true && menu1[1]?.checked === false)

  // ── ④ 切到 OLD 并继续对话
  await page.locator(`[data-test-id="chat-session-item"][data-session-id="${SID_OLD}"]`).click()
  const oldShown = await waitChatText('T23-SEED-OLD-ANSWER')
  check('④ 点旧会话后 DOM 切换到 OLD 消息', oldShown)
  check(
    '④ 切换走 sessionId 精确读取（history?sessionId=OLD）',
    historyRequests.some((u) => u.includes(`sessionId=${encodeURIComponent(SID_OLD)}`)),
    historyRequests.join(',')
  )
  const triggerAfterSwitch = await sessionTriggerState()
  check(
    '④ 切换后触发器标签 = OLD 会话时间',
    triggerAfterSwitch.label === sessionTimeLabel(SID_OLD),
    `${triggerAfterSwitch.label}（期望 ${sessionTimeLabel(SID_OLD)}）`
  )
  const continued = await sendChat('t23 bind smoke continue old')
  check(
    '④ 切换后发送沿用旧 sessionId（继续该会话）',
    continued?.sessionId === SID_OLD,
    continued?.sessionId
  )

  // ── ⑤ 第二文档隔离：新 tab + circle-text.fig → 空族
  await page.getByTestId('tabbar-new').click()
  await page.evaluate(() => {
    void window.openPencil?.openFile?.('/tests/fixtures/circle-text.fig')
  })
  await page.waitForFunction(
    () => window.openPencil?.getStore?.()?.state?.documentName?.includes('circle-text'),
    undefined,
    { timeout: 20000 }
  )
  await page
    .getByTestId('chat-session-trigger')
    .waitFor({ timeout: 10000 })
  const docId2 = await activeDocId()
  check('⑤ 第二文档只读路径不铸造 docId', docId2 === null, docId2 ?? '(null)')
  const menu2 = await openSessionMenu()
  check(
    '⑤ 异族文档下拉为空族（仅禁用 "No sessions yet" 项）',
    menu2.length === 1 && menu2[0].disabled && menu2[0].text.includes('No sessions yet'),
    JSON.stringify(menu2)
  )
  check('⑤ 打开空族菜单后仍未铸造 docId', (await activeDocId()) === null)
  await page.keyboard.press('Escape')

  // ── ⑥ Clear 回归 + currentSessionMissing 占位项
  await page.getByRole('tab', { name: /^Untitled/ }).first().click()
  await page.getByRole('button', { name: 'Clear' }).click()
  await page.getByTestId('chat-empty-state').waitFor({ timeout: 10000 })
  // onSessionReset 异步铸新会话 + ChatPanel setTimeout(100ms) 刷新，留 500ms 余量
  await new Promise((r) => setTimeout(r, 500))
  const afterClear = await sendChat('t23 bind smoke after clear')
  check(
    '⑥ Clear 后发送铸同前缀新后缀（≠OLD ≠MID ≠首发）',
    SESSION_ID_RE.test(afterClear?.sessionId ?? '') &&
      afterClear.sessionId.startsWith(`${prefix}-`) &&
      afterClear.sessionId !== SID_OLD &&
      afterClear.sessionId !== SID_MID &&
      afterClear.sessionId !== first.sessionId,
    afterClear?.sessionId
  )
  // 拦截的会话不落后端 → 当前会话不在族谱里 → 顶部禁用 "new session" 占位项
  const menu3 = await openSessionMenu()
  check(
    '⑥ 当前会话未入族谱时下拉顶部出现禁用 "new session" 占位项（带勾）',
    menu3.length === 3 &&
      menu3[0].disabled &&
      menu3[0].text.includes('new session') &&
      menu3[0].checked &&
      menu3[1]?.sid === SID_MID &&
      menu3[2]?.sid === SID_OLD,
    JSON.stringify(menu3)
  )
} finally {
  await browser.close()
  if (indexBackup !== null) writeFileSync(indexPath, indexBackup)
  for (const f of seedFiles) rmSync(join(sessionsDir, f), { force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
