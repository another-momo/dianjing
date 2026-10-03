/* oxlint-disable open-pencil/no-module-mocking -- pi SDK 模块级桩（无 DI 缝）；session-rebuild.test.ts 同款共存形态 */
/**
 * workflow 级工具面收放 × 会话基线快照——跨会话重建行为钉扎。
 *
 * 行为锚点（active-design-host.ts resolveActiveToolNames 头注）：活动集合成
 * 的输入基线 = 会话创建时的初始活动集（service.createSession 落在
 * SessionEntry.baseToolNames，此后不随注册表刷新），输出保持基线顺序只按
 * 条件集过滤——只摘不加。由此钉出三个跨会话行为：
 *  1. 会话创建后，workflow 条件工具名集合变更（新增一个条件工具名）不改变
 *     当前会话的活动集——过滤语义只摘不加，基线外的名字进不来
 *  2. 重建会话（驱逐重建）后，基线按创建时刻重新快照——新增的条件工具名
 *     进入活动集
 *  3. 白名单移除某工具名（仍被另一 workflow 点名、保持条件性）→ 重建会话
 *     → 在移除它的 workflow 回合该工具退出活动集；切回仍点名的 workflow
 *     回合则回归——移除≠封禁，条件性每回合从注册表现算
 *
 * 新增条件工具名取 `set_opacity`：注册表 AI 可见集内的真实工具（存在性闸
 * 放行），但不在装配面白名单——正是「点名过了闸、名字不在创建时基线内」
 * 的生产形态。装配面本体（SDK 会话注册的工具集）是环境边界，用可编程替身
 * 模拟其扩容；registry / 存在性闸 / resolveActiveToolNames / 驱逐重建 /
 * syncTurnTools 全部走真实产线代码。
 *
 * 夹具（session-rebuild.test.ts 同款）：mock.module 桩 SDK 会话；studio
 * fixture 资产落 temp rootDir 的内置子路径（真实 loadStudioFromDirs + 闸）；
 * 桥 IO 走 service 的 activeDesignBridge 测试注入缝；page-state 直写 store
 * 驱动 modeId；驱逐重建用指派 spec 翻转触发。
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILTIN_STUDIO_SUBPATH } from '@/app/ai/pi-backend/paths'
import type { ModelSpec } from '@/app/ai/pi-backend/provider-admin'
import { createPiChatService } from '@/app/ai/pi-backend/service'
import { reloadStudio } from '@/app/ai/pi-backend/studio'

const disposeSpy = mock(() => undefined)
/** 每次 createAgentSession 时刻的装配面快照（可编程替身——面扩容模拟） */
const createdFaces: string[][] = []
/** 每次 setActiveToolsByName 的入参清单（verbatim 记录，不裁剪——活动集归因留给真实 resolve 逻辑） */
const switchCalls: string[][] = []
let nextFace: string[] = []

mock.module('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: () => {
    const face = [...nextFace]
    createdFaces.push(face)
    let active = [...face]
    return Promise.resolve({
      session: {
        prompt: () => Promise.resolve(),
        subscribe: () => () => undefined,
        getActiveToolNames: () => [...active],
        setActiveToolsByName: (toolNames: string[]) => {
          active = [...toolNames]
          switchCalls.push([...toolNames])
        },
        abort: () => Promise.resolve(),
        dispose: () => disposeSpy(),
        sessionManager: { getSessionFile: () => null }
      }
    })
  },
  DefaultResourceLoader: class {
    reload(): Promise<void> {
      return Promise.resolve()
    }
  },
  SessionManager: {
    create: () => ({ getSessionFile: () => null }),
    open: () => ({ getSessionFile: () => null })
  },
  defineTool: (def: unknown) => def,
  // service-abort.test.ts 同款细心直通：process 级 mock 不得让同批
  // readPiHistoryFile 消费者拿到空历史
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

// 装配面替身快照：V1 缺 set_opacity（点名过了闸、名字不在基线内的前提）；
// V2 扩容加入 set_opacity（重建会话时按新面快照）
const FACE_V1 = ['render', 'compose_backdrop', 'prepare_hero_scaffold']
const FACE_V2 = [...FACE_V1, 'set_opacity']

const SPEC_A: ModelSpec = { providerId: 'minimax-cn', modelId: 'MiniMax-M2.7' }
const SPEC_B: ModelSpec = { providerId: 'minimax-cn', modelId: 'MiniMax-M3' }

const BASE_MD = `---
id: base
label: 工作守则
---

## 红线

事实零虚构。
`

function workflowMd(id: string, label: string, toolsLine: string): string {
  return `---
id: ${id}
label: ${label}
${toolsLine}
---

## 阶段定义

阶段 0-4。
`
}

/** registry v1：alpha 点名 compose_backdrop，beta 点名 prepare_hero_scaffold */
function writeRegistryV1(rootDir: string): void {
  put(
    rootDir,
    'workflows/alpha/workflow.md',
    workflowMd('alpha', '方案甲', 'tools: [compose_backdrop]')
  )
  put(
    rootDir,
    'workflows/beta/workflow.md',
    workflowMd('beta', '方案乙', 'tools: [prepare_hero_scaffold]')
  )
}

