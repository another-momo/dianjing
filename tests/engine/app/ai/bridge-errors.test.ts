/**
 * T98：桥失败错误分类（模型可见文案）钉扎。
 *
 * 实证缺陷：render 工具 JSX 解析错（模型误输出字面 `</jsx>`）被旧实现包成
 * 「7600 桥执行失败：Unexpected token (29:103)——确认浏览器已打开 app」——
 * ① 工具侧解析错误误标为编辑器离线类连接故障；② 模型可见文本泄露端口与
 * 「桥」架构措辞（违反 T66/T81「内部设施不外露」）。
 *
 * 判别缝（src/app/ai/pi-backend/bridge-errors.ts classifyBridgeFailure）：
 *  - 连接级（discovery 缺失/fetch 拒绝/401/502 = 编辑器确实不可达）
 *    → EDITOR_UNREACHABLE_MESSAGE 统一文案，无端口/桥字眼
 *  - 工具执行级（桥 2xx + {ok:false,error} = 编辑器在线、工具自身抛错）
 *    → 透传清洗后的工具 message，不附离线指引
 *
 * 另钉两处配合面：
 *  - 桥 server.ts：浏览器显式应答 ok:false → HTTP 200（非 502）——分类缝的
 *    状态码来源（WebSocket 假浏览器集成钉扎）
 *  - core design-jsx/render.ts：sucrase 报错坐标映射回 jsx 入参 + 可操作指引
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { buildComponent } from '@open-pencil/core'

import {
  classifyBridgeFailure,
  EDITOR_UNREACHABLE_MESSAGE,
  sanitizeToolErrorMessage
} from '@/app/ai/pi-backend/bridge-errors'
import { startServer } from '@/app/bridge/server/server'

const OWNER_CASE_JSX = '<Rectangle w={200} h={120} bg="#3B82F6" rounded={8} /></jsx>'

describe('classifyBridgeFailure：连接级失败（编辑器不可达）', () => {
  test('502（编辑器未连接/RPC 超时/断连）→ 统一离线指引，不透传上游 error', () => {
    const failure = classifyBridgeFailure(
      502,
      { ok: false, error: 'OpenPencil app is not connected. STOP and tell the user...' },
      'render'
    )
    expect(failure).toEqual({ kind: 'editor-unreachable', message: EDITOR_UNREACHABLE_MESSAGE })
  })

  test('401 与非 2xx 一律归连接级', () => {
    expect(classifyBridgeFailure(401, { error: 'Unauthorized' }, 'render').kind).toBe(
      'editor-unreachable'
    )
    expect(classifyBridgeFailure(500, null, 'render').kind).toBe('editor-unreachable')
  })

  test('连接级文案不含内部设施字眼（端口/桥/discovery/dev server）', () => {
    expect(EDITOR_UNREACHABLE_MESSAGE).not.toMatch(/7600|桥|bridge|discovery|dev server/i)
    expect(EDITOR_UNREACHABLE_MESSAGE).toContain('browser tab')
  })
})

describe('classifyBridgeFailure：工具执行失败（编辑器在线）', () => {
  test('200 + ok:false → 透传工具自身 message（owner 实证案例），不附离线指引', () => {
    const toolMessage =
      'Invalid JSX: Unexpected token at line 1, column 65 of the jsx input. Output valid JSX only.'
    const failure = classifyBridgeFailure(200, { ok: false, error: toolMessage }, 'render')
    expect(failure.kind).toBe('tool-error')
    expect(failure.message).toBe(toolMessage)
    expect(failure.message).not.toContain('Editor is not reachable')
    expect(failure.message).not.toMatch(/7600|桥/)
  })

  test('工具错误缺 message → 带工具名的兜底文案', () => {
    const failure = classifyBridgeFailure(200, { ok: false }, 'render')
    expect(failure).toEqual({
      kind: 'tool-error',
      message: 'Tool render failed without an error message.'
    })
  })

  test('畸形 body（2xx 但 ok 非 true 非 false）归连接级而非工具错误', () => {
    expect(classifyBridgeFailure(200, null, 'render').kind).toBe('editor-unreachable')
    expect(classifyBridgeFailure(200, { ok: true }, 'render').kind).toBe('editor-unreachable')
  })
})

describe('sanitizeToolErrorMessage：最小清洗', () => {
  test('干净 message 原样透传', () => {
    expect(sanitizeToolErrorMessage('Node "9:9" not found', 'move_node')).toBe(
      'Node "9:9" not found'
    )
  })

  test('含核心包绝对路径（POSIX/Windows）→ 剥为占位符', () => {
    expect(
      sanitizeToolErrorMessage(
        'failed at /home/dev/open-pencil/packages/core/src/design-jsx/render.ts: boom',
        'render'
      )
    ).toBe('failed at [internal path]: boom')
    expect(
      sanitizeToolErrorMessage(
        'failed at D:\\Desktop\\open-pencil\\packages\\core\\src\\tools.ts: boom',
        'render'
      )
    ).toBe('failed at [internal path]: boom')
  })

  test('非内部路径（普通绝对路径）不误伤', () => {
    expect(sanitizeToolErrorMessage('cannot read /tmp/export.png', 'export')).toBe(
      'cannot read /tmp/export.png'
    )
  })
})

describe('render JSX 解析错误文案（core design-jsx/render.ts）', () => {
  test('owner 实证案例：字面 </jsx> → 坐标映射回 jsx 入参（行 1）+ 可操作指引', () => {
    let message = ''
    try {
      buildComponent(OWNER_CASE_JSX)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Invalid JSX')
    expect(message).toContain('line 1')
    // 旧文案的误导坐标（包装源码行号 29）不得再出现
    expect(message).not.toContain('(29:')
    expect(message).toContain('</jsx>')
    expect(message).toContain('valid JSX')
  })

  test('多行输入的语法错误 → 行号映射回用户坐标', () => {
    let message = ''
    try {
      buildComponent('<Frame>\n  <Text text="hi" />\n</Frame></jsx>')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Invalid JSX')
    expect(message).toContain('line 3')
  })
})

describe('桥 /rpc 状态码缝（server.ts 集成钉扎）', () => {
  const TEST_AUTH_TOKEN = 'test-t98-token'
  let handle: Awaited<ReturnType<typeof startServer>> | null = null

  afterEach(async () => {
    if (handle) await handle.close()
    handle = null
  })

  test('浏览器显式应答 ok:false（工具抛错）→ HTTP 200 {ok:false,error}，而非 502', async () => {
    handle = await startServer({
      httpPort: 0,
      withTcp: true,
      socketPath: null,
      authToken: TEST_AUTH_TOKEN
    })
    const port = handle.httpPort
    if (!port) throw new Error('withTcp: true did not produce an HTTP port')

    // 假浏览器：WS 注册后经 /health 确认桥已识别连接
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; id?: string }
      if (msg.type === 'request' && msg.id) {
        // 模拟编辑器在线但工具自身抛错（如 render JSX 解析失败）
        ws.send(
          JSON.stringify({
            type: 'response',
            id: msg.id,
            ok: false,
            error: 'Invalid JSX: Unexpected token at line 1 of the jsx input.'
          })
        )
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'register', token: TEST_AUTH_TOKEN }))
        resolve()
      }
      ws.onerror = () => reject(new Error('WebSocket connect failed'))
    })
    for (let i = 0; i < 50; i++) {
      const health = (await (
        await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}` }
        })
      ).json()) as { status: string }
      if (health.status === 'ok') break
      await new Promise((r) => {
        setTimeout(r, 20)
      })
    }

    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`
      },
      body: JSON.stringify({ command: 'tool', args: { name: 'render', args: {} } })
    })
    const body = (await response.json()) as { ok?: boolean; error?: string }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.error).toContain('Invalid JSX')
    // 全链路：该响应在 pi-backend 侧归类为工具错误（非编辑器离线）
    const failure = classifyBridgeFailure(response.status, body, 'render')
    expect(failure.kind).toBe('tool-error')

    ws.close()
  })

  test('无鉴权 → 401，pi-backend 侧归连接级', async () => {
    handle = await startServer({
      httpPort: 0,
      withTcp: true,
      socketPath: null,
      authToken: TEST_AUTH_TOKEN
    })
    const port = handle.httpPort
    if (!port) throw new Error('withTcp: true did not produce an HTTP port')

    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'tool', args: { name: 'render', args: {} } })
    })
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error?: string }
    expect(classifyBridgeFailure(response.status, body, 'render').kind).toBe('editor-unreachable')
  })
})
