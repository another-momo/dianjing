/* oxlint-disable open-pencil/no-module-mocking -- pi SDK 模块级桩（无 DI 缝），同 service-capabilities 先例 */
/**
 * 2026-09-27 sl-w2-state-chain：confirmNewIntent 新写径钉扎——probe 拿 docUuid
 * → 直写 page-state 标量（确认即物化，§4）。旧 intent-confirm.test.ts 测的是
 * 被删的桥写四键通路，随摘除删除；本文件补新写径（推送前独立 review P2：
 * 该通路曾零测试，dangling 类型导入 + 探针查询形断裂两道伤口都靠 review 捞出）。
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// mock pi SDK 同 service-capabilities.test：只桩 createAgentSession +
// DefaultResourceLoader，其余走真实现（capabilities.ts 依赖真 loadSkillsFromDir）
mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: async () => ({
    session: {
      prompt: () => Promise.resolve(),
      subscribe: () => () => undefined,
      getActiveToolNames: () => [],
      abort: () => Promise.resolve(),
      sessionManager: { getSessionFile: () => null }
    }
  }),
  DefaultResourceLoader: class {
    async reload(): Promise<void> {
      // eslint-disable-next-line no-promise-executor-return -- 同步桩返回
      return Promise.resolve() as Promise<void>
    }
  },
  SessionManager: {
    create: () => ({ getSessionFile: () => null }),
    open: () => ({ getSessionFile: () => null })
  },
  defineTool: (def: unknown) => def,
  // T91c 修复：mock.module 是 process 级（bun:test 语义），
  // 同批跑的 marketing/ask-user-question-roundtrip.test.ts 用 readPiHistoryFile
  // 依赖真 parseSessionEntries；stub 成 () => [] 会让 roundtrip 测试拿到空历史。
  parseSessionEntries: (content: string): unknown[] => {
    const entries: unknown[] = []
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
        // oxlint-disable-next-line open-pencil/no-silent-catch -- 容错 skip 是 SDK 真语义：malformed 行静默跳过，非错误吞没
      } catch {
        // skip malformed
      }
    }
    return entries
  }
}))

import type { ActiveDesignBridgeIO } from '@/app/ai/pi-backend/active-design-host'
import { createPageStateStore } from '@/app/ai/pi-backend/page-state'
import { resolvePageStateDir } from '@/app/ai/pi-backend/paths'
import { createPiChatService } from '@/app/ai/pi-backend/service'

function makeService(rootDir: string, bridge?: ActiveDesignBridgeIO) {
  return createPiChatService({
    rootDir,
    admin: { resolveModel: async () => ({ modelRuntime: null, model: null }) } as never,
    imageGenCredentials: {} as never,
    imageGenSettings: {} as never,
    mcpConnections: { list: () => [], get: () => null } as never,
    ...(bridge ? { activeDesignBridge: bridge } : {})
  })
}

function stubBridge(
  probe: { currentPageId: string; docUuid: string } | null
): ActiveDesignBridgeIO {
  return {
    probeSlot: () => Promise.resolve(probe),
    probeBrief: () => Promise.resolve(null)
  }
}

describe('confirmNewIntent（确认即物化 = probe 拿 docUuid → 直写 page-state）', () => {
  let rootDir = ''

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'pi-svc-intent-'))
    mkdirSync(join(rootDir, 'pi-agent'), { recursive: true })
  })

  test('探针拿到 docUuid → page-state 落盘标量（落点字段不动）+ 回显确认参数', async () => {
    const svc = makeService(rootDir, stubBridge({ currentPageId: '0:1', docUuid: 'uuid-1' }))

    const result = await svc.confirmNewIntent({ modeId: 'longform', profileId: 'p1' })
    expect(result).toEqual({ ok: true, modeId: 'longform', profileId: 'p1' })

    const readBack = createPageStateStore({ pageStateDir: resolvePageStateDir(rootDir) }).read(
      'uuid-1'
    )
    expect(readBack).toEqual({ modeId: 'longform', profileId: 'p1', engagedPageId: null })
  })

  test('profileId 缺省 → 落盘 null（解绑语义）', async () => {
    const svc = makeService(rootDir, stubBridge({ currentPageId: '0:1', docUuid: 'uuid-2' }))

    const result = await svc.confirmNewIntent({ modeId: 'general' })
    expect(result).toEqual({ ok: true, modeId: 'general', profileId: '' })

    const readBack = createPageStateStore({ pageStateDir: resolvePageStateDir(rootDir) }).read(
      'uuid-2'
    )
    expect(readBack).toEqual({ modeId: 'general', profileId: null, engagedPageId: null })
  })

  test('docUuid 空串（首跑未铸 / 探针读不到）→ bridge_unavailable，不落盘', async () => {
    const svc = makeService(rootDir, stubBridge({ currentPageId: '0:1', docUuid: '' }))

    const result = await svc.confirmNewIntent({ modeId: 'general' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('bridge_unavailable')
  })

  test('桥不可达（probe null）→ bridge_unavailable', async () => {
    const svc = makeService(rootDir, stubBridge(null))

    const result = await svc.confirmNewIntent({ modeId: 'general' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('bridge_unavailable')
  })

  test('agentSkills 关闭 → invalid_args（能力面开关前置）', async () => {
    const svc = makeService(rootDir, stubBridge({ currentPageId: '0:1', docUuid: 'uuid-3' }))
    svc.setCapabilities({ agentSkills: false })

    const result = await svc.confirmNewIntent({ modeId: 'general' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('invalid_args')
  })
})
