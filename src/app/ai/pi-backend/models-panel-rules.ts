import type { PiDesignAssignment } from './assignment'
/**
 * T97 pi-models-panel 合并面板的纯逻辑规则（讨论稿 §4 合并形态）。
 *
 * 三块规则抽离成无副作用、无 Vue 依赖、可单测的纯函数：
 * 1. `resolveDefaultModelId` —— 展开 provider 时的 Combobox 初值（openrouter 钉 free，
 *    其他 provider 取首项）。**不落盘**，仅作表单初值；用户保存 key 才写指派（§4.3 约束 2）
 * 2. `isCurrentAssignment` —— provider 行"当前"check 派生（§4.3 约束 1 单指派语义）
 * 3. `shouldAutoAssignOnSaveKey` —— 保存 key 时是否同写指派的判定（§4.2 段 d）
 *
 * 抽离动机：原 PiModelsPanel.vue 把这些逻辑嵌在 reactive computed 里，难单测；
 * 改派生态必跑过的就是这几条规则（门禁 + L3 实证双层兜住）。
 *
 * 注意：assignment 形参是 plain object 而非 reactive ref —— 测试可桩，不读真实
 * useLocalStorage（仓内 §6 测试纪律）。
 */
import type { PiCatalogModel, PiCatalogProvider } from './catalog'
import type { PiThinkingLevel } from './client'

/** openrouter 目录里钉死的"free" 默选 id —— 与 provider-admin.ts 种子 models.json 一致 */
export const OPENROUTER_FREE_MODEL_ID = 'openrouter/free'

/** openrouter provider id —— 与 provider-admin.ts 种子 models.json 一致 */
export const OPENROUTER_PROVIDER_ID = 'openrouter'

/**
 * 展开 provider 时 Combobox 模型的初值。
 *
 * 规则（§4.2 段 c）：
 * - openrouter 钉 openrouter/free（不取目录首项 —— openrouter 目录=内建静态+远程
 *   缓存+种子 free，free 不是字典序首项）
 * - 其他 provider 取该 provider models 列表首项（沿用 selectDesignProvider 旧行为）
 * - 空目录 → 空串（Combobox 无初值，user 必选）
 */
export function resolveDefaultModelId(
  provider: Pick<PiCatalogProvider, 'id' | 'models'> | null | undefined
): string {
  if (!provider) return ''
  if (provider.id === OPENROUTER_PROVIDER_ID) {
    // 钉 openrouter/free；目录里若被删除（罕见，主人手编）回退首项兜底
    const freeEntry = provider.models.find((m) => m.id === OPENROUTER_FREE_MODEL_ID)
    if (freeEntry) return freeEntry.id
    return provider.models[0]?.id ?? ''
  }
  return provider.models[0]?.id ?? ''
}

/**
 * provider 行"当前"check 派生 —— §4.3 约束 1 单指派语义视觉显式
 * （列表里永远只有一行带"当前"，等价 radio）。
 *
 * null 指派（未配置）→ 全部不勾。
 */
export function isCurrentAssignment(
  providerId: string,
  assignment: PiDesignAssignment | null | undefined
): boolean {
  if (!assignment) return false
  return assignment.providerId === providerId
}

/**
 * 保存 key 时是否同写指派的判定（§4.2 段 d）。
 *
 * 规则：
 * - 无现存指派 → true（存 key 即指派，对任意 provider 字面成立）
 * - 已有指派但目标 provider 不是当前指派 provider → false（用户在该行存 key 不应
 *   抢占当前指派）
 * - 已有指派且目标 provider 就是当前指派 provider → 看新模型是否变化（同 provider
 *   内换模型走 §4.3 约束 3 自动写回语义，由 selectAssignmentOnModelChange 处理；
 *   本函数只判定"首次无指派时是否要写"，因此返回 false）
 *
 * 注：本函数不判定同 provider 内模型变化场景（那是自动写回，不是初次指派）。
 */
export function shouldAutoAssignOnSaveKey(args: {
  existingAssignment: PiDesignAssignment | null | undefined
  targetProviderId: string
}): boolean {
  if (!args.existingAssignment) return true
  // 已有指派：保存 key 不动指派（同 provider 内换模型走 §4.3 约束 3 单独路径）
  return false
}

/**
 * 同 provider 内换模型是否要自动写回指派（§4.3 约束 3）。
 * 显式 Combobox 动作 = 自动写回 + label 即时更新（可逆 = 再选）。
 */
export function shouldAutoAssignOnModelChange(args: {
  existingAssignment: PiDesignAssignment | null | undefined
  targetProviderId: string
  targetModelId: string
}): boolean {
  const { existingAssignment, targetProviderId, targetModelId } = args
  if (!existingAssignment) return false
  if (existingAssignment.providerId !== targetProviderId) return false
  // 同 provider 内：当前模型 → 目标模型 = 显式切换
  if (existingAssignment.modelId === targetModelId) return false
  return true
}

/**
 * 组装一条新的指派对象（剔除 thinkingLevel === 'off' 的可选字段，保持与 assignment.ts
 * 序列化约定一致）。
 */
export function buildAssignment(args: {
  providerId: string
  modelId: string
  thinkingLevel?: PiThinkingLevel
}): PiDesignAssignment | null {
  if (!args.providerId || !args.modelId) return null
  return {
    providerId: args.providerId,
    modelId: args.modelId,
    ...(args.thinkingLevel && args.thinkingLevel !== 'off'
      ? { thinkingLevel: args.thinkingLevel }
      : {})
  }
}

/**
 * 模型列表过滤（name + id 大小写无关子串）—— T80 原 PiModelsPanel.vue filterModels 抽离，
 * 不变语义，Vue 无关可单测。
 */
export function filterCatalogModels(
  models: readonly PiCatalogModel[],
  term: string
): PiCatalogModel[] {
  const query = term.trim().toLowerCase()
  if (!query) return [...models]
  return models.filter(
    (model) => model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query)
  )
}
