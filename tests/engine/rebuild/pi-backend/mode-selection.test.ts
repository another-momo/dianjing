/**
 * 2026-09-27 意图确认卡退役（发送即物化批）：mode-selection 单测。
 *
 * 覆盖：
 *  - piChipSelection 两档（未物化暂存 > page-state 回显）；
 *  - setPiChipSelection 与回显相同 = 清空暂存；
 *  - 发送即物化 materializePiPendingIntent（poster 注入桩，永不碰真实网络）：
 *      · 无武装 → 直通 ok 且不调 poster；
 *      · 武装 → poster 先于放行被调（载荷逐字段）→ 清暂存 + echo 乐观更新；
 *      · profileId null → 载荷不带 profileId 键；
 *      · poster 失败 → 不放量（返 ok:false）+ 暂存保留 + 回显不动；
 *  - echo 真源接线：syncPiChipEchoFromPageState 归一（modeId null → general
 *    缺省链兜底；state null → 缺省）；refreshPiChipEcho GET 成功刷新 /
 *    不可达保持现状（globalThis.fetch 桩，pending-decision.test.ts 先例）。
 *  - 物料暂存 piPendingMaterial：toggle / 覆盖 / 显式清 + buildPiMaterialPrefix
 *    序列化（zh 全角 / en 半角 / HUG 流高文案 / `\n\n` 隔行 / 未 armed 空串）。
 *
 * ChatPanel 接线面（toast + restoreDraft + return 不发送）属装配层，不在
 * 本文件覆盖（repo 测试纪律：装配缝配装配面）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { MaterialSpec } from '@open-pencil/core/tools/fork/marketing/material-specs'

import {
  PI_DEFAULT_MODE_ID,
  applyPiChipEcho,
  buildPiMaterialPrefix,
  clearPiPendingMaterial,
  clearPiPendingNewIntent,
  materializePiPendingIntent,
  piChipEcho,
  piChipSelection,
  piPendingMaterial,
  piPendingNewIntent,
  refreshPiChipEcho,
  setPiChipSelection,
  setPiPendingMaterial,
  syncPiChipEchoFromPageState,
  type PiIntentConfirmPoster
} from '@/app/ai/pi-backend/mode-selection'

/** 模块级 ref 跨用例共享——每例归位（暂存清空 + 回显回落缺省） */
beforeEach(() => {
  clearPiPendingNewIntent()
  clearPiPendingMaterial()
  applyPiChipEcho({ modeId: PI_DEFAULT_MODE_ID, profileId: null })
})

describe('piChipSelection 两档（暂存 > page-state 回显）', () => {
  test('无暂存 → 回落 page-state 回显', () => {
    applyPiChipEcho({ modeId: 'marketing', profileId: 'p-1' })
    expect(piChipSelection.value).toEqual({ modeId: 'marketing', profileId: 'p-1' })
  })

  test('有暂存 → 暂存优先于回显', () => {
    applyPiChipEcho({ modeId: 'marketing', profileId: null })
    setPiChipSelection({ modeId: 'general', profileId: 'p-9' })
    expect(piChipSelection.value).toEqual({ modeId: 'general', profileId: 'p-9' })
  })

  test('拨回与回显相同组合 → 暂存清空（无意图事件）', () => {
    applyPiChipEcho({ modeId: 'marketing', profileId: 'p-1' })
    setPiChipSelection({ modeId: 'general', profileId: null })
    expect(piPendingNewIntent.value).not.toBeNull()
    setPiChipSelection({ modeId: 'marketing', profileId: 'p-1' })
    expect(piPendingNewIntent.value).toBeNull()
  })
})

