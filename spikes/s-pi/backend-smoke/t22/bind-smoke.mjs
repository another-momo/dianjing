/**
 * T22 绑定冒烟（T22-plan D1/D2/D3，验收 A1/A2/A3/A6 的浏览器半）。
 *
 * 不需要 LLM key：
 *  - /api/pi-chat 用 playwright route 拦截——捕获请求体（sessionId/documentId
 *    断言）并回灌固定 SSE 流（UIMessage stream v1），不经真实 LLM
 *  - 历史回填用合成 v3 JSONL 种进后端真实 index.json（docKey 前缀 = 页面里
 *    真实铸造的 docUuid 的 sha1），刷新走恢复对话框还原后断言 DOM 回填
 *
 * 实证流程要点（2026-08-24 MCP 实测，勿回退）：
 *  - docId 只在首次发送时铸造（发送前根节点无 docId、也不发 /api/pi/history）
 *  - 聊天面板常驻但控件在右栏 AI tab 下才可见：先点 [data-test-id=properties-tab-ai]
 *  - 输入框 = role textbox name "Describe a change"；提交 = 点 "发送消息" 按钮
 *    （Enter 提交未实证，不要用）
 *  - 刷新后属性 tab 复位到"设计"——恢复还原后须重新点 AI tab 再点 Clear
 *  - 未保存文档的持久化走恢复快照：发送后 persistRecoveryNow() 再 reload，
 *    点"恢复"→ graph:replaced → ensureChat 空态重取 → 回填（同 store 复用 tab，
 *    不依赖 tab 切换 watcher）
 *  - openFile 对"Untitled 且无 undo"的 tab 会复用 store（replaceGraph 换图）——
 *    双文档隔离必须先开新 tab 再 openFile，且 openFile 的 promise 在 evaluate 里
 *    要 void 掉（await 会阻塞 evaluate 直到加载完成）
 *
 * 覆盖：
 *  ① 首次发送铸造 docUuid 进根节点 pluginData（惰性），sessionId 三段式
 *    `doc-<sha1>-<yyyyMMddTHHmmssZ>`，documentId = 当前活动 tab，此前零 history 请求
 *  ② 种子历史 → persistRecoveryNow → 刷新 → 恢复 → docId 同一身份 → DOM 回填
 *  ③ Clear 后新会话：同前缀新时间戳后缀（≠ 种子 ≠ 首发），无复活回填请求，
 *    旧会话在后端 index.json 归档保留
 *  ④ 双文档隔离：第二个文件（新 tab 开 circle-text.fig）的会话前缀不同
 *
 * 前置：dev server 已起（T25 D3 后门退役，无需 LLM key）。
 * 运行：node spikes/s-pi/backend-smoke/t22/bind-smoke.mjs [base=http://localhost:1420]
 *   ⚠ 必须用 node——bun 跑 playwright chromium.launch 会卡 CDP pipe 握手
 *   （2026-08-24 实证：bun 下 180s launch timeout，node 秒起；二进制本身正常）
 * 清理：finally 恢复 .dianjing/pi-sessions/index.json 原貌并删除种子 JSONL。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium, selectors } from '@playwright/test'

// 仓内测试属性是 data-test-id（playwright 默认 data-testid 不匹配，脚本无配置文件）
selectors.setTestIdAttribute('data-test-id')

const base = process.argv[2] ?? 'http://localhost:1420'
const root = process.cwd()
const sessionsDir = join(root, '.dianjing', 'pi-sessions')
const indexPath = join(sessionsDir, 'index.json')

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

// ── 拦截 /api/pi-chat：捕获请求体 + 回灌固定 SSE（UIMessage stream v1）。
// 回显文本带 sessionId，便于 DOM 侧交叉核对。
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
    'data: {"type":"start","messageId":"t22smoke"}',
    '',
    'data: {"type":"text-start","id":"t22t1"}',
    '',
    `data: {"type":"text-delta","id":"t22t1","delta":"T22-ECHO ${sid}"}`,
    '',
    'data: {"type":"text-end","id":"t22t1"}',
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

function activeTabId() {
  return page.evaluate(async () => {
    const tabs = await import('/src/app/tabs/index.ts')
    return tabs.getActiveTabId()
  })
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
  // 等拦截捕获 + 回显上屏
  for (let i = 0; i < 60 && chatRequests.length === before; i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  await page
    .getByTestId('chat-messages')
    .filter({ hasText: 'T22-ECHO' })
    .first()
    .waitFor({ timeout: 15000 })
  return chatRequests.at(-1)
}

const indexBackup = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null
let seedFile = null

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: '设计' }).waitFor({ timeout: 20000 })
  await activateAiTab()

  // ── ① 首次发送：惰性铸造 + 请求体形制（默认 Untitled 文档）
  const docIdBefore = await activeDocId()
  const first = await sendChat('t22 bind smoke first')
  check('① /api/pi-chat 请求已捕获', Boolean(first?.sessionId))
  check(
    '① sessionId 三段式（doc-<sha1>-<ts>）',
    SESSION_ID_RE.test(first?.sessionId ?? ''),
    first?.sessionId
  )
  const tabId = await activeTabId()
  check(
    '① documentId = 当前活动 tab',
    Boolean(first?.documentId) && first.documentId === tabId,
    `${first?.documentId} vs ${tabId}`
  )

  const docId = await activeDocId()
  check('① 首次发送后 docUuid 铸入根节点 pluginData（惰性）', Boolean(docId))
  check('① 铸造前无 docId（确为惰性）', docIdBefore === null)
  check(
    '① docId 缺席时不发 /api/pi/history（只读加载路径）',
    historyRequests.length === 0,
    historyRequests.join(',')
  )

  const prefix = docId ? `doc-${createHash('sha1').update(docId).digest('hex')}` : null
  check(
    '① sessionId 前缀 = doc-<sha1(docUuid)>',
    Boolean(prefix && first?.sessionId?.startsWith(`${prefix}-`)),
    `${first?.sessionId} vs prefix ${prefix}`
  )

  // ── ② 种子历史 → 强制快照 → 刷新 → 恢复 → DOM 回填
  if (prefix) {
    const seedSessionId = `${prefix}-20200101T000000Z`
    seedFile = join(sessionsDir, 't22-bind-seed.jsonl')
    const ts = new Date('2020-01-01T00:00:00Z').toISOString()
    const lines = [
      {
        type: 'session',
        version: 3,
        id: 't22bindseed',
        timestamp: ts,
        cwd: root
      },
      {
        type: 'message',
        id: 't22seedu1',
        parentId: null,
        timestamp: ts,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'T22-SEED-QUESTION' }],
          timestamp: 1
        }
      },
      {
        type: 'message',
        id: 't22seeda1',
        parentId: 't22seedu1',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'T22-SEED-ANSWER' }]
        }
      }
    ]
    writeFileSync(seedFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const index = indexBackup ? JSON.parse(indexBackup) : {}
    index[seedSessionId] = { file: seedFile }
    writeFileSync(indexPath, JSON.stringify(index, null, 2))

    // 确保恢复快照含已铸造的 docId，再刷新
    await page.evaluate(() => window.openPencil?.getStore?.()?.persistRecoveryNow?.())
    await page.reload({ waitUntil: 'domcontentloaded' })
    const restoreBtn = page.getByRole('button', { name: '恢复', exact: true })
    await restoreBtn.waitFor({ state: 'visible', timeout: 20000 })
    await restoreBtn.click()

    // 恢复还原是异步的（graph:replaced 后 docId 才回根节点）——轮询等落位再比对
    let docIdAfterRestore = null
    for (let i = 0; i < 40 && !docIdAfterRestore; i++) {
      docIdAfterRestore = await activeDocId()
      if (!docIdAfterRestore) await new Promise((r) => setTimeout(r, 250))
    }
    check('② 恢复还原后 docId 同一身份（快照通道持久化）', docIdAfterRestore === docId)

    let backfilled = false
    for (let i = 0; i < 40 && !backfilled; i++) {
      backfilled = await page
        .getByTestId('chat-messages')
        .filter({ hasText: 'T22-SEED-ANSWER' })
        .count()
        .then((n) => n > 0)
        .catch(() => false)
      if (!backfilled) await new Promise((r) => setTimeout(r, 500))
    }
    check('② 刷新恢复后历史回填进聊天面板（DOM 可见种子消息）', backfilled)
    check(
      '② 回填经 docKey 前缀解析（history 请求带正确前缀）',
      historyRequests.some((u) => u.includes(`docKey=${prefix}`)),
      historyRequests.join(',')
    )

    // ── ③ Clear 新开会话（刷新复位了属性 tab，须重新激活 AI tab）
    if (backfilled) {
      await activateAiTab()
      const historyCountBeforeClear = historyRequests.length
      await page.getByRole('button', { name: 'Clear' }).click()
      await page.getByTestId('chat-empty-state').waitFor({ timeout: 10000 })
      // 等 onSessionReset 的新会话铸造落定（crypto.subtle 微任务级，留 500ms 余量）
      await new Promise((r) => setTimeout(r, 500))
      const afterClear = await sendChat('t22 bind smoke after clear')
      check(
        '③ Clear 后 sessionId 同前缀新时间戳',
        SESSION_ID_RE.test(afterClear?.sessionId ?? '') &&
          afterClear.sessionId.startsWith(`${prefix}-`) &&
          afterClear.sessionId !== seedSessionId &&
          afterClear.sessionId !== first.sessionId,
        afterClear?.sessionId
      )
      check(
        '③ Clear 后无复活回填（守卫短路，不发 history 请求）',
        historyRequests.length === historyCountBeforeClear,
        historyRequests.slice(historyCountBeforeClear).join(',')
      )
      const indexNow = JSON.parse(readFileSync(indexPath, 'utf8'))
      check('③ 旧会话在后端 index.json 归档保留', Boolean(indexNow[seedSessionId]))
    }

    // ── ④ 双文档隔离（先开新 tab 再 openFile，避免复用已 AI 交互过的 store）
    await page.getByTestId('tabbar-new').click()
    await page.evaluate(() => {
      void window.openPencil?.openFile?.('/tests/fixtures/circle-text.fig')
    })
    await page.waitForFunction(
      () => window.openPencil?.getStore?.()?.state?.documentName?.includes('circle-text'),
      undefined,
      { timeout: 20000 }
    )
    const second = await sendChat('t22 bind smoke second doc')
    check(
      '④ 第二文档会话前缀不同（族谱隔离）',
      SESSION_ID_RE.test(second?.sessionId ?? '') && !second.sessionId.startsWith(`${prefix}-`),
      second?.sessionId
    )
    check(
      '④ 第二文档 documentId 不同 tab',
      Boolean(second?.documentId) && second.documentId !== tabId,
      `${second?.documentId} vs ${tabId}`
    )
  }
} finally {
  await browser.close()
  if (indexBackup !== null) writeFileSync(indexPath, indexBackup)
  if (seedFile) rmSync(seedFile, { force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