/** registry v2：alpha 白名单新增 set_opacity（过闸、不在创建时基线内的真实工具名） */
function writeRegistryV2(rootDir: string): void {
  put(
    rootDir,
    'workflows/alpha/workflow.md',
    workflowMd('alpha', '方案甲', 'tools: [compose_backdrop, set_opacity]')
  )
}

/** registry v3：alpha 移除 compose_backdrop；beta 改点名 compose_backdrop（件保持条件性） */
function writeRegistryV3(rootDir: string): void {
  put(rootDir, 'workflows/alpha/workflow.md', workflowMd('alpha', '方案甲', 'tools: [set_opacity]'))
  put(
    rootDir,
    'workflows/beta/workflow.md',
    workflowMd('beta', '方案乙', 'tools: [compose_backdrop]')
  )
}

function put(rootDir: string, rel: string, content: string): void {
  const abs = join(rootDir, BUILTIN_STUDIO_SUBPATH, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function makeService(rootDir: string) {
  return createPiChatService({
    rootDir,
    admin: {
      resolveModel: () => Promise.resolve({ modelRuntime: null, model: null })
    } as never,
    imageGenCredentials: {} as never,
    imageGenSettings: {} as never,
    mcpConnections: { list: () => [], get: () => null } as never,
    // 测试注入缝：桥 IO 替身（probeSlot 恒返同一 docUuid，page-state 据此驱动 modeId）
    activeDesignBridge: {
      probeSlot: async () => ({ currentPageId: 'page-1', docUuid: 'doc-1' }),
      probeBrief: async () => []
    }
  })
}

describe('workflow 工具面收放 × 会话基线快照（跨会话重建）', () => {
  beforeEach(() => {
    disposeSpy.mockReset()
    createdFaces.length = 0
    switchCalls.length = 0
    nextFace = FACE_V1
  })

  test('新增条件工具名不进当前会话；重建会话后进场；白名单移除→重建→离场', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'pi-workflow-tools-session-'))
    try {
      writeRegistryV1(rootDir)
      const service = makeService(rootDir)
      const pageState = service.getPageStateStore()
      pageState.write('doc-1', { modeId: 'alpha' })
      const send = (spec: ModelSpec): Promise<void> =>
        service.prompt('sess-tools', '做图', () => undefined, { model: spec })

      // ① 创建会话（装配面 V1 基线）+ alpha 回合：beta 点名的条件工具离场
      await send(SPEC_A)
      expect(createdFaces).toEqual([FACE_V1])
      expect(switchCalls).toEqual([['render', 'compose_backdrop']])

      // ② registry 新增条件工具名 set_opacity（过存在性闸、不在创建时基线内）
      //    → 当前会话活动集不变：无驱逐、无新切换、活动集无 set_opacity
      writeRegistryV2(rootDir)
      reloadStudio(rootDir)
      await send(SPEC_A)
      expect(createdFaces.length).toBe(1)
      expect(disposeSpy).toHaveBeenCalledTimes(0)
      expect(switchCalls.length).toBe(1)
      expect(switchCalls[0]).not.toContain('set_opacity')

      // ③ 装配面扩容（V2）→ 指派翻转驱逐重建 → 新会话按创建时刻快照新基线，
      //    alpha 回合 set_opacity 进入活动集
      nextFace = FACE_V2
      await send(SPEC_B)
      expect(createdFaces).toEqual([FACE_V1, FACE_V2])
      expect(disposeSpy).toHaveBeenCalledTimes(1)
      expect(switchCalls.length).toBe(2)
      expect(switchCalls[1]).toEqual(['render', 'compose_backdrop', 'set_opacity'])

      // ④ 白名单移除（alpha 摘除 compose_backdrop，beta 仍点名保持条件性）
      //    → 再驱逐重建 → alpha 回合该工具退出活动集（prepare_hero_scaffold
      //    已无人点名、回归常驻面保留）
      writeRegistryV3(rootDir)
      reloadStudio(rootDir)
      await send(SPEC_A)
      expect(createdFaces.length).toBe(3)
      expect(disposeSpy).toHaveBeenCalledTimes(2)
      expect(switchCalls.length).toBe(3)
      expect(switchCalls[2]).toEqual(['render', 'prepare_hero_scaffold', 'set_opacity'])
      expect(switchCalls[2]).not.toContain('compose_backdrop')

      // ⑤ 同会话切 beta 回合：compose_backdrop 被beta 点名 → 回归活动集
      //    （移除≠封禁——条件性每回合从注册表现算，下一回合生效，无需重建）
      pageState.write('doc-1', { modeId: 'beta' })
      await send(SPEC_A)
      expect(createdFaces.length).toBe(3)
      expect(disposeSpy).toHaveBeenCalledTimes(2)
      expect(switchCalls.length).toBe(4)
      expect(switchCalls[3]).toEqual(['render', 'compose_backdrop', 'prepare_hero_scaffold'])
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