describe('materializePiPendingIntent（发送即物化）', () => {
  function recordingPoster(result: { ok: true } | { ok: false; message: string }): {
    poster: PiIntentConfirmPoster
    calls: Array<{ modeId: string; profileId?: string }>
  } {
    const calls: Array<{ modeId: string; profileId?: string }> = []
    const poster: PiIntentConfirmPoster = async (args) => {
      calls.push(args)
      return await Promise.resolve(result)
    }
    return { poster, calls }
  }

  test('无武装 → 直通 ok，不调 poster', async () => {
    const { poster, calls } = recordingPoster({ ok: true })
    const result = await materializePiPendingIntent(poster)
    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(0)
  })

  test('武装 → poster 载荷逐字段上送；成功清暂存 + echo 乐观更新', async () => {
    const { poster, calls } = recordingPoster({ ok: true })
    setPiChipSelection({ modeId: 'marketing', profileId: 'p-1' })
    const result = await materializePiPendingIntent(poster)
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ modeId: 'marketing', profileId: 'p-1' }])
    expect(piPendingNewIntent.value).toBeNull()
    expect(piChipEcho.value).toEqual({ modeId: 'marketing', profileId: 'p-1' })
    // 物化后 chips 显示 = 新回显（暂存已清）
    expect(piChipSelection.value).toEqual({ modeId: 'marketing', profileId: 'p-1' })
  })

  test('profileId null → 载荷不带 profileId 键', async () => {
    const { poster, calls } = recordingPoster({ ok: true })
    setPiChipSelection({ modeId: 'marketing', profileId: null })
    await materializePiPendingIntent(poster)
    expect(calls).toEqual([{ modeId: 'marketing' }])
    expect('profileId' in calls[0]).toBe(false)
  })

  test('poster 失败 → 不放量：暂存保留 + 回显不动（fail-closed 语义核）', async () => {
    const { poster } = recordingPoster({ ok: false, message: 'HTTP 500' })
    setPiChipSelection({ modeId: 'marketing', profileId: null })
    const result = await materializePiPendingIntent(poster)
    expect(result).toEqual({ ok: false, message: 'HTTP 500' })
    expect(piPendingNewIntent.value).toEqual({ modeId: 'marketing', profileId: null })
    expect(piChipEcho.value).toEqual({ modeId: PI_DEFAULT_MODE_ID, profileId: null })
  })
})

describe('syncPiChipEchoFromPageState（page-state → echo 归一）', () => {
  test('完整 state → 逐字段接管', () => {
    syncPiChipEchoFromPageState({ modeId: 'marketing', profileId: 'p-2', engagedPageId: 'pg' })
    expect(piChipEcho.value).toEqual({ modeId: 'marketing', profileId: 'p-2' })
  })

  test('modeId 显式清空（null）→ 缺省链 general 兜底', () => {
    applyPiChipEcho({ modeId: 'marketing', profileId: 'p-2' })
    syncPiChipEchoFromPageState({ modeId: null, profileId: null, engagedPageId: 'pg' })
    expect(piChipEcho.value).toEqual({ modeId: PI_DEFAULT_MODE_ID, profileId: null })
  })

  test('state null（文档无 page-state）→ 回落缺省（防跨文档串味）', () => {
    applyPiChipEcho({ modeId: 'marketing', profileId: 'p-2' })
    syncPiChipEchoFromPageState(null)
    expect(piChipEcho.value).toEqual({ modeId: PI_DEFAULT_MODE_ID, profileId: null })
  })
})

describe('refreshPiChipEcho（GET page-state → echo）', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function stubFetch(impl: () => Response | Promise<Response>): void {
    const fetchImpl = async () => await impl()
    globalThis.fetch = fetchImpl as typeof fetch
  }

  function jsonResponse(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
  }

  test('GET 成功 → echo 刷新为 page-state 规制标量', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        state: { modeId: 'marketing', profileId: 'p-3', engagedPageId: 'pg-1' },
        hasSession: true
      })
    )
    await refreshPiChipEcho('doc-uuid-1')
    expect(piChipEcho.value).toEqual({ modeId: 'marketing', profileId: 'p-3' })
  })

  test('GET 成功但 state null → echo 回落缺省', async () => {
    applyPiChipEcho({ modeId: 'marketing', profileId: null })
    stubFetch(() => jsonResponse(200, { state: null, hasSession: false }))
    await refreshPiChipEcho('doc-uuid-1')
    expect(piChipEcho.value).toEqual({ modeId: PI_DEFAULT_MODE_ID, profileId: null })
  })

  test('GET 不可达 → echo 保持现状（兜底缺省即旧行为，不进显式失败面）', async () => {
    applyPiChipEcho({ modeId: 'marketing', profileId: 'p-4' })
    stubFetch(() => jsonResponse(502, {}))
    await refreshPiChipEcho('doc-uuid-1')
    expect(piChipEcho.value).toEqual({ modeId: 'marketing', profileId: 'p-4' })
  })
})

