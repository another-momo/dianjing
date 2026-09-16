/**
 * mapping.ts 静默错误修钉扎（2026-09-16）。
 *
 * 背景：终端模型错误（401 死 key / 流创建即抛类）在 SDK 内部走
 * pi-agent-core handleRunFailure——只发 message_start/message_end 持久化
 * （错误进会话 JSONL）+ turn_end + agent_end，**不发 message_update/error**。
 * 旧映射只认 message_update 的 error 子事件 → 前端静默空回复
 * （2026-09-15 L3 实证：openrouter 死 key 全模型无错误面）。
 *
 * 修复：终态 agent_end（willRetry=false）携带的末条 assistant 若是错误尸体
 * （stopReason 'error'）→ 补 error chunk + finish(error)，与 service.ts
 * catch 路径同形状。willRetry=true 的中途 agent_end 静默（重试序列不应
 * 打扰用户）；aborted 不算错误（用户主动停）。
 *
 * 纯函数测试：合成事件直喂 createPiEventMapper，无需 SDK 桩件。
 * 合成消息只构造映射消费的最小字段（role/stopReason/errorMessage），
 * 仓内测试惯例 `as` 投型（service-abort.test.ts 的 as never 先例）。
 */
import { describe, expect, test } from 'bun:test'

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { UIMessageChunk } from 'ai'

import { createPiEventMapper } from '@/app/ai/pi-backend/mapping'

interface FakeAssistant {
  role: 'assistant'
  stopReason: string
  errorMessage?: string
}

function agentEnd(messages: FakeAssistant[], willRetry: boolean): AgentSessionEvent {
  return { type: 'agent_end', messages, willRetry } as AgentSessionEvent
}

function errorAssistant(errorMessage?: string): FakeAssistant {
  return { role: 'assistant', stopReason: 'error', errorMessage }
}

function normalAssistant(): FakeAssistant {
  return { role: 'assistant', stopReason: 'stop' }
}

function types(chunks: UIMessageChunk[]): string[] {
  return chunks.map((c) => c.type)
}

describe('mapping agent_end 终态错误透传（2026-09-16 静默错误修）', () => {
  test('终态 agent_end 末条 assistant 是错误尸体 → error chunk + finish(error)', () => {
    const mapper = createPiEventMapper('m1')
    const chunks = mapper(agentEnd([errorAssistant('401 Unauthorized')], false))
    expect(types(chunks)).toEqual(['start', 'error', 'finish'])
    const errorChunk = chunks.find((c) => c.type === 'error')
    expect(errorChunk && 'errorText' in errorChunk ? errorChunk.errorText : null).toBe(
      '401 Unauthorized'
    )
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish && 'finishReason' in finish ? finish.finishReason : null).toBe('error')
  })

  test('errorMessage 缺失 → 兜底文案', () => {
    const mapper = createPiEventMapper('m2')
    const chunks = mapper(agentEnd([errorAssistant()], false))
    const errorChunk = chunks.find((c) => c.type === 'error')
    expect(errorChunk && 'errorText' in errorChunk ? errorChunk.errorText : null).toBe(
      'model error (unknown)'
    )
  })

  test('正常 stop 回合 → finish(stop)，无 error chunk（回归）', () => {
    const mapper = createPiEventMapper('m3')
    const chunks = mapper(agentEnd([normalAssistant()], false))
    expect(types(chunks)).toEqual(['start', 'finish'])
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish && 'finishReason' in finish ? finish.finishReason : null).toBe('stop')
  })

  test('willRetry=true 中途 agent_end（错误尸体在列）→ 静默不发 error/finish', () => {
    const mapper = createPiEventMapper('m4')
    const chunks = mapper(agentEnd([errorAssistant('429 rate limit')], true))
    expect(types(chunks)).toEqual(['start'])
  })

  test('重试成功后终态（消息列 = [错误尸体, 正常 stop]）→ finish(stop) 不误伤', () => {
    const mapper = createPiEventMapper('m5')
    const chunks = mapper(agentEnd([errorAssistant('429'), normalAssistant()], false))
    expect(types(chunks)).toEqual(['start', 'finish'])
  })

  test('aborted 尸体 → finish(stop) 无 error chunk（用户主动停非错误）', () => {
    const mapper = createPiEventMapper('m6')
    const aborted: FakeAssistant = { role: 'assistant', stopReason: 'aborted' }
    const chunks = mapper(agentEnd([aborted], false))
    expect(types(chunks)).toEqual(['start', 'finish'])
    const finish = chunks.find((c) => c.type === 'finish')
    expect(finish && 'finishReason' in finish ? finish.finishReason : null).toBe('stop')
  })

  test('先 text_delta 后错误终态 → text-end 先于 error chunk（帧闭合序）', () => {
    const mapper = createPiEventMapper('m7')
    mapper({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '半截' }
    } as AgentSessionEvent)
    const chunks = mapper(agentEnd([errorAssistant('stream died')], false))
    expect(types(chunks)).toEqual(['text-end', 'error', 'finish'])
  })
})
