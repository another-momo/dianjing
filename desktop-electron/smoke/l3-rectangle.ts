/**
 * spike L3 人工验收驱动（electron-spike）：真窗口 + 真模型，发一条
 * 「画矩形」消息，验证文档真的变化。
 *
 * 驱动方式：手动 spawn electron + chromium.connectOverCDP——不用
 * playwright 的 electron.launch（它对 ESM main 挂起：launch 经 node
 * inspector 注入的初始化脚本假定 CJS 全局 require，ESM main 下永不返回，
 * 180s 超时。实证见 _ops/20260907-l3/run.log）。
 *
 * 链路：spawn electron（--remote-debugging-port=0）→ 从 stderr 解析
 * 「DevTools listening on ws://…」→ connectOverCDP → 轮询出 app 页面 →
 * 分阶段截图落 _ops/20260907-l3/。
 *
 * 运行（必须系统 node，不能 bun——playwright 内置 ws 客户端在 bun 下对
 * Chromium DevTools 的 101 Upgrade 握手永不完成，实证 60s 超时；原生
 * WebSocket 却正常）：
 *   bun build desktop-electron/smoke/l3-rectangle.ts --target node --format esm \
 *     --outfile desktop-electron/dist-smoke/l3-rectangle.mjs \
 *     --external @playwright/test --external playwright-core
 *   node desktop-electron/dist-smoke/l3-rectangle.mjs
 * 前置：dist/（vite build）、dist-main/、dist-sidecar/ 均已构建；
 *       上游 key-env（%APPDATA%/Dianjing/key-env）存在（复制进临时
 *       rootDir——D2 起 rootDir 即状态根本身，key-env 直接挂 root）。
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type Page } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const SHOTS = 'D:\\Desktop\\AgentLearn\\00_DIYProjects\\0720openpencil\\_ops\\20260907-l3'
// D2 起 dev 形态状态根 = %APPDATA%/Dianjing——key-env 从统一根取，不再读
// 仓根 .dianjing/（旧布局遗物）。
const SOURCE_KEY_ENV = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'Dianjing',
  'key-env'
)

mkdirSync(SHOTS, { recursive: true })

const rootDir = join(tmpdir(), `op-l3-${Date.now()}`)
mkdirSync(rootDir, { recursive: true })
copyFileSync(SOURCE_KEY_ENV, join(rootDir, 'key-env'))
console.log('[l3] rootDir =', rootDir)

let child: ChildProcess | null = null
let browser: Browser | null = null

function killTree(): void {
  if (browser) { browser.close().catch(() => {}) }
  if (child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/F', '/T'], { stdio: 'ignore' }) } catch { /* 已退出 */ }
  }
}
process.on('SIGINT', () => { killTree(); process.exit(130) })
process.on('SIGTERM', () => { killTree(); process.exit(143) })

/** 从 stderr 逐行扫 DevTools ws 端点（remote-debugging-port=0 随机端口） */
function waitForDevToolsWs(proc: ChildProcess, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = ''
    const timer = setTimeout(() => rejectPromise(new Error('30s 内未等到 DevTools listening')), timeoutMs)
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      // 透传关键日志，过滤 proxyPi 刷屏
      for (const line of text.split('\n')) {
        if (line.trim() && !line.includes('[proxyPi]')) process.stderr.write(`${line}\n`)
      }
      buffer += text
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) {
        clearTimeout(timer)
        resolvePromise(match[1])
      }
    })
    proc.on('exit', (code) => { clearTimeout(timer); rejectPromise(new Error(`electron 提前退出 code=${code}`)) })
  })
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  console.log(`[l3] 截图 _ops/20260907-l3/${name}.png`)
}