describe('物料暂存 piPendingMaterial（toggle / 显式清 / buildPiMaterialPrefix）', () => {
  const storySpec: MaterialSpec = {
    id: 'story-9x16',
    label: '全屏竖屏',
    aliases: ['story'],
    width: 1080,
    height: 1920
  }
  const longImageSpec: MaterialSpec = {
    id: 'long-image',
    label: '长图',
    aliases: ['长图', 'long image'],
    width: 750,
    height: null
  }

  test('未武装 → buildPiMaterialPrefix 返回空串', () => {
    expect(piPendingMaterial.value).toBeNull()
    expect(
      buildPiMaterialPrefix({ prefix: 'Material: {label} ({width}x{height})', heightFlow: 'flow' })
    ).toBe('')
  })

  test('setPiPendingMaterial 武装 → piPendingMaterial 持有该 spec', () => {
    setPiPendingMaterial(storySpec)
    expect(piPendingMaterial.value).toEqual(storySpec)
  })

  test('setPiPendingMaterial 同 id 再点 = 清空（toggle 语义）', () => {
    setPiPendingMaterial(storySpec)
    expect(piPendingMaterial.value).not.toBeNull()
    setPiPendingMaterial(storySpec)
    expect(piPendingMaterial.value).toBeNull()
  })

  test('setPiPendingMaterial 不同 id 覆盖', () => {
    setPiPendingMaterial(storySpec)
    setPiPendingMaterial(longImageSpec)
    expect(piPendingMaterial.value?.id).toBe('long-image')
  })

  test('clearPiPendingMaterial 显式清空', () => {
    setPiPendingMaterial(storySpec)
    expect(piPendingMaterial.value).not.toBeNull()
    clearPiPendingMaterial()
    expect(piPendingMaterial.value).toBeNull()
  })

  test('buildPiMaterialPrefix 武装定高物料（zh 模板：全角括号、× 乘号）', () => {
    setPiPendingMaterial(storySpec)
    const prefix = buildPiMaterialPrefix({
      prefix: '物料：{label}（{width}×{height}）',
      heightFlow: '流高'
    })
    expect(prefix).toBe('物料：全屏竖屏（1080×1920）\n\n')
  })

  test('buildPiMaterialPrefix 武装 HUG 物料 → 高度走流高文案', () => {
    setPiPendingMaterial(longImageSpec)
    const prefix = buildPiMaterialPrefix({
      prefix: '物料：{label}（{width}×{height}）',
      heightFlow: '流高'
    })
    expect(prefix).toBe('物料：长图（750×流高）\n\n')
  })

  test('buildPiMaterialPrefix en 模板（半角括号、x 乘号）', () => {
    setPiPendingMaterial(storySpec)
    const prefix = buildPiMaterialPrefix({
      prefix: 'Material: {label} ({width}x{height})',
      heightFlow: 'flow'
    })
    expect(prefix).toBe('Material: 全屏竖屏 (1080x1920)\n\n')
  })

  test('buildPiMaterialPrefix 前缀含 \n\n 与消息正文隔行（agent 看到 hint + 正文）', () => {
    setPiPendingMaterial(storySpec)
    const prefix = buildPiMaterialPrefix({
      prefix: 'M: {label} ({width}x{height})',
      heightFlow: 'flow'
    })
    expect(prefix.endsWith('\n\n')).toBe(true)
  })

  test('文档切换：clearPiPendingMaterial 调用 → armed 清空（与意图暂存同口径）', () => {
    setPiPendingMaterial(storySpec)
    expect(piPendingMaterial.value).not.toBeNull()
    // ChatPanel handleDocSwitched 内调用 clearPiPendingMaterial
    clearPiPendingMaterial()
    expect(piPendingMaterial.value).toBeNull()
  })
})
