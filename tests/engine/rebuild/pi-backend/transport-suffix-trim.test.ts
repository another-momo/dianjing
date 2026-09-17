/**
 * 2026-09-15：transport 后缀裁剪（trimToLastUserSuffix）+ sendMessages POST body 验证。
 *
 * 背景：旧行为 = messages 数组原样 POST；多模态场景每回合全量上报（base64 图
 * 内联）易撞后端 4MB 上限 → 旧 readBody 实现 req.destroy 写在 413 之前，前端
 * 呈不透明 ECONNRESET 502。新行为 = 末条 user 后缀裁剪保留末条 user 及其后全部
 * 消息（regenerate 末条可能是 assistant，后端 reverse-find 末条 user 语义已覆盖）。
 *
 * 钉扎三案：
 *  - 普通对话：裁剪掉所有早于末条 user 的消息
 *  - 含图：末条 user 带图片 parts 必须完整保留（不要剥 base64），前置 user 整体剔除
 *  - regenerate：末条是 assistant（regenerate 重生成场景），裁剪点固定为「末条 user 索引」，
 *    末条 assistant 及其后所有消息都保留
 */
import { describe, expect, test } from 'bun:test'

import type { UIMessage } from 'ai'

import { PiBackendChatTransport, trimToLastUserSuffix } from '@/app/ai/pi-backend/transport'

import { stubFetch, type FetchCall } from './helpers'

function makeTransport(): PiBackendChatTransport {
  return new PiBackendChatTransport(
    async () => ({ sessionId: 'sess-suffix', documentId: undefined }) as never
  )
}

/** 取 POST /api/pi-chat（非 cancel）的 body */
function chatBody(calls: FetchCall[]): { messages: UIMessage[]; sessionId: string } {
  const chat = calls.find((c) => !c.url.endsWith('/cancel'))
  if (!chat) throw new Error('no chat call recorded')
  return chat.body as { messages: UIMessage[]; sessionId: string }
}

describe('trimToLastUserSuffix 纯函数', () => {
  test('空数组 → 空数组', () => {
    expect(trimToLastUserSuffix([])).toEqual([])
  })

  test('无 user 消息 → 原样返回（兜底，行为等于原数组）', () => {
    const messages: UIMessage[] = [
      { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
      { id: 'b', role: 'system', parts: [{ type: 'text', text: 'sys' }] }
    ]
    expect(trimToLastUserSuffix(messages)).toBe(messages)
  })

  test('末条 user → 仅保留该条', () => {
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'last' }] }
    ]
    const trimmed = trimToLastUserSuffix(messages)
    expect(trimmed).toHaveLength(1)
    expect(trimmed[0].id).toBe('u2')
  })

  test('regenerate 末条是 assistant → 保留末条 user 起后缀（assistant + 之后全留）', () => {
    const messages: UIMessage[] = [
      { id: 'old', role: 'user', parts: [{ type: 'text', text: 'old' }] },
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'prompt' }] },
      { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'regenerated answer' }] }
    ]
    const trimmed = trimToLastUserSuffix(messages)
    expect(trimmed.map((m) => m.id)).toEqual(['u', 'a'])
  })
})

describe('sendMessages 后缀裁剪', () => {
  test('普通对话：保留末条 user 起后缀，剔除前置 user/assistant 对', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const transport = makeTransport()
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first question' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'first answer' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second question' }] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'second answer' }] },
      { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'final question' }] }
    ]
    await transport.sendMessages({ messages, abortSignal: undefined } as never)
    const body = chatBody(calls)
    expect(body.messages.map((m) => m.id)).toEqual(['u3'])
    expect(body.sessionId).toBe('sess-suffix')
  })

  test('含图：末条 user 带图片 parts 完整保留，前置 user 整体剔除', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const transport = makeTransport()
    const imageDataURL = 'data:image/png;base64,iVBORw0KGgo='
    const messages: UIMessage[] = [
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', text: '看这张' },
          { type: 'file', mediaType: 'image/png', url: imageDataURL }
        ]
      },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '看到了' }] },
      {
        id: 'u2',
        role: 'user',
        parts: [
          { type: 'text', text: '再看看' },
          { type: 'file', mediaType: 'image/jpeg', url: 'data:image/jpeg;base64,/9j/abc' }
        ]
      }
    ]
    await transport.sendMessages({ messages, abortSignal: undefined } as never)
    const body = chatBody(calls)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].id).toBe('u2')
    // 末条 user 的图片 part 完整保留（不要剥 base64，不要误裁剪）
    const u2 = body.messages[0]
    expect(u2.parts).toHaveLength(2)
    expect(u2.parts[0]).toEqual({ type: 'text', text: '再看看' })
    expect(u2.parts[1]).toEqual({
      type: 'file',
      mediaType: 'image/jpeg',
      url: 'data:image/jpeg;base64,/9j/abc'
    })
  })

  test('regenerate：末条是 assistant，POST body 含末条 user + 末条 assistant，剔除再之前', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const transport = makeTransport()
    const messages: UIMessage[] = [
      { id: 'u_old', role: 'user', parts: [{ type: 'text', text: 'old prompt' }] },
      { id: 'a_old', role: 'assistant', parts: [{ type: 'text', text: 'old answer' }] },
      { id: 'u_prompt', role: 'user', parts: [{ type: 'text', text: 'regenerate prompt' }] },
      {
        id: 'a_regen',
        role: 'assistant',
        parts: [{ type: 'text', text: 'regenerated answer' }]
      }
    ]
    await transport.sendMessages({ messages, abortSignal: undefined } as never)
    const body = chatBody(calls)
    // 末条 user（u_prompt）到末尾（含 a_regen）整体保留；u_old/a_old 剔除
    expect(body.messages.map((m) => m.id)).toEqual(['u_prompt', 'a_regen'])
    expect(body.messages[1].parts[0]).toEqual({ type: 'text', text: 'regenerated answer' })
  })

  test('只有 1 条 user 消息 → 不剔除，body 仍含原 messages', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const transport = makeTransport()
    const messages: UIMessage[] = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'only one' }] }
    ]
    await transport.sendMessages({ messages, abortSignal: undefined } as never)
    const body = chatBody(calls)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].id).toBe('u')
  })

  test('无 user 消息（只有 assistant/system）→ POST body 等于原数组', async () => {
    const calls: FetchCall[] = []
    stubFetch(calls)
    const transport = makeTransport()
    const messages: UIMessage[] = [
      { id: 's', role: 'system', parts: [{ type: 'text', text: 'sys' }] },
      { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'a' }] }
    ]
    await transport.sendMessages({ messages, abortSignal: undefined } as never)
    const body = chatBody(calls)
    expect(body.messages).toHaveLength(2)
  })
})
