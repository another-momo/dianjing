/**
 * 桥探针键面常量 + 子树遍历共享助手（state-layering wave-2 批 4 摘除半 + 批 5b）。
 *
 * 2026-09-27 §6.1 帧无身份模型 + §6.3 机制全表：set_active_design 工具退役、
 * 文档根单槽（activeDesignNodeId）连同读写函数一并删除——落点写通道 = 落点
 * 拦截门 + 规制确认门（前端确认端点直写 page-state 标量），agent 无改址工具；
 * 身份三元组（modeId / profileId / briefId）不再落帧——规制迁用户层 page-state，
 * brief 按页发现（装配取落点页 brief）。cross_page 校验随候选判定一并退役——
 * 绑定天然页局部，跨页场景不存在。
 *
 * 本模块保留：
 *  - ACTIVE_DESIGN_PROBE_KEYS：桥 eval 探针插值复用的键面常量——探针仍读
 *    brief 根 role 标记（按页扫描需求单）所需的最小键集
 *  - walkSubtree：子树遍历共享助手（jscpd 克隆治理，前端面板共用）
 */

import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import { BRIEF_PLUGIN_NAMESPACE, BRIEF_ROLE_KEY, BRIEF_ROLE_VALUE } from './brief'

// 供桥 eval 探针插值复用的键面常量（单一事实源，宿主模块 import 拼接）。
// 槽位键 / 设计身份三元组键 / newIntent 四键已随 §6.3 机制摘除整体退役——
// 探针只剩按页扫描需求单根（role 标记）这一个键面消费。
export const ACTIVE_DESIGN_PROBE_KEYS = {
  namespace: BRIEF_PLUGIN_NAMESPACE,
  roleKey: BRIEF_ROLE_KEY,
  roleBrief: BRIEF_ROLE_VALUE
} as const

// ── 子树遍历共享助手（jscpd 克隆治理：stack walk 习语单源）────────────────────

/** 深度优先走查 startIds 子树；visit 返回 true 提前终止整轮 */
export function walkSubtree(
  graph: SceneGraph,
  startIds: readonly string[],
  visit: (node: SceneNode) => boolean | undefined
): void {
  const stack = [...startIds]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) break
    const node = graph.getNode(id)
    if (!node) continue
    if (visit(node) === true) return
    stack.push(...node.childIds)
  }
}
