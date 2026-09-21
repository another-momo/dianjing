/**
 * T22 工具目标注入冒烟（T22-plan D4，验收 A4 的后端注入半）。
 *
 * 2026-09-21 修法 A+C 更新：documentId / pageId 提到桥 args 信封外层（与
 * undo_group 同信封层；桥 resolveAutomationTarget 在 envelope 读 document_id）。
 *
 * 全程不需要 LLM key / 真实桥：直接驱动 createOpenPencilTools 的 tool.execute，
 * 用假桥（本地 HTTP 捕获服务）记录 POST /rpc 请求体，断言注入语义：
 *  ① ToolTargetSource 有 documentId → 桥 envelope 含 document_id（修法 A）
 *  ② ToolTargetSource 有 pageId → 桥 envelope 含 page_id（修法 C 端点）
 *  ③ 无 documentId/pageId → envelope 不含这两键（旧语义：落当前活动 tab）
 *  ④ 工具结果正常透传（content/details）
 *  ⑤ documentId / pageId 不进工具 schema（parameters 无 document_id/page_id
 *     键，不对模型暴露实现细节；也不进工具 args 内层——修法 A 同步清脏数据）
 *
 * discovery 文件经 DIANJING_BRIDGE_DISCOVERY_PATH 指到临时文件（paths.ts:135
 * override），不碰真实桥 discovery。
 *
 * 运行：bun spikes/s-pi/backend-smoke/t22/target-smoke.mjs（仓根）
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')

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

// ── 假桥：捕获 /rpc 请求体，回固定 create_shape 结果
const captured = []
const bridge = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        result: { id: 'node-t22-smoke', name: 'Smoke Rect', type: 'RECTANGLE' }
      })
    )
  })
})
await new Promise((r) => bridge.listen(0, '127.0.0.1', r))
const bridgePort = bridge.address().port

// ── 临时 discovery 文件（pid 指向本进程，存活检查通过）
const tempRoot = mkdtempSync(join(tmpdir(), 't22-target-'))
const discoveryPath = join(tempRoot, 'discovery.json')
process.env.DIANJING_BRIDGE_DISCOVERY_PATH = discoveryPath
writeFileSync(
  discoveryPath,
  JSON.stringify({
    pid: process.pid,
    socketPath: null,
    httpPort: bridgePort,
    authRequired: false,
    authToken: null,
    version: 't22-target-smoke',
    startedAt: new Date().toISOString()
  })
)

const { createOpenPencilTools } = await import(join(repoRoot, 'src/app/ai/pi-backend/tools.ts'))

try {
  const target = {}
  const tools = createOpenPencilTools({ current: () => 0 }, target)
  const createShape = tools.find((t) => t.name === 'create_shape')
  check('前置：create_shape 在工具集内', Boolean(createShape))

  check(
    '⑤ document_id / page_id 不进工具 schema',
    !('document_id' in (createShape?.parameters?.properties ?? {})) &&
      !('page_id' in (createShape?.parameters?.properties ?? {}))
  )

  // ① 有 documentId + pageId → 信封层注入
  target.documentId = 'tab-t22-target'
  target.pageId = 'page-t22-frozen'
  const result = await createShape.execute('tc-t22-1', {
    type: 'RECTANGLE',
    x: 1,
    y: 2,
    width: 100,
    height: 50
  })
  const withTarget = captured.at(-1)
  check(
    '① documentId 注入桥 envelope.document_id（修法 A）',
    withTarget?.args?.document_id === 'tab-t22-target',
    JSON.stringify(withTarget?.args)
  )
  check(
    '② pageId 注入桥 envelope.page_id（修法 C 端点）',
    withTarget?.args?.page_id === 'page-t22-frozen',
    JSON.stringify(withTarget?.args)
  )
  check(
    '⑤ 工具自身 args 内层无 document_id / page_id 脏数据（修法 A 顺手清）',
    !('document_id' in (withTarget?.args?.args ?? {})) &&
      !('page_id' in (withTarget?.args?.args ?? {})),
    JSON.stringify(withTarget?.args?.args)
  )
  check('① 工具自身参数原样透传', withTarget?.args?.args?.type === 'RECTANGLE')
  check(
    '④ 工具结果透传（content 含桥返回 id）',
    JSON.stringify(result?.content ?? []).includes('node-t22-smoke') &&
      result?.details?.id === 'node-t22-smoke'
  )

  // ③ 无 documentId / pageId → 不注入
  delete target.documentId
  delete target.pageId
  await createShape.execute('tc-t22-2', { type: 'ELLIPSE', x: 0, y: 0, width: 10, height: 10 })
  const withoutTarget = captured.at(-1)
  check(
    '③ 无 documentId/pageId 时 envelope 不含这两键',
    withoutTarget?.args &&
      !('document_id' in withoutTarget.args) &&
      !('page_id' in withoutTarget.args) &&
      withoutTarget.args.args.type === 'ELLIPSE',
    JSON.stringify(withoutTarget?.args)
  )
} finally {
  bridge.close()
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
