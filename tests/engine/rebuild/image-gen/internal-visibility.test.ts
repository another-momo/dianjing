/**
 * T72：内部流水线段可见性钉扎（docs/202609010000-tool-internal-visibility-review.md
 * 方案 A 落地）——image_gen_begin/commit 是 generate_image 编排器的桥端点，
 * place_image_from_bytes 是 load_image 编排器的桥端点（2026-09-18 本地图片
 * 工具链）：
 * ① agent 工具集（createOpenPencilTools）不透出（防 agent 直调绕过凭证检查/
 * 编排/批量/快照逻辑/路径裁决）；② MCP 注册面不透出（exposure.mcp=false；
 * fork 的 MCP 外壳已裁撤，语义保留）；③ ALL_TOOLS 保留（桥执行面
 * tool-handlers.ts 按名分发——编排器 RPC 必须仍可达）。
 * PR697 后标记形从 internal:true 迁到 exposure:{ai:false,mcp:false,...}，
 * 断言谓词同步改为 isToolExposed。
 */
import { describe, expect, test } from 'bun:test'

import { ALL_TOOLS, FORK_TOOLS, isToolExposed } from '@open-pencil/core/tools'

import { createOpenPencilTools } from '@/app/ai/pi-backend/tools'

const INTERNAL_NAMES = ['image_gen_begin', 'image_gen_commit', 'place_image_from_bytes']

describe('T72 内部工具可见性', () => {
  test('三工具在 FORK_TOOLS 带 exposure 关断标记（机器可读，非描述文本约定）', () => {
    const internals = FORK_TOOLS.filter((def) => !isToolExposed(def, 'ai')).map((def) => def.name)
    expect(internals.sort()).toEqual([...INTERNAL_NAMES].sort())
    for (const def of FORK_TOOLS.filter((d) => INTERNAL_NAMES.includes(d.name))) {
      expect(isToolExposed(def, 'mcp')).toBe(false)
      expect(isToolExposed(def, 'webmcp')).toBe(false)
    }
  })

  test('agent 工具集不透出 internal 段，其余 fork 工具不受影响', () => {
    const exposed = createOpenPencilTools().map((tool) => tool.name)
    for (const name of INTERNAL_NAMES) expect(exposed).not.toContain(name)
    // 同族非 internal 工具仍在（防过滤面误伤）
    expect(exposed).toContain('read_brief')
    expect(exposed).toContain('setup_design')
  })

  test('ALL_TOOLS 保留三工具（桥按名分发面不断——编排器 RPC 仍可达）', () => {
    const all = ALL_TOOLS.map((def) => def.name)
    for (const name of INTERNAL_NAMES) expect(all).toContain(name)
  })

  test('全仓 ai 关断工具清单 = 已知三件（新增 internal 工具须显式更新本钉扎）', () => {
    const internals = ALL_TOOLS.filter((def) => !isToolExposed(def, 'ai')).map((def) => def.name)
    expect(internals.sort()).toEqual([...INTERNAL_NAMES].sort())
  })
})
