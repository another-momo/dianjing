/**
 * T24 四层装配冒烟（T61 PD-16 翻案后重写）：chip 流 + 意图卡流。
 *
 * 旧版（chat-mode-select / chat-style-profile-select + 请求体 chatMode/
 * pickedProfileId）已 T60/T61 全面退役（active_design 单槽 + chip 暂存 +
 * 发消息时由 ChatPanel interceptNewIntent 拦为 ChatNewIntentCard，确认后
 * serializeNewIntentEnvelope 注入消息正文首行 envelope 串，由后端
 * stripNewIntentEnvelope 剥离置旗标进 run）。
 *
 * 不需要 LLM key：/api/pi-chat 用 playwright route 拦截——捕获请求体（envelope
 * 串断言，C4/C5 载荷语义）并回灌固定 SSE 流，不经真实 LLM。
 *
 * 覆盖（对齐原 T24 §2 C4/C5）：
 *  ① 默认 chip = general（"通用设计"），profile chip 标签 = "无风格档案"
 *  ② 切 chip 到 longform-hero-kv-first（"长图设计（hero 主视觉先行）"），
 *    profile chip 菜单按当前 mode 过滤（profilesForCurrentMode）
 *  ③ 选 watercolor_poster_v2 → 发消息 → 路由拦截捕获请求体，断言
 *    messages[0].parts[0].text 首行含
 *    [新建意图确认 modeId=<id> profileId=<id> canvas=<值>]
 *    （C4 载荷语义：envelope 置首行；非 envelope 字段不出现）
 *  ④ 流式中两个 chip 触发器均 disabled（ChatModeChips :disabled=isStreaming）
 *  ⑤ 刷新恢复后 chips 回显默认态（T61 真语义：chip 选择非持久——
 *    piPendingNewIntent 不持久化，chips 回显 = active_design 读出；mock SSE
 *    未真实建 active_design → 恢复对话框走「恢复」后回 general + 无风格档案）
 *  ⑥ 切回 general → profile 菜单按 general 过滤（modes 缺省 = 全显），chip
 *    标签回到 general
 *  ⑦ manifest 拉取失败 → chip 触发器 disabled 空态降级（C5 失败路径；
 *    piStudioManifestFailed → chipsDisabled=true。page2 全新 context 需先
 *    写指派过引导门——无指派 PiChatInput 不渲染，chips 不在 DOM）
 *
 * 前置：dev server 已起（T25 D3 后门退役）+ pi 后端已起（manifest 路由）。
 * 运行：node spikes/s-pi/backend-smoke/t24/mode-overlay-bind-smoke.mjs [base=http://localhost:1420]
 *   ⚠ 必须用 node——bun 跑 playwright chromium.launch 会卡 CDP pipe 握手
 *   （2026-08-24 实证：bun 下 180s launch timeout，node 秒起；二进制本身正常）
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium, selectors } from '@playwright/test'

// 仓内测试属性是 data-test-id（playwright 默认 data-testid 不匹配，脚本无配置文件）
selectors.setTestIdAttribute('data-test-id')

const base = process.argv[2] ?? 'http://localhost:1420'

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
  const pinned = chromium.executablePath()
  if (existsSync(pinned)) return undefined
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

const chatRequests = []
let delayNextFulfillMs = 0

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
  if (delayNextFulfillMs > 0) {
    await new Promise((r) => setTimeout(r, delayNextFulfillMs))
    delayNextFulfillMs = 0
  }
  const sse = [
    'data: {"type":"start","messageId":"t24smoke"}',
    '',
    'data: {"type":"text-start","id":"t24t1"}',
    '',
    'data: {"type":"text-delta","id":"t24t1","delta":"T24-ECHO"}',
    '',
    'data: {"type":"text-end","id":"t24t1"}',
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

// 引导门解锁（provider-gate 断代补钉，2026-09-16 B2 L3 实证）：无指派 → 门卡
// 占位不渲染 composer（PiChatInput v-if=isGateReady）。真源 = provider-gate.ts
// deriveGateState：指派 provider/model 须在 catalog 且 provider 凭据已配。
// 冒烟前提：dev 进程带 MINIMAX_CN_API_KEY（dummy 即可）使 minimax-cn
// configured=true；经页面上下文拿 token 拉 catalog 取首模型写 localStorage
// 指派（assignment.ts STORAGE_KEY），reload 后门开。
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
    window.localStorage.setItem(
      'openpencil.pi.design-model',
      JSON.stringify({ providerId: provider.id, modelId: provider.models[0].id })
    )
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
  return chatRequests.at(-1)
}

async function waitEcho() {
  await page
    .getByTestId('chat-messages')
    .filter({ hasText: 'T24-ECHO' })
    .first()
    .waitFor({ timeout: 15000 })
}

/** chip 触发器当前可见文本（mode chip 在 general 默认态 label="通用设计"） */
async function modeChipLabel() {
  return page.evaluate(
    () => document.querySelector('[data-test-id="chat-mode-chip"]')?.textContent?.trim() ?? null
  )
}

