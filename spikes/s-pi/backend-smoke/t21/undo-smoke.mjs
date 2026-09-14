/**
 * T21 冒烟④：桥 mutates 工具产生 `AI: <name>` undo 条目（tool-handlers.ts
 * withAIUndo，对齐旧 ToolLoop 环绕）。
 *
 * 流程：打开 app（编辑器连 7600 桥）→ 桥 RPC create_shape（mutates:true）
 * → 页面内断言 undo 栈顶 label === 'AI: create_shape' → undoAction() 后
 * 节点经桥回读消失 → redoAction() 后节点恢复。
 *
 * 前置：vite dev server 已起。不需要模型 key（不经聊天回合，直打桥）。
 * 运行：node spikes/s-pi/backend-smoke/t21/undo-smoke.mjs [baseUrl]
 * 退出码 0 = 全过。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium } from '@playwright/test'

const base = process.argv[2] ?? 'http://localhost:1420'
const SHAPE_NAME = `t21-undo-${String(Date.now()).slice(-6)}`

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
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local')
    return join(local, 'OpenPencil', 'mcp.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'OpenPencil', 'mcp.json')
  }
  const xdg = process.env.XDG_RUNTIME_DIR?.trim()
  return join(xdg || join(homedir(), '.dianjing'), 'mcp.json')
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

console.log(`T21 undo 冒烟 → ${base}`)

const browser = await chromium.launch({
  executablePath: resolveChromiumExecutable(),
  args: ['--enable-unsafe-swiftshader']
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: '设计' }).waitFor({ timeout: 20000 })

  let bridgeUp = false
  for (let i = 0; i < 60 && !bridgeUp; i++) {
    await page.waitForTimeout(500)
    bridgeUp = (await bridgeHealth())?.status === 'ok'
  }
  check('编辑器已连 7600 桥（health status=ok）', bridgeUp)
  if (!bridgeUp) throw new Error('bridge not connected')

  // 桥 RPC 直打 mutates 工具（withAIUndo 环绕在桥 handler 内，不经聊天回合）
  const created = await bridgeRpc('create_shape', {
    type: 'RECTANGLE',
    x: 640,
    y: 320,
    width: 100,
    height: 100,
    name: SHAPE_NAME
  })
  const nodeId = created?.result?.id
  check(
    '桥 create_shape 建节点成功',
    created?.ok === true && typeof nodeId === 'string',
    JSON.stringify(created).slice(0, 200)
  )

  // undo 栈顶条目 label（UndoManager.undoStack 为 TS private，运行期可读；冒烟专用）
  const topLabel = await page.evaluate(() => {
    const store = window.openPencil?.getStore?.()
    return store?.undo?.undoStack?.at(-1)?.label ?? null
  })
  check('undo 栈顶 label 为 "AI: create_shape"', topLabel === 'AI: create_shape', String(topLabel))

  // UI 等价路径撤销 → 节点经桥回读消失
  // （get_node 未命中时桥返回 ok:true + result.error，不是传输层失败）
  await page.evaluate(() => window.openPencil?.getStore?.()?.undoAction?.())
  await page.waitForTimeout(300)
  const afterUndo = await bridgeRpc('get_node', { id: nodeId })
  check(
    'undo 后节点消失（桥回读）',
    afterUndo?.result?.id !== nodeId,
    JSON.stringify(afterUndo).slice(0, 200)
  )

  // 重做 → 节点恢复
  await page.evaluate(() => window.openPencil?.getStore?.()?.redoAction?.())
  await page.waitForTimeout(300)
  const afterRedo = await bridgeRpc('get_node', { id: nodeId })
  check(
    'redo 后节点恢复（RECTANGLE）',
    afterRedo?.ok === true && afterRedo?.result?.type === 'RECTANGLE',
    JSON.stringify(afterRedo).slice(0, 200)
  )
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`\nFAIL ${failures.length} 项：${failures.join(' / ')}`)
  process.exit(1)
}
console.log('\nT21 undo 冒烟全过')
