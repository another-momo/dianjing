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

/** openrouter 目录里钉死的"free" 默选 id —— 与 SDK 内置 openrouter 目录一致（pi-ai providers/data/openrouter.json） */
export const OPENROUTER_FREE_MODEL_ID = 'openrouter/free'

/** openrouter provider id —— SDK 内置注册（pi-ai providers/all） */
export const OPENROUTER_PROVIDER_ID = 'openrouter'

/**
 * 展开 provider 时 Combobox 模型的初值。
 *
 * 规则（§4.2 段 c）：
 * - openrouter 钉 openrouter/free（不取目录首项 —— openrouter 目录=内建静态+远程
 *   缓存，free 不是字典序首项；2026-09-16 种子退役后 free 由内置目录供给）
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
 *
 * 2026-09-16 断链规则修：原版 `if (!existingAssignment) return false` 让无指派
 * 用户在设置面板双选 provider+model 永不写指派，唯一解锁路是「存 key 自动指派」
 * （PiModelsPanel saveKey 流）——env key / 已配 key 用户无第二条指派通道，
 * 只能改 provider+model 后再回去存一次 key。修后：双选即指派 = 引导门不依赖
 * 存 key 的解锁路；同 provider 同模型 false 防无变化写回。
 *
 * 2026-09-16（owner 拍板①）：异 provider false（防浏览劫持）的调用面退役——
 * 设计卡 provider 变更已改恒写指派（PiModelsPanel.onDesignProviderChange），
 * 劫持前提随行内 Combobox 删除而消（selectedProviderId 设计卡独占）。本分支
 * 仅服务 onDesignModelChange 的防御语义（卡面正常流程下已不可达）。
 */
export function shouldAutoAssignOnModelChange(args: {
  existingAssignment: PiDesignAssignment | null | undefined
  targetProviderId: string
  targetModelId: string
}): boolean {
  const { existingAssignment, targetProviderId, targetModelId } = args
  if (!existingAssignment) return true
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

/**
 * T100 A1：provider 列表过滤（name + id 大小写无关子串）—— 复用 filterCatalogModels
 * 的同款语义（讨论稿 §5.A1）；不在该函数内复用通用 helper 是因为 model/provider
 * 类型不同、引用点各自需要 PiCatalogProvider 字段，jscpd 看两个具名 export 更清晰。
 */
export function filterCatalogProviders(
  providers: readonly PiCatalogProvider[],
  term: string
): PiCatalogProvider[] {
  const query = term.trim().toLowerCase()
  if (!query) return [...providers]
  return providers.filter(
    (provider) =>
      provider.name.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query)
  )
}

/**
 * T100 A2+A3：按 configured 状态分组——
 *   configured=true → 「已配置」组（顺序按原数组）；
 *   configured=false → 「全部」组（顺序按原数组；"全部"语义=未配置的部分）。
 *
 * 返回结构便于模板循环两次（已配置优先、组内维持原顺序）。空组不会出现在结果
 * 里（v-for over groups 时空组自动隐去，不渲染小标题——避免 0 长小标题噪音）。
 *
 * 注：catalog.auth.source 是字符串自由值（SDK resolve.source），不参与分组。
 * "已配置"语义=auth.configured===true，按字面布尔分。
 */
export type PiProviderGroup = {
  id: 'configured' | 'all'
  providers: PiCatalogProvider[]
}

export function groupProvidersByConfigured(
  providers: readonly PiCatalogProvider[]
): PiProviderGroup[] {
  const configured: PiCatalogProvider[] = []
  const rest: PiCatalogProvider[] = []
  for (const provider of providers) {
    if (provider.auth.configured) configured.push(provider)
    else rest.push(provider)
  }
  const groups: PiProviderGroup[] = []
  if (configured.length > 0) groups.push({ id: 'configured', providers: configured })
  if (rest.length > 0) groups.push({ id: 'all', providers: rest })
  return groups
}