/** profile chip 触发器当前可见文本（默认 "无风格档案"） */
async function profileChipLabel() {
  return page.evaluate(
    () => document.querySelector('[data-test-id="chat-profile-chip"]')?.textContent?.trim() ?? null
  )
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: '设计' }).waitFor({ timeout: 20000 })
  await ensureDesignAssignment()
  await activateAiTab()

  // ── ① 默认 chip 态
  check('① 默认 mode chip = general（"通用设计"）', (await modeChipLabel()) === '通用设计')
  check('① 默认 profile chip = "无风格档案"', (await profileChipLabel()) === '无风格档案')

  // ── ② 切 chip 到 longform-hero-kv-first（watercolor_poster_v2 的 modes
  //    只含两个 longform——配对真源 = profile.md frontmatter modes 字段）
  await page.getByTestId('chat-mode-chip').click()
  const artDirectedItem = page.locator(
    '[data-test-id="chat-mode-chip-item"][data-mode-id="longform-hero-kv-first"]'
  )
  await artDirectedItem.waitFor({ timeout: 10000 })
  await artDirectedItem.click()
  check(
    '② 切 chip 到 longform-hero-kv-first → 标签更新',
    (await modeChipLabel())?.startsWith('长图设计') ?? false
  )

  // profile chip 菜单按 mode 过滤 → 点开列注册表 profiles
  await page.getByTestId('chat-profile-chip').click()
  const watercolorItem = page.locator(
    '[data-test-id="chat-profile-chip-item"][data-profile-id="watercolor_poster_v2"]'
  )
  await watercolorItem.waitFor({ timeout: 10000 })
  check(
    '② profile 菜单按 longform-hero-kv-first 过滤后含 watercolor_poster_v2',
    (await watercolorItem.count()) === 1
  )
  const noProfileItem = page.locator('[data-test-id="chat-profile-chip-item"]').first()
  check(
    '② profile 菜单首位 = "无风格档案" 恒在项',
    (await noProfileItem.textContent())?.includes('无风格档案') ?? false
  )

  // ── ③ 选 watercolor_poster_v2 → 延迟 SSE 发送：envelope 断言 + 流式中禁用
  await watercolorItem.click()
  check(
    '③ 选中后 profile chip 标签 = "水彩海报 v2"',
    (await profileChipLabel())?.includes('水彩海报 v2') ?? false
  )
  delayNextFulfillMs = 1500
  // 意图卡流（T61）：选过 mode/profile 的首发被 interceptNewIntent 拦为
  // ChatNewIntentCard，点确认后 serializeNewIntentEnvelope 注入消息正文首行
  // 才发请求——不能直接 sendChat（空等捕获）
  const beforeMarketing = chatRequests.length
  const marketingInput = page.getByRole('textbox', { name: 'Describe a change' })
  await marketingInput.click()
  await marketingInput.pressSequentially('t24 chip picked message', { delay: 5 })
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.getByTestId('new-intent-card').waitFor({ timeout: 10000 })
  await page.getByTestId('new-intent-confirm').click()
  for (let i = 0; i < 60 && chatRequests.length === beforeMarketing; i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  const marketingSend = chatRequests.at(-1)
  // SSE 延迟窗口内 chip 触发器应禁用（ChatModeChips :disabled=isStreaming）
  const disabledMidStream = await page.evaluate(() => {
    const mode = document.querySelector('[data-test-id="chat-mode-chip"]')
    const profile = document.querySelector('[data-test-id="chat-profile-chip"]')
    return {
      mode: mode?.hasAttribute('disabled') || mode?.getAttribute('aria-disabled') === 'true',
      profile:
        profile?.hasAttribute('disabled') || profile?.getAttribute('aria-disabled') === 'true'
    }
  })
  check(
    '③ 流式中两个 chip 均禁用',
    disabledMidStream.mode && disabledMidStream.profile,
    JSON.stringify(disabledMidStream)
  )
  await waitEcho()
  // envelope 串断言：消息正文首行必含 envelope（C4 载荷语义）
  const lastUserText =
    marketingSend?.messages
      ?.at(-1)
      ?.parts?.map((p) => p?.text)
      .filter((t) => typeof t === 'string')
      .join('\n') ?? ''
  check(
    '③ envelope 首行：modeId=longform-hero-kv-first profileId=watercolor_poster_v2',
    lastUserText.includes(
      '[新建意图确认 modeId=longform-hero-kv-first profileId=watercolor_poster_v2]'
    ),
    lastUserText.slice(0, 200)
  )
  const rawBody = JSON.stringify(marketingSend ?? {})
  check(
    // C4 载荷最小：body 不含 manifest 全文 / profile 正文（envelope 置首行已
    // 是身份摘要；其余正文是用户消息本身）
    '③ envelope 外不掺 manifest/overlay 全文（profile 正文 / types 段标题）',
    !rawBody.includes('Material types in the current brand') && !rawBody.includes('applicableTo'),
    rawBody.slice(0, 200)
  )

  // ── ④ 刷新恢复后 chips 回显默认态（T61 真语义：chip 选择非持久——
  //    piPendingNewIntent 不持久化；chips 回显 = active_design 读出，mock SSE
  //    未真实建 active_design → 回 general + 无风格档案）
  await page.evaluate(() => window.openPencil?.getStore?.()?.persistRecoveryNow?.())
  await page.reload({ waitUntil: 'domcontentloaded' })
  const restoreBtn = page.getByRole('button', { name: '恢复', exact: true })
  await restoreBtn.waitFor({ state: 'visible', timeout: 20000 })
  await restoreBtn.click()
  await activateAiTab()
  check('④ 刷新后 mode chip 回显默认 general', (await modeChipLabel()) === '通用设计')
  check(
    '④ 刷新后 profile chip 回显默认「无风格档案」',
    (await profileChipLabel())?.includes('无风格档案') ?? false
  )

  // ── ⑤ 切回 general → profile 菜单回到全 mode
  await page.getByTestId('chat-mode-chip').click()
  const generalItem = page.locator('[data-test-id="chat-mode-chip-item"][data-mode-id="general"]')
  await generalItem.waitFor({ timeout: 10000 })
  await generalItem.click()
  check('⑤ 切回 general → mode chip 标签 = "通用设计"', (await modeChipLabel()) === '通用设计')

  // ── ⑥ manifest 拉取失败 → chip 触发器 disabled 空态降级（C5 失败路径）
  // browser.newPage 是全新 context（localStorage 干净、无恢复对话框）；
  // 本页只拦 manifest（abort），不切模式发送
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page2.on('pageerror', (err) => console.error(`[page2 pageerror] ${String(err).slice(0, 200)}`))
  await page2.route('**/api/pi/studio/manifest', (route) => route.abort())
  await page2.goto(base, { waitUntil: 'domcontentloaded' })
  // 引导门前提：全新 context 无指派 → PiChatInput（chips 挂载其中）不渲染。
  // 经 catalog（未被拦，拦的只有 manifest）取已配 provider 写指派，reload 门开
  await page2.evaluate(async () => {
    const token = window.__DIANJING_LOCAL_AUTOMATION_TOKEN__
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const catalog = await (await fetch('/api/pi/catalog', { headers })).json()
    const provider = (catalog.providers || []).find(
      (p) => p.auth?.configured && (p.models || []).length > 0
    )
    if (!provider) throw new Error('⑥ 前提不满足：无已配置凭据的 provider')
    window.localStorage.setItem(
      'openpencil.pi.design-model',
      JSON.stringify({ providerId: provider.id, modelId: provider.models[0].id })
    )
  })
  await page2.reload({ waitUntil: 'domcontentloaded' })
  await page2.getByRole('tab', { name: '设计' }).waitFor({ timeout: 20000 })
  await page2.getByTestId('properties-tab-ai').click()
  const modeChipDisabled = await page2.evaluate(
    () =>
      document.querySelector('[data-test-id="chat-mode-chip"]')?.hasAttribute('disabled') ?? false
  )
  check('⑥ manifest 拉取失败 → mode chip 触发器 disabled', modeChipDisabled)
  const profileChipDisabled = await page2.evaluate(
    () =>
      document.querySelector('[data-test-id="chat-profile-chip"]')?.hasAttribute('disabled') ??
      false
  )
  check('⑥ manifest 拉取失败 → profile chip 触发器 disabled', profileChipDisabled)
} finally {
  await browser.close()
  // 冒烟用的 playwright 独立 profile 随浏览器关闭即弃（localStorage 指派随之），
  // 无需清理；发送均被 route 拦截，后端零写入
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