async function main(): Promise<void> {
  child = spawn(
    resolve(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [resolve(root, 'desktop-electron', 'dist-main', 'main.mjs'), '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0'],
    {
      cwd: root,
      env: { ...process.env, DIANJING_SHOW: '1', DIANJING_ROOT_DIR: rootDir },
      stdio: ['ignore', 'inherit', 'pipe']
    }
  )

  const wsEndpoint = await waitForDevToolsWs(child)
  // connectOverCDP 直连 browser ws 端点对 Electron 会卡在握手（实证超时）——
  // 改走 http 端点，让 playwright 自己拉 /json/version 拿 webSocketDebuggerUrl
  const httpEndpoint = wsEndpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '')
  console.log('[l3] DevTools 端点：', httpEndpoint)
  browser = await chromium.connectOverCDP({ endpointURL: httpEndpoint, timeout: 60_000 })

  // 等 app 窗口页面出现（main 要等 sidecar /health 后才 createWindow）
  let page: Page | null = null
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      const candidate = context.pages().find((p) => p.url().startsWith('http://127.0.0.1'))
      if (candidate) { page = candidate; break }
    }
    if (page) break
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!page) throw new Error('60s 内未等到 app 页面（sidecar 未就绪或窗口创建失败）')
  page.setDefaultTimeout(30_000)
  await page.bringToFront()
  await page.setViewportSize({ width: 1280, height: 800 })

  await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(5_000) // 等编辑器初始化（CanvasKit wasm 加载）

  // 问题发现：把页面 console / 页面错误打进日志（Electron renderer 进程异常常被吞）
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[l3][page-${msg.type()}]`, msg.text().slice(0, 500))
    }
  })
  page.on('pageerror', (err) => {
    console.log('[l3][pageerror]', err.message.slice(0, 500))
  })

  await shot(page, '01-home')

  // 记录可见按钮清单，供 locator 调优
  const buttonTexts = await page.locator('button:visible').allInnerTexts().catch(() => [] as string[])
  console.log('[l3] 可见按钮：', JSON.stringify(buttonTexts.slice(0, 30)))

  // 首页 → 新文档：尝试常见入口（按既有 UI 文案逐个试）
  const newDocCandidates = [
    page.getByRole('button', { name: /new|新建|创建/i }).first(),
    page.locator('button:has-text("New")').first(),
    page.locator('[data-new-document], [data-testid*="new"]').first()
  ]
  let entered = false
  for (const candidate of newDocCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click()
      entered = true
      break
    }
  }
  console.log('[l3] 新文档入口点击：', entered ? '已点击' : '未找到候选，可能已在编辑器')
  await page.waitForTimeout(4_000)
  await shot(page, '02-editor')

  // 找聊天输入框——先点开右侧 AI 面板。
  // 实证：编辑器默认落「设计」页签；AI 页签是 button 但带显式 role="tab"
  // 覆盖了隐式 button 角色，getByRole('button', ...) 匹配不到。
  // 用 button[role="tab"]:has-text("AI") 或 getByRole('tab', { name: 'AI' })。
  const aiTab = page
    .locator('button[role="tab"]')
    .filter({ hasText: /^AI$/ })
    .first()
  const aiTabOk = await aiTab.isVisible().catch(() => false)
  if (aiTabOk) {
    await aiTab.click()
    await page.waitForTimeout(1_500)
    console.log('[l3] 已点开 AI 页签')
  } else {
    console.log('[l3] 未找到 AI 页签——尝试 getByRole(tab) 兜底')
    const aiTabAlt = page.getByRole('tab', { name: 'AI' }).first()
    if (await aiTabAlt.isVisible().catch(() => false)) {
      await aiTabAlt.click()
      await page.waitForTimeout(1_500)
      console.log('[l3] 已点开 AI 页签（getByRole 兜底）')
    }
  }

  // 实证：聊天输入框是 contenteditable div，不是 textarea。
  // 取 visible 的 [contenteditable="true"]——AI 面板下通常只有 1 个可见。
  const chatBox = page.locator('[contenteditable="true"]:visible').first()
  if (!(await chatBox.isVisible().catch(() => false))) {
    await shot(page, '03-no-chatbox')
    throw new Error('聊天输入框不可见——现场图 03-no-chatbox.png')
  }
  await chatBox.click()
  // fill() 对 contenteditable 同样有效（playwright 会触发 input 事件）
  await chatBox.fill('在画布中央新建一个 100x100 的红色矩形')
  await shot(page, '03-message-ready')
  // 发送：按 Enter（不在 IME 合成中，press('Enter') 直接提交）
  await page.keyboard.press('Enter')
  console.log('[l3] 消息已发送，等待 agent 完成（上限 120s）……')

  // 完成态探测——退化为：每 15s 一张进度图，120s 上限；
  // 最后以 05-final.png + 页面尾部文本为准（contenteditable 没法精确查 disabled）。
  // 仍尝试一轮"输入框恢复可用 + 无 stop 类元素"启发式判断作辅助。
  const start = Date.now()
  let nextShot = 20_000
  let done = false
  while (Date.now() - start < 120_000) {
    const elapsed = Date.now() - start
    if (elapsed >= nextShot) {
      await shot(page, `04-progress-${Math.round(elapsed / 1000)}s`)
      nextShot += 15_000
    }
    const state = await page
      .evaluate(() => {
        const ce = document.querySelector('[contenteditable="true"]') as HTMLElement | null
        const stopLike = document.querySelector(
          '[class*="stop" i], [aria-label*="stop" i], [aria-label*="停止" i], button[data-state="running"]'
        )
        const inputReady = !!ce && ce.getAttribute('contenteditable') !== 'false' && ce.getAttribute('aria-disabled') !== 'true'
        return JSON.stringify({ inputReady, stopVisible: !!stopLike })
      })
      .catch(() => '{}')
    const parsed = JSON.parse(state) as { inputReady?: boolean; stopVisible?: boolean }
    if (elapsed > 20_000 && parsed.inputReady && !parsed.stopVisible) {
      done = true
      console.log(`[l3] ${Math.round(elapsed / 1000)}s 启发式判定完成（contenteditable 恢复可用 + 无 stop 按钮）`)
      break
    }
    await page.waitForTimeout(5_000)
  }
  if (!done) console.log('[l3] 120s 内未触发启发式完成——以 05-final 现场为准')
  await shot(page, '05-final')

  // 落聊天尾部文本作文字证据（agent 回复 / 错误都从这里读）
  const bodyText = await page.locator('body').innerText().catch(() => '')
  console.log('[l3] 页面尾部文本（1200 字内）：\n', bodyText.slice(-1200))
  console.log('[l3] 完成——人工核对 05-final.png 是否有矩形 + 聊天完成态')
}

main()
  .catch((error) => {
    console.error('[l3] 失败：', error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => { killTree() })
