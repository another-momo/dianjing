/**
 * 2026-09-22 owner 拍板：eval 移出 agent 可用工具面（滥用倾向过强）。
 * 落点 = createOpenPencilTools 装配面按 availability:'eval' 过滤；
 * ALL_TOOLS 必须保留 eval——active-design-host 桥探针经 tool-handlers 的
 * ALL_TOOLS.find 直调 core eval（宿主槽位探测），删出 ALL_TOOLS 会打断它。
 */

import { expect, test } from 'bun:test'

import { createOpenPencilTools } from '@/app/ai/pi-backend/tools'

import { ALL_TOOLS } from '#tests/helpers/tools'

test('eval 对 agent 隐藏：createOpenPencilTools 不含 eval', () => {
  const names = createOpenPencilTools().map((tool) => tool.name)
  expect(names).not.toContain('eval')
  // 其余 core 工具不受影响（抽查代表件）
  expect(names).toContain('render')
  expect(names).toContain('describe')
})

test('eval 对宿主保留：ALL_TOOLS 仍含 eval（桥探针经 ALL_TOOLS.find 直调）', () => {
  expect(ALL_TOOLS.some((tool) => tool.name === 'eval')).toBe(true)
})

test('mutating 桥工具串行化：暴露面 mutates 为真者 executionMode = sequential', () => {
  const tools = createOpenPencilTools()
  let mutatingCount = 0
  for (const tool of tools) {
    const def = ALL_TOOLS.find((candidate) => candidate.name === tool.name)
    expect(def).toBeDefined()
    if (!def!.mutates) continue
    mutatingCount++
    expect(tool.executionMode).toBe('sequential')
  }
  // 面内确有 mutating 工具（否则断言空转）
  expect(mutatingCount).toBeGreaterThan(0)
})

test('只读桥工具保持并行：mutates 为假者不带 executionMode', () => {
  const tools = createOpenPencilTools()
  // describe 是 mutation:'none' 的代表件（纯读，见 core describe/index.ts）
  const readonlyTool = tools.find((tool) => tool.name === 'describe')
  expect(readonlyTool).toBeDefined()
  expect(readonlyTool!.executionMode).toBeUndefined()
})
