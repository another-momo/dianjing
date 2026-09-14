/**
 * T21 P2 pi 模式下的 design 模型指派（全新槽位，不做存量迁移）。
 *
 * 旧 ToolLoop 模式走 models/store.ts 的 profile/connection/assignment 三表；
 * pi 模式凭据与 catalog 都在后端（auth.json + models.json），前端只需记住
 * "design agent 用哪个 provider/model/thinkingLevel"，随 POST body 传给后端
 * （transport.ts → server.ts ModelSpec）。localStorage 独立 key，与旧设置互不影响。
 */

import { StorageSerializers, useLocalStorage } from '@vueuse/core'
import { computed } from 'vue'

import { piCatalog } from '@/app/ai/pi-backend/client'
import type { PiModelSpec } from '@/app/ai/pi-backend/client'

const STORAGE_KEY = 'openpencil.pi.design-model'

/** 与 PiModelSpec 同形（type-shapes 查重：此处只留别名，不重复声明对象形状） */
export type PiDesignAssignment = PiModelSpec

export const piDesignAssignment = useLocalStorage<PiDesignAssignment | null>(STORAGE_KEY, null, {
  serializer: StorageSerializers.object
})

export function setPiDesignAssignment(assignment: PiDesignAssignment | null): void {
  piDesignAssignment.value = assignment
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
