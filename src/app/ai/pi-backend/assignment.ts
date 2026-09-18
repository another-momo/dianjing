/**
 * T21 P2 pi 模式下的 design 模型指派（2026-09-16 后端化）。
 *
 * 指派真源 = 后端 .dianjing/pi-agent/design-assignment.json（GET/PUT
 * /api/pi/design-assignment）。前端模块只是缓存层：模块加载时 fire-and-
 * forget 拉一次填进 ref；set 同步更 ref + fire-and-forget PUT 落盘。
 *
 * 历史回填：旧版走浏览器 localStorage（key `openpencil.pi.design-model`），
 * 迁移期一次：fetch 端点返 null 且 localStorage 旧键有值 → PUT 旧值上端点 +
 * localStorage.removeItem 旧键（不再读）。失败 console.error 不回滚
 * （单写者无冲突面）。
 *
 * 设计取舍：
 * - vite dev 形态下 vite-plugin proxy 自动补 Authorization 头（同
 *   catalog/manifest 前端 fetch 先例——client.ts requestJSON 无 token 参数
 *   即此意），standalone 形态（electron / host）走后端 standalone token
 *   路径，proxy 同样补头
 * - 同步签名保留（setPiDesignAssignment(assignment | null) → void）——调用面
 *   （PiModelsPanel.vue saveKey / selectAssignmentOnModelChange / clearAssignment）
 *   无需 async 适配
 */

import { computed, ref } from 'vue'

import { piCatalog } from '@/app/ai/pi-backend/client'
import type { PiModelSpec } from '@/app/ai/pi-backend/client'

/** 与 PiModelSpec 同形（type-shapes 查重：此处只留别名，不重复声明对象形状） */
export type PiDesignAssignment = PiModelSpec

/** 模块初始化即 hydrate；终置 true（无论成败）。provider-gate deriveGateState
 *  据此判定 loading vs needs-setup——首屏需要-setup 闪现必须等 ready。
 */
export const piDesignAssignmentReady = ref(false)

export const piDesignAssignment = ref<PiDesignAssignment | null>(null)

/** 一次性 localStorage 旧键迁移——读后 PUT 上端点 + removeItem 旧键 */
const LEGACY_STORAGE_KEY = 'openpencil.pi.design-model'

interface AssignmentEnvelope {
  assignment?: PiModelSpec | null
}

async function throwAssignmentHttpError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  throw new Error(body?.error ?? `HTTP ${res.status}`)
}

async function fetchAssignment(): Promise<PiModelSpec | null> {
  const res = await fetch('/api/pi/design-assignment')
  if (!res.ok) {
    await throwAssignmentHttpError(res)
  }
  const envelope = (await res.json()) as AssignmentEnvelope
  return envelope.assignment ?? null
}

async function putAssignment(assignment: PiModelSpec | null): Promise<void> {
  const init: RequestInit = {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assignment })
  }
  const res = await fetch('/api/pi/design-assignment', init)
  if (!res.ok) {
    await throwAssignmentHttpError(res)
  }
}

/** 一次性迁移辅助——从 localStorage 旧键读出指派；坏 JSON 视为无指派。
 *  本函数封装 localStorage 直读（no-direct-storage-access 豁免——历史迁移
 *  代码路径专用，迁移完成即弃，新代码禁复用此封装）。
 */
function readLegacyAssignment(): PiDesignAssignment | null {
  // oxlint-disable-next-line open-pencil/no-direct-storage-access -- 一次性历史迁移专用，迁移完成即弃
  const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'providerId' in parsed &&
      'modelId' in parsed &&
      typeof (parsed as { providerId: unknown }).providerId === 'string' &&
      typeof (parsed as { modelId: unknown }).modelId === 'string'
    ) {
      return parsed as PiDesignAssignment
    }
    return null
  } catch {
    return null
  }
}

/** 模块初始化即触发——fire-and-forget；终置 piDesignAssignmentReady=true。
 *  无论成败 ready 都置 true：fetch 失败 = 端点不可达 = 降级保持 null（无指派）+
 *  ready，让引导门正常走 needs-setup 路径，不阻塞 UI。
 *  void 前缀 = 显式浮动（no-floating-promises 口径，CI type-aware 实证）。
 */
void (async () => {
  try {
    let current = await fetchAssignment()
    // 一次性迁移：端点无指派 + localStorage 旧键有值 → PUT 旧值上端点
    if (current === null) {
      const legacy = readLegacyAssignment()
      if (legacy) {
        await putAssignment(legacy)
        current = legacy
      }
      // PUT 成功后移除旧键——后续读写均走端点，旧键不再有意义。
      // PUT 失败会抛进外层 catch（本行不执行）：旧键保留，下次加载重试迁移，
      // 不毁唯一副本（主 agent review 纠注释——原「不论迁移是否成功」与代码不符）
      // oxlint-disable-next-line open-pencil/no-direct-storage-access -- 同 readLegacyAssignment，迁移专用
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    }
    piDesignAssignment.value = current
  } catch (error) {
    console.error(
      '[pi-design-assignment] hydrate 失败，保持 null（needs-setup 兜底）：' +
        (error instanceof Error ? error.message : String(error))
    )
  } finally {
    piDesignAssignmentReady.value = true
  }
})()

export function setPiDesignAssignment(assignment: PiDesignAssignment | null): void {
  // 乐观同步更 ref——UI 即时反映；PUT 失败 console.error 不回滚（单写者无冲突面）
  piDesignAssignment.value = assignment
  void putAssignment(assignment).catch((error: unknown) => {
    console.error(
      '[pi-design-assignment] PUT 失败（ref 已乐观更新）：' +
        (error instanceof Error ? error.message : String(error))
    )
  })
}

/**
 * 指派的 provider 是否在后端已有凭据（catalog 为准）。
 * 未指派或凭据缺失时，前端引导门（assistant/ChatPanel 派生态）是第一道闸，
 * 直接拦截发送、引导用户去设置面板；此处 computed 仅供设置页/输入条 label 提示用，
 * 即便绕过引导门，后端 resolveModel（T100 起 spec 必填）也会抛可行动错误兜底。
 */
export const piDesignCredentialConfigured = computed(() => {
  const assignment = piDesignAssignment.value
  const catalog = piCatalog.value
  if (!assignment || !catalog) return false
  const provider = catalog.providers.find((entry) => entry.id === assignment.providerId)
  return provider?.auth.configured ?? false
})

/** transport 每次发消息前调用，取当前指派。
 *  T100：未指派 → undefined → 后端 provider-admin.resolveModel 报
 *  「未指派设计模型——请打开设置→AI 选择 provider 与模型」可行动错误。
 *  引导门在前端拦截（assistant/ChatPanel 派生态，未配置不渲染输入框），
 *  此函数返回 undefined 是兜底路径——绕过 UI 的手工调用会拿到错误而非静默 fallback。 */
export function getPiDesignModelSpec(): PiModelSpec | undefined {
  const assignment = piDesignAssignment.value
  if (!assignment) return undefined
  return {
    providerId: assignment.providerId,
    modelId: assignment.modelId,
    ...(assignment.thinkingLevel ? { thinkingLevel: assignment.thinkingLevel } : {})
  }
}