/**
 * T100 C1：是否为可删除的自定义 provider——看 catalog DTO 自带的 kind 字段（后端
 * getCatalog 拼装时按 SDK builtinProviders() 集合差集填：'builtin' vs 'custom'）。
 *
 * 注：判定依据在 catalog（不在前端另引 SDK node-only 模块——仓内 §5
 * "Window API 增强归编译边界" 同源问题，会把 node SDK 打进浏览器包）。
 * 后端 DELETE /providers/:id 仍会二次校验（双层防误删）。
 *
 * kind 字段缺失（老后端 / 旧 catalog 缓存）→ 保守视为内建：不显示删除入口，
 * 让用户走后端报错提示而非误删后兜底——错误现场更近。
 */
export function isCustomProvider(provider: Pick<PiCatalogProvider, 'kind'>): boolean {
  return provider.kind === 'custom'
}

/**
 * T100 B1：验证结果分类——区分 ok / 失败 / 缺数据。
 * ok=true → 验证成功；ok=false+error 字符串 → 失败（带后端返回的中文 error）；
 * 否则视为异常（无 error 文案）→ 落入「未知错误」回退文案分支。
 *
 * 不在 client.ts 内做——纯展示分类、含本地化降级策略，归属面板规则层。
 */
export type VerifyResultClass = 'ok' | 'failed' | 'unknown-error'

export function classifyVerifyResult(
  result: { ok: boolean; error?: string } | null
): VerifyResultClass {
  if (!result) return 'unknown-error'
  if (result.ok) return 'ok'
  if (typeof result.error === 'string' && result.error.length > 0) return 'failed'
  return 'unknown-error'
}

/**
 * T100 D1 补钉：auth.source 归类——SDK 实际返回值（pi-ai auth/helpers.js）：
 *   stored key 命中 → 'stored credential'；env 命中 → 环境变量名本身
 *   （如 'OPENROUTER_API_KEY'）；bedrock 等另有 'environment variable' 字面。
 * 归类口径：'stored credential' → 'stored'；'environment variable' 或环境变量
 * 形态（全大写下划线数字）→ 'environment'；空值 / 未知形态（oauth 来源串等）
 * → null（保守不渲染标签，同 catalog.kind 缺失的让位语义）。
 *
 * 单3 原稿按字面 'stored'/'environment' 匹配——与 SDK 真实值不符，标签永不
 * 渲染（L3 实测浮出）；真实值钉在本函数与测试中。
 */
export type PiAuthSourceClass = 'stored' | 'environment'

export function classifyAuthSource(source: string | undefined): PiAuthSourceClass | null {
  if (!source) return null
  if (source === 'stored credential') return 'stored'
  if (source === 'environment variable' || /^[A-Z][A-Z0-9_]+$/.test(source)) return 'environment'
  return null
}

/**
 * 设计模型卡（合并面板顶部）的初始选中 provider —— 优先级：
 *   1. 当前指派 provider（已有指派 → 一致性优先）
 *   2. 第一个已配置 provider（让无指派用户能直接落 key + 用模型）
 *   3. catalog 第一个 provider（兜底；无指派无配置时的引导位）
 *   4. 空串（catalog 为空时）
 *
 * 注：返回的可能是 catalog 不存在的 providerId（如指派的 provider 已被
 * 主人从 models.json 删掉），调用方需要在 combobox model-value 显式回退
 * 到 catalog 中真实存在的 provider id，避免 reka-ui 报未知值。
 */
export function resolveInitialSelectedProvider(args: {
  assignmentProviderId: string | null | undefined
  providers: readonly PiCatalogProvider[]
}): string {
  const { assignmentProviderId, providers } = args
  if (assignmentProviderId) return assignmentProviderId
  const firstConfigured = providers.find((p) => p.auth.configured)
  if (firstConfigured) return firstConfigured.id
  return providers[0]?.id ?? ''
}
