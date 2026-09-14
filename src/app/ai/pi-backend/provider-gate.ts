/**
 * pi-model-explicit-config（讨论稿 §3 落地清单 1）—— 引导门生态状态机。
 *
 * 输入 piDesignAssignment + piCatalog + auth.configured，派生四态：
 * - loading      catalog 还没拿到
 * - ready        指派有效且 provider 凭据已配
 * - needs-setup  无指派 / 指派 provider 不在目录 / 指派 model 不在目录
 * - needs-credential  指派有效但 provider 凭据缺失
 *
 * 抽离成纯函数、无 Vue 依赖、可单测：
 * - 形参是 plain object 而非 reactive ref——测试可桩，不读真实 storage（仓内 §6）
 * - 同形对象用别名复用（type-shapes 查重：复用 PiCatalog / PiCatalogProvider / PiDesignAssignment）
 * - 不读 fetch/storage/window——纯派生
 *
 * 落在 src/app/ai/pi-backend/provider-gate.ts，模块零运行时副作用。
 * ChatPanel 挂载链拉一次 catalog → 派生 → 渲染对应分支。
 */

import type { PiDesignAssignment } from './assignment'
import type { PiCatalog } from './catalog'

export type GateState =
  | { kind: 'loading' }
  | { kind: 'ready'; providerId: string; modelId: string }
  | { kind: 'needs-setup' }
  | {
      kind: 'needs-credential'
      providerId: string
      providerName: string
    }

/**
 * 派生引导门态。
 *
 * 判定顺序（短路语义）：
 *   1. catalog 未就绪 → loading（无论指派是否存在——避免凭 stale 指派给用户看 ready）
 *   2. 无指派 → needs-setup
 *   3. 指派 provider 不在目录 → needs-setup（指派已腐烂，回到起点）
 *   4. 指派 model 不在该 provider 目录 → needs-setup（同 3 腐烂语义）
 *   5. provider 凭据未配 → needs-credential（指派有效但用不了）
 *   6. 全部命中 → ready
 *
 * 「needs-credential」态附带 providerId / providerName——引导卡文案要点名 provider
 * （"openrouter 未配置 key，去设置补一下"），避免泛文案「请补凭据」。
 */
export function deriveGateState(args: {
  assignment: PiDesignAssignment | null | undefined
  catalog: PiCatalog | null | undefined
}): GateState {
  const { assignment, catalog } = args
  if (!catalog) return { kind: 'loading' }
  if (!assignment) return { kind: 'needs-setup' }
  const provider = catalog.providers.find((entry) => entry.id === assignment.providerId)
  if (!provider) return { kind: 'needs-setup' }
  const modelExists = provider.models.some((model) => model.id === assignment.modelId)
  if (!modelExists) return { kind: 'needs-setup' }
  if (!provider.auth.configured) {
    return {
      kind: 'needs-credential',
      providerId: provider.id,
      providerName: provider.name
    }
  }
  return { kind: 'ready', providerId: provider.id, modelId: assignment.modelId }
}
