<script setup lang="ts">
/**
 * T21 P2 pi 模式设置面板：provider 目录、凭据（只进不出）、自定义 provider、
 * design 模型指派——全部走后端 admin API（client.ts），前端不持有任何 key。
 * 旧 ToolLoop 的 profile/connection/assignment 三表在 pi 模式下不展示、不迁移。
 *
 * T80：llm-provider UI 批（owner 决策已窄化范围）——
 * ①展开的 provider 模型列表加实时模糊搜索（name + id 大小写无关子串，不分组）；
 * ②design provider / model 两个 <select> 换成 reka-ui Combobox（自带搜索）；
 * ③模型行能力展示只做 image 输入 + context window，reasoning / cost 不展示。
 *
 * T97：合并面板形态（讨论稿 §4，owner 拍板）——
 * ①指派语义并入 provider 展开单元（key + 模型 Combobox + thinking 选择 + 设为当前）；
 * ②面板顶部"当前设计模型"摘要条；
 * ③默选机制不落盘（仅表单初值）：openrouter 钉 free，其他 provider 取首项；
 * ④保存 key 同写凭据与指派（无现存指派时——"存 key 即用"对任意 provider 字面成立）；
 * ⑤指派段独立 UI 整体删除（design provider/model Combobox + 哨兵
 *   `__pi_backend_default__` + designDirty + designCredentialMissing）；
 * ⑥深链锚点 anchor：openSettingsDialog(section, { provider }) 深链展开指定行 + 聚焦 key。
 *
 * 拆解：设计模型卡 UI 与本地状态迁出至 PiDesignModelCard.vue（max-lines 解压），
 *  本文件保留编排 + 状态真源 + 行内 provider 列表。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import { useI18n } from '@open-pencil/vue'

import { piDesignAssignment, setPiDesignAssignment } from '@/app/ai/pi-backend/assignment'
import type { PiCatalogModel, PiCatalogProvider } from '@/app/ai/pi-backend/catalog'
import type { PiThinkingLevel } from '@/app/ai/pi-backend/client'
import {
  clearPiCredential,
  deletePiProvider,
  piCatalog,
  piCatalogError,
  piCatalogLoading,
  refreshPiCatalog,
  setPiCredential,
  upsertPiProvider,
  verifyPiCredential
} from '@/app/ai/pi-backend/client'
import {
  OPENROUTER_PROVIDER_ID,
  buildAssignment,
  classifyAuthSource,
  classifyVerifyResult,
  filterCatalogModels,
  groupProvidersByConfigured,
  filterCatalogProviders,
  isCurrentAssignment,
  isCustomProvider,
  resolveDefaultModelId,
  resolveInitialSelectedProvider,
  shouldAutoAssignOnModelChange,
  shouldAutoAssignOnSaveKey,
  type VerifyResultClass
} from '@/app/ai/pi-backend/models-panel-rules'
// T35：27 条 pi 段 i18n 迁回 fork seam——本面板 pi 段用 useForkPi()，通用段（models/connected/modelNeedsCredential）仍走 useI18n()
import { useForkPi } from '@/app/i18n/fork'
import { settingsDialogAnchor, settingsDialogOpen } from '@/app/settings/dialog'
import Tip from '@/components/ui/overlay/Tip.vue'

import PiDesignModelCard from './PiDesignModelCard.vue'

const dialogs = useForkPi()
const { ai, collaboration: uiCollab } = useI18n()

/** 响应式 Record 去键——immutable 重写替代动态 delete（lint 禁 delete obj[computed]），
 *  ref 整体替换保持响应性。 */
function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

const expandedProviderId = ref<string | null>(null)
/** T97/T80：高级区行内模型目录浏览的搜索词——纯展示过滤（选择语义归设计模型卡） */
const modelSearch = ref('')
const keyDrafts = ref<Record<string, string>>({})
/** T100：行级 busy——同一时刻只允许一个 provider 行在跑动作；与 providerKeyInputs 同行级绑定 */
const busyProviderId = ref<string | null>(null)
/** T100 B2：行级错误 map（providerId → 错误文案）——保存/清除/验证/删除/编辑各动作的错误均下行。
 *  顶部的 actionError 彻底废止：错误不再"集中营"在面板顶端。 */
const rowErrors = ref<Record<string, string>>({})
/** T100 B1：验证瞬态结果（providerId → 验证态）——行内、不进持久状态。
 *  'busy' 表示验证中（按钮 spinner）；'ok'/'failed'/'unknown-error' 是完成后瞬态显示。
 *  切换 provider 展开/收起**不**自动清（用户重新看时仍可见）；refresh catalog 不清。 */
const verifyStates = ref<Record<string, VerifyResultClass | 'busy'>>({})

/** T97：合并单元内每个 provider 的表单初值（key 之外——modelId/thinkingLevel）。
 * 展开行时按 resolveDefaultModelId 钉初值；用户保存 key 才落盘成具体指派。
 * 2026-09-16 去重：draftThinking 删除（thinking 挂指派不挂 provider，行内草稿态零可见效果）。
 * 设计模型卡读写此 map 的 selectedProviderId 行——共享草稿态（行内 Combobox 已删，唯一消费即设计卡）。 */
const draftModel = ref<Record<string, string>>({})

/** T100 A1：provider 列表搜索词（顶层搜索框） */
const providerSearch = ref('')

/** T100 C2：自定义 provider 表单模式——'closed' | 'add' | 'edit'。edit 态带 editTargetProviderId */
type FormMode = 'closed' | 'add' | 'edit'
const formMode = ref<FormMode>('closed')
const editTargetProviderId = ref<string | null>(null)
const customId = ref('')
const customName = ref('')
const customBaseURL = ref('')
const customAPI = ref('openai-completions')
const customModelIds = ref('')
const CUSTOM_API_TYPES = ['openai-completions', 'openai-responses', 'anthropic-messages']
/** T100 C1：行级删除二次确认态——providerId=true 表示"该行已点删除、等待二次确认"。
 *  同 provider 再次进入该 provider 行 / 切换到别的 provider / 用户点取消 → 清。
 *  切换 formMode 不互斥（添加表单与删除确认是正交动作）。 */
const deleteConfirmIds = ref<Record<string, boolean>>({})

/** T97：key 输入框 DOM 引用（focus 用，anchor 深链展开后聚焦） */
const providerKeyInputs = ref<Record<string, HTMLInputElement | null>>({})

const providers = computed<PiCatalogProvider[]>(() => piCatalog.value?.providers ?? [])

/** ux-polish④：watch catalog.length 从 0 → N 时，按 resolveInitialSelectedProvider 钉初值。
 *  后续用户切换由 combobox update 直接驱动；指派变化不强制重选（用户已选 → 让位）。 */
watch(
  () => providers.value.length,
  (len) => {
    if (len === 0) return
    if (selectedProviderId.value) {
      // 已选过：校准——指派可能变化（如用户存了其他 provider 的 key 后回到本卡）
      const current = providers.value.find((p) => p.id === selectedProviderId.value)
      if (current) return
    }
    selectedProviderId.value = resolveInitialSelectedProvider({
      assignmentProviderId: piDesignAssignment.value?.providerId ?? null,
      providers: providers.value
    })
  },
  { immediate: true }
)

/** ux-polish④：设计模型卡 — 顶层四字段卡选中 provider，初值由 catalog watch 钉 */
const selectedProviderId = ref<string>('')

/** 设计模型卡 — provider 变更：模型字段重置为 resolveDefaultModelId → 按 shouldAutoAssignOnModelChange 语义决定是否静默指派 */
function onDesignProviderChange(providerId: string): void {
  const provider = providers.value.find((p) => p.id === providerId)
  if (!provider) return
  const modelId = resolveDefaultModelId(provider)
  // 同步展开单元内的 draft（设计卡与设计卡共享 modelDrafts，行内 Combobox 已删，仅供设计卡读）
  draftModel.value[providerId] = modelId
  if (
    modelId &&
    shouldAutoAssignOnModelChange({
      existingAssignment: piDesignAssignment.value,
      targetProviderId: providerId,
      targetModelId: modelId
    })
  ) {
    const a = piDesignAssignment.value
    setPiDesignAssignment(
      buildAssignment({
        providerId,
        modelId,
        thinkingLevel: a?.providerId === providerId ? a.thinkingLevel : 'off'
      })
    )
  }
  // 切换 provider 不动旧 provider 行的展开态——展开收起由用户主动控制
  // 切换 provider 后清 providerSearch 由子卡 PiDesignModelCard 自身处理
}

/** 设计模型卡 — 模型变更（按 selectedProviderId 维度）：自动写回指派（§4.3 约束 3 语义） */
function onDesignModelChange(modelId: string): void {
  const providerId = selectedProviderId.value
  if (!providerId || !modelId) return
  const a = piDesignAssignment.value
  if (
    shouldAutoAssignOnModelChange({
      existingAssignment: a,
      targetProviderId: providerId,
      targetModelId: modelId
    })
  ) {
    setPiDesignAssignment(buildAssignment({ providerId, modelId, thinkingLevel: a?.thinkingLevel }))
  }
  draftModel.value[providerId] = modelId
}

/** 设计模型卡 — thinking 变更：写回指派（thinking 挂指派不挂 provider；
 *  非当前指派 provider 无挂载点 = no-op，2026-09-16 去重后不再留草稿态） */
function onDesignThinkingChange(level: PiThinkingLevel): void {
  const providerId = selectedProviderId.value
  if (!providerId) return
  const a = piDesignAssignment.value
  if (a && a.providerId === providerId) {
    setPiDesignAssignment(buildAssignment({ providerId, modelId: a.modelId, thinkingLevel: level }))
  }
}

/** 设计模型卡 — API key 保存/清除/验证复用现有 handler（providerId = selectedProviderId）。 */
function onDesignSaveKey(): void {
  const providerId = selectedProviderId.value
  if (!providerId) return
  void saveKey(providerId)
}

function onDesignClearKey(): void {
  const providerId = selectedProviderId.value
  if (!providerId) return
  void clearKey(providerId)
}

function onDesignVerifyKey(): void {
  const providerId = selectedProviderId.value
  if (!providerId) return
  void verifyProvider(providerId)
}

/** 设计模型卡 — keyDraft v-model：子卡对当前 selectedProviderId 行的写入转发回 keyDrafts map */
function onDesignKeyDraftUpdate(value: string): void {
  const providerId = selectedProviderId.value
  if (!providerId) return
  keyDrafts.value[providerId] = value
}

/** ux-polish④：高级区折叠态（默认收起）——providers 列表区降格为高级区 */
const advancedOpen = ref(false)

/** T100 A1+A2+A3：搜索 + 已配置置顶分组——驱动模板主列表循环。
 *  顺序：①搜索过滤（name+id 大小写无关）→ ②按 configured 状态分组。
 *  组内维持原数组顺序（pi SDK 内建注册序 ≈ 字典序）。空组不出现（避免 0 长小标题）。 */
const providerGroups = computed(() =>
  groupProvidersByConfigured(filterCatalogProviders(providers.value, providerSearch.value))
)

/** T100：搜索过滤后空结果——单独抽出来便于模板条件渲染，避免双重 v-if 嵌套 */
const providerSearchEmpty = computed(
  () => providerSearch.value.trim().length > 0 && providerGroups.value.length === 0
)

/** T100 C1：判断 provider 行内是否显示「删除」入口（仅自定义 provider） */
function canDeleteProvider(provider: { kind?: 'builtin' | 'custom' }): boolean {
  return isCustomProvider(provider)
}

/** T97：能力展示只取 image 输入（catalog.input 含 'image'）——reasoning / cost 明示不展示 */
function supportsImageInput(model: PiCatalogModel): boolean {
  return model.input.includes('image')
}

function contextLabel(model: PiCatalogModel): string {
  return `${Math.round(model.contextWindow / 1024)}k`
}

/** T97：provider 行"当前"check 派生（§4.3 约束 1 单指派语义视觉显式） */
function isCurrentProvider(providerId: string): boolean {
  return isCurrentAssignment(providerId, piDesignAssignment.value)
}

/** T97：展开/收起 + 初始化表单初值（resolveDefaultModelId 钉默选） */
function toggleProvider(providerId: string): void {
  expandedProviderId.value = expandedProviderId.value === providerId ? null : providerId
  modelSearch.value = ''
  if (expandedProviderId.value === providerId) {
    const provider = providers.value.find((p) => p.id === providerId)
    if (!provider) return
    if (!draftModel.value[providerId]) {
      const draft = resolveDefaultModelId(provider)
      if (draft) draftModel.value[providerId] = draft
    }
  }
}

async function saveKey(providerId: string): Promise<void> {
  const key = (keyDrafts.value[providerId] ?? '').trim()
  if (!key) return
  busyProviderId.value = providerId
  rowErrors.value = omitRecordKey(rowErrors.value, providerId)
  try {
    await setPiCredential(providerId, key)
    keyDrafts.value[providerId] = ''
    // §4.2 段 d：无现存指派 → 保存 key 同写指派（用该行 draftModel 的当前值，
    // 即 resolveDefaultModelId 钉的初值或用户改过的值）
    if (
      shouldAutoAssignOnSaveKey({
        existingAssignment: piDesignAssignment.value,
        targetProviderId: providerId
      })
    ) {
      const modelId =
        draftModel.value[providerId] ??
        resolveDefaultModelId(providers.value.find((p) => p.id === providerId) ?? null)
      if (modelId) {
        setPiDesignAssignment(
          buildAssignment({
            providerId,
            modelId,
            // 自动指派恒 off（2026-09-16 去重：draftThinking 联动删除——
            // thinking 要设先在设计模型卡显式选，不随存 key 顺捎）
            thinkingLevel: 'off'
          })
        )
      }
    }
  } catch (error) {
    rowErrors.value[providerId] = error instanceof Error ? error.message : String(error)
  } finally {
    busyProviderId.value = null
  }
}

async function clearKey(providerId: string): Promise<void> {
  busyProviderId.value = providerId
  rowErrors.value = omitRecordKey(rowErrors.value, providerId)
  try {
    await clearPiCredential(providerId)
    // T97：清除当前指派 provider 的 key 不清指派——指派语义独立；该 provider 行
    // 因 auth.configured=false 显示"未配置"，与"删除指派"是两条路径
  } catch (error) {
    rowErrors.value[providerId] = error instanceof Error ? error.message : String(error)
  } finally {
    busyProviderId.value = null
  }
}

/** T97：摘要条"切换到该 provider"——展开单元+聚焦 key 输入 */
function focusProvider(providerId: string): void {
  expandedProviderId.value = providerId
  const provider = providers.value.find((p) => p.id === providerId)
  if (provider && !draftModel.value[providerId]) {
    const draft = resolveDefaultModelId(provider)
    if (draft) draftModel.value[providerId] = draft
  }
  void nextTick(() => {
    const input = providerKeyInputs.value[providerId]
    input?.focus()
  })
}

/** T100 B1：行内验证按钮——verifyPiCredential 不打持久状态，结果行内瞬态显示。
 *  busy 期间再次点击会被 disabled 拦；同 provider 已有验证结果时再次点击会覆盖。
 *  错误降级走 rowErrors（与 save/clear/delete/edit 同位），验证结果文案本身不写
 *  rowErrors（rowErrors 是"操作错误"位；verifyStates 是"操作结果"位——两者语义不同）。 */
async function verifyProvider(providerId: string): Promise<void> {
  if (verifyStates.value[providerId] === 'busy') return
  verifyStates.value[providerId] = 'busy'
  rowErrors.value = omitRecordKey(rowErrors.value, providerId)
  try {
    const result = await verifyPiCredential(providerId)
    verifyStates.value[providerId] = classifyVerifyResult(result)
    // 失败的具体原因（后端 error 文案，如 401/形态不支持）下行行级错误位——
    // 只显示「验证失败」用户无法定位问题
    if (!result.ok && result.error) rowErrors.value[providerId] = result.error
  } catch (error) {
    // 网络异常 / 后端 500 等——verifyStates 标 failed，错误文案走 rowErrors
    verifyStates.value[providerId] = 'failed'
    rowErrors.value[providerId] = error instanceof Error ? error.message : String(error)
  }
}

/** T100 C1：第一次点删除——进入"二次确认"态，不直接调后端。
 *  二次确认只对当前行可见（行内确认/取消两态小 UI），不引入全局弹窗组件。 */
function startDelete(providerId: string): void {
  if (!canDeleteProvider(providers.value.find((p) => p.id === providerId) ?? {})) return
  deleteConfirmIds.value[providerId] = true
  rowErrors.value = omitRecordKey(rowErrors.value, providerId)
}

/** T100 C1：取消删除——回退到正常态（不调后端） */
function cancelDelete(providerId: string): void {
  deleteConfirmIds.value = omitRecordKey(deleteConfirmIds.value, providerId)
}

/** T100 C1：行内确认删除——调 deletePiProvider，失败错误下沉到行内 */
async function confirmDelete(providerId: string): Promise<void> {
  busyProviderId.value = providerId
  deleteConfirmIds.value = omitRecordKey(deleteConfirmIds.value, providerId)
  rowErrors.value = omitRecordKey(rowErrors.value, providerId)
  try {
    await deletePiProvider(providerId)
    // 删除成功：清理该行的 transient state（draft/verify/confirm），并 collapse 行
    keyDrafts.value = omitRecordKey(keyDrafts.value, providerId)
    draftModel.value = omitRecordKey(draftModel.value, providerId)
    verifyStates.value = omitRecordKey(verifyStates.value, providerId)
    if (expandedProviderId.value === providerId) expandedProviderId.value = null
  } catch (error) {
    rowErrors.value[providerId] = error instanceof Error ? error.message : String(error)
  } finally {
    busyProviderId.value = null
  }
}

/** T100 C2：进入编辑态——预填当前 provider 字段；id 只读（不可改）；
 *  与「添加自定义 Provider」共用 form 组件、按 mode 切换标题与提交语义。 */
function startEdit(providerId: string): void {
  const provider = providers.value.find((p) => p.id === providerId)
  if (!provider) return
  // 不依赖 builtin 判定（canDeleteProvider 已是 kind=custom 守卫）——startEdit
  // 也只对自定义 provider 暴露入口（UI 隐藏）。防御性二次校验。
  if (!canDeleteProvider(provider)) return
  editTargetProviderId.value = providerId
  customId.value = provider.id
  customName.value = provider.name
  customBaseURL.value = provider.baseUrl ?? ''
  // api 类型优先看 provider.models[0]?.api（来自 SDK 反序列化）；fallback 缺省值
  customAPI.value = provider.models[0]?.api ?? 'openai-completions'
  customModelIds.value = provider.models.map((m) => m.id).join('\n')
  rowErrors.value = omitRecordKey(rowErrors.value, providerId)
  formMode.value = 'edit'
}

/** T100 C2：进入添加态——表单字段清空，标题切到「添加自定义 Provider」 */
function startAdd(): void {
  editTargetProviderId.value = null
  customId.value = ''
  customName.value = ''
  customBaseURL.value = ''
  customAPI.value = 'openai-completions'
  customModelIds.value = ''
  formMode.value = 'add'
}

/** T100 C2：关闭表单（共用——添加/编辑共用取消按钮） */
function closeForm(): void {
  formMode.value = 'closed'
  editTargetProviderId.value = null
  customId.value = ''
  customName.value = ''
  customBaseURL.value = ''
  customModelIds.value = ''
}

/** T100 C2：提交——按 formMode 走 add/edit 路径，错误下行到目标行 */
async function submitCustomForm(): Promise<void> {
  const models = customModelIds.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const isEdit = formMode.value === 'edit'
  const targetId = isEdit ? editTargetProviderId.value : null
  // 错误位：edit 走原 providerId，add 走 '__custom__' 虚拟行
  const errorKey = targetId ?? '__custom__'
  busyProviderId.value = errorKey
  rowErrors.value = omitRecordKey(rowErrors.value, errorKey)
  try {
    await upsertPiProvider({
      id: customId.value.trim(),
      ...(customName.value.trim() ? { name: customName.value.trim() } : {}),
      baseUrl: customBaseURL.value.trim(),
      api: customAPI.value,
      models
    })
    closeForm()
  } catch (error) {
    rowErrors.value[errorKey] = error instanceof Error ? error.message : String(error)
  } finally {
    busyProviderId.value = null
  }
}

/** T100 D1：source 标签文案——归类走 classifyAuthSource（SDK 真实 source 值钉在
 *  规则层：'stored credential' / 环境变量名本身）；未知形态不渲染（保守）。
 *  只对 environment 来源打标——「设置存储」是冗余信息（configured 即说明已存），
 *  env 来源才是用户需要解释的非常态（未存却 configured + shadow 语义）。
 *  catalog 未透传 env 并存标志，shadow 提示超出本单范围（讨论稿 §5.D1 +
 *  §6.3 key-env 拍板联动项）。 */
function sourceLabel(source: string | undefined): string | null {
  const sourceClass = classifyAuthSource(source)
  if (sourceClass === 'environment') return dialogs.value.providerAuthSourceEnvironment
  return null
}

/** T97：watch 深链锚点——引导门传 { provider } 时展开该行 + 聚焦 key 输入。
 *  immediate:true + 双源：CTA 先设锚点再开面板（面板后挂载）时锚点已是终态、
 *  无变化事件——immediate 在挂载即评；catalog 未就绪（len=0）先让位，
 *  目录到达后 providers.length 变化再触发。聚焦后消费锚点（置 null）——
 *  一次性深链，防目录刷新（保存 key 后 refresh）重复展开用户已收起的行。 */
watch(
  [() => settingsDialogAnchor.value?.provider ?? null, () => providers.value.length],
  ([providerId, len]) => {
    if (!providerId || len === 0) return
    focusProvider(providerId)
    settingsDialogAnchor.value = null
  },
  { immediate: true }
)

/** T97：关闭时清空锚点（防止下次打开残留旧 provider） */
watch(settingsDialogOpen, (open) => {
  if (!open) settingsDialogAnchor.value = null
})

/** T97 §4.2 段 c：未配置首开——catalog 就绪后 openrouter 行默认展开 + key 聚焦 +
 *  Combobox 显示 free 待确认初值（focusProvider 内经 resolveDefaultModelId 钉）。
 *  已有指派 / anchor 深链 / 用户已自行展开时让位，不争。 */
watch(
  () => providers.value.length,
  (len) => {
    if (len === 0) return
    if (piDesignAssignment.value) return
    if (settingsDialogAnchor.value?.provider) return
    if (expandedProviderId.value) return
    focusProvider(OPENROUTER_PROVIDER_ID)
  },
  { immediate: true }
)

onMounted(() => void refreshPiCatalog())
</script>

<template>
  <!-- T91k：根节点不再自滚——滚动职责上交 SettingsDialog 标签页容器，
       让 AgentSettingsPanel 跟在模型清单下方同流滚动（owner 拍板） -->
  <div class="flex flex-col">
    <!-- ux-polish④：设计模型卡——四字段（provider / model / thinking / api key）。
         无条件渲染（catalog 就绪后）：无指派时它是唯一配置入口，引导门 unlock 路径靠它。 -->
    <PiDesignModelCard
      v-model:selected-provider-id="selectedProviderId"
      :providers="providers"
      :assignment="piDesignAssignment"
      :model-drafts="draftModel"
      :key-drafts="keyDrafts"
      :busy-provider-id="busyProviderId"
      :row-errors="rowErrors"
      :verify-states="verifyStates"
      :is-current-provider="isCurrentProvider"
      :connected-label="uiCollab.connected"
      :model-needs-credential-label="ai.modelNeedsCredential"
      @update:key-draft="onDesignKeyDraftUpdate"
      @provider-change="onDesignProviderChange"
      @model-change="onDesignModelChange"
      @thinking-change="onDesignThinkingChange"
      @save-key="onDesignSaveKey"
      @clear-key="onDesignClearKey"
      @verify-key="onDesignVerifyKey"
    />

    <!-- ux-polish④：providers 列表区降格为高级区——默认收起，触发行文案明示"高级：Provider 列表与自定义 Provider"。 -->
    <section data-test-id="pi-providers-advanced" class="mb-3 rounded border border-border">
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-panel-field"
        :aria-expanded="advancedOpen"
        data-test-id="pi-providers-advanced-trigger"
        @click="advancedOpen = !advancedOpen"
      >
        <icon-lucide-chevron-right
          class="size-3.5 shrink-0 text-muted transition-transform"
          :class="{ 'rotate-90': advancedOpen }"
        />
        <span class="text-xs font-semibold text-surface">{{
          dialogs.designCardAdvancedTrigger
        }}</span>
      </button>
      <div
        v-if="advancedOpen"
        class="border-t border-border p-3"
        data-test-id="pi-providers-advanced-content"
      >
        <section data-test-id="pi-providers-panel">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-xs font-semibold text-surface">{{ dialogs.providersTitle }}</h3>
            <button
              type="button"
              class="flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-[11px] font-medium text-surface hover:bg-panel-field"
              data-test-id="pi-catalog-refresh"
              :disabled="piCatalogLoading"
              @click="refreshPiCatalog"
            >
              <icon-lucide-refresh-cw
                class="size-3"
                :class="{ 'animate-spin': piCatalogLoading }"
              />
              {{ dialogs.catalogRefresh }}
            </button>
          </div>

          <!-- T100 A1：provider 列表搜索框（顶层，与展开行内模型搜索字段互不影响） -->
          <input
            v-model="providerSearch"
            type="search"
            class="mb-2 w-full rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
            :placeholder="dialogs.providerSearchPlaceholder"
            data-test-id="pi-provider-search"
          />

          <p
            v-if="piCatalogError"
            class="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400"
            data-test-id="pi-catalog-offline"
          >
            {{ dialogs.catalogOffline }} ({{ piCatalogError }})
          </p>
          <!-- T100：search 空结果态——独立显示，与 providerGroups 空列表区分 -->
          <p
            v-if="providerSearchEmpty"
            class="rounded border border-border bg-panel-field px-3 py-2 text-[10px] text-muted"
            data-test-id="pi-provider-search-empty"
          >
            {{ dialogs.providerSearchEmpty }}
          </p>

          <div class="mt-2 flex flex-col gap-2">
            <!-- T100 A2+A3：按 configured 状态分组循环——已配置置顶 + 分组小标题 -->
            <template v-for="group in providerGroups" :key="group.id">
              <p
                class="text-[10px] font-medium tracking-wide text-muted uppercase"
                :data-group-id="group.id"
                data-test-id="pi-provider-group-header"
              >
                {{
                  group.id === 'configured'
                    ? dialogs.providerGroupConfigured
                    : dialogs.providerGroupAll
                }}
              </p>
              <div class="flex flex-col gap-1.5">
                <div
                  v-for="provider in group.providers"
                  :key="provider.id"
                  class="rounded border border-border bg-panel-field"
                  :data-provider-id="provider.id"
                  data-test-id="pi-provider-row"
                >
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-panel-field-hover"
                    @click="toggleProvider(provider.id)"
                  >
                    <div
                      class="flex size-8 shrink-0 items-center justify-center rounded bg-panel text-muted"
                    >
                      <icon-lucide-bot class="size-4" />
                    </div>
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-[11px] font-medium text-surface">
                        {{ provider.name }}
                      </p>
                      <p class="truncate text-[10px] text-muted">
                        {{ provider.id }} ·
                        {{ dialogs.providerModels({ count: provider.models.length }) }}
                      </p>
                    </div>
                    <span
                      v-if="isCurrentProvider(provider.id)"
                      class="flex shrink-0 items-center gap-1 text-[10px] font-medium text-accent"
                      data-test-id="pi-current-marker"
                    >
                      <icon-lucide-check class="size-3" />
                      {{ dialogs.currentAssignmentCurrent }}
                    </span>
                    <span
                      class="mr-1 flex shrink-0 items-center gap-1 text-[9px] text-muted"
                      :data-state="provider.auth.configured ? 'configured' : 'missing'"
                    >
                      <span
                        class="size-1.5 rounded-full bg-muted data-[state=configured]:bg-[var(--color-success)]"
                        :data-state="provider.auth.configured ? 'configured' : 'missing'"
                      />
                      <span>{{
                        provider.auth.configured ? uiCollab.connected : ai.modelNeedsCredential
                      }}</span>
                      <!-- T100 D1：source 标签——仅 configured 时按 catalog.auth.source 渲染；
                       shadow 提示不在本单范围（讨论稿 §5.D1 + §6.3 key-env 拍板联动） -->
                      <span
                        v-if="sourceLabel(provider.auth.source)"
                        class="rounded border border-border px-1 text-[9px] text-muted"
                        :data-source="provider.auth.source"
                        data-test-id="pi-auth-source"
                      >
                        {{ sourceLabel(provider.auth.source) }}
                      </span>
                    </span>
                    <icon-lucide-chevron-right
                      class="size-3.5 shrink-0 text-muted transition-transform"
                      :class="{ 'rotate-90': expandedProviderId === provider.id }"
                    />
                  </button>

                  <div
                    v-if="expandedProviderId === provider.id"
                    class="border-t border-border px-3 py-2"
                  >
                    <div class="flex items-center gap-1.5">
                      <input
                        :ref="
                          (el) => {
                            providerKeyInputs[provider.id] = el as HTMLInputElement | null
                          }
                        "
                        v-model="keyDrafts[provider.id]"
                        type="password"
                        class="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
                        :placeholder="
                          provider.auth.configured
                            ? dialogs.keyPlaceholderConfigured
                            : dialogs.keyPlaceholderMissing
                        "
                        data-test-id="pi-key-input"
                        @keydown.enter="saveKey(provider.id)"
                      />
                      <button
                        type="button"
                        class="rounded bg-accent px-2 py-1.5 text-[10px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                        data-test-id="pi-key-save"
                        :disabled="busyProviderId === provider.id"
                        @click="saveKey(provider.id)"
                      >
                        {{ dialogs.keySave }}
                      </button>
                      <button
                        v-if="provider.auth.configured"
                        type="button"
                        class="rounded border border-border px-2 py-1.5 text-[10px] text-muted hover:text-surface disabled:opacity-50"
                        data-test-id="pi-key-clear"
                        :disabled="busyProviderId === provider.id"
                        @click="clearKey(provider.id)"
                      >
                        {{ dialogs.keyClear }}
                      </button>
                    </div>

                    <!-- T100 B2：行级错误位（保存/清除/验证/删除/编辑各动作的错误均下行到对应行内） -->
                    <p
                      v-if="rowErrors[provider.id]"
                      class="mt-1 text-[10px] text-red-400"
                      :data-provider-id="provider.id"
                      data-test-id="pi-row-error"
                    >
                      {{ rowErrors[provider.id] }}
                    </p>

                    <!-- T100 B1：验证按钮（已配置 provider）—— 行内验证闭环；
                     busy 期间 disabled 防重击；完成后行内显示三态结果文案 -->
                    <div v-if="provider.auth.configured" class="mt-1.5 flex items-center gap-2">
                      <button
                        type="button"
                        class="rounded border border-border px-2 py-1 text-[10px] text-muted hover:text-surface disabled:opacity-50"
                        data-test-id="pi-provider-verify"
                        :disabled="verifyStates[provider.id] === 'busy'"
                        @click="verifyProvider(provider.id)"
                      >
                        <icon-lucide-shield-check class="mr-0.5 inline size-3" />
                        {{ dialogs.providerVerify }}
                      </button>
                      <span
                        v-if="verifyStates[provider.id] === 'busy'"
                        class="flex items-center gap-1 text-[10px] text-muted"
                        data-test-id="pi-verify-state"
                        data-verify-state="busy"
                      >
                        <icon-lucide-loader-2 class="size-3 animate-spin" />
                      </span>
                      <span
                        v-else-if="verifyStates[provider.id] === 'ok'"
                        class="text-[10px] text-[var(--color-success)]"
                        data-test-id="pi-verify-state"
                        data-verify-state="ok"
                      >
                        {{ dialogs.providerVerifyOk }}
                      </span>
                      <span
                        v-else-if="verifyStates[provider.id] === 'failed'"
                        class="text-[10px] text-red-400"
                        data-test-id="pi-verify-state"
                        data-verify-state="failed"
                      >
                        {{ dialogs.providerVerifyFailed }}
                      </span>
                      <span
                        v-else-if="verifyStates[provider.id] === 'unknown-error'"
                        class="text-[10px] text-red-400"
                        data-test-id="pi-verify-state"
                        data-verify-state="unknown-error"
                      >
                        {{ dialogs.providerVerifyUnknownError }}
                      </span>
                    </div>

                    <!-- T100 C2：自定义 provider 行内「编辑」入口（仅 kind=custom 显示） -->
                    <div class="mt-1.5 flex items-center gap-2">
                      <button
                        v-if="canDeleteProvider(provider)"
                        type="button"
                        class="rounded border border-border px-2 py-1 text-[10px] text-muted hover:text-surface disabled:opacity-50"
                        data-test-id="pi-provider-edit"
                        :disabled="busyProviderId === provider.id"
                        @click="startEdit(provider.id)"
                      >
                        <icon-lucide-pencil class="mr-0.5 inline size-3" />
                        {{ dialogs.providerEdit }}
                      </button>
                      <!-- T100 C1：行内删除二次确认态——未确认时显示「删除」；确认时切到两态小 UI -->
                      <template v-if="!deleteConfirmIds[provider.id]">
                        <button
                          v-if="canDeleteProvider(provider)"
                          type="button"
                          class="rounded border border-border px-2 py-1 text-[10px] text-muted hover:text-red-400 disabled:opacity-50"
                          data-test-id="pi-provider-delete"
                          :disabled="busyProviderId === provider.id"
                          @click="startDelete(provider.id)"
                        >
                          <icon-lucide-trash-2 class="mr-0.5 inline size-3" />
                          {{ dialogs.providerDelete }}
                        </button>
                      </template>
                      <template v-else>
                        <span
                          class="flex items-center gap-1.5 text-[10px] text-red-400"
                          data-test-id="pi-delete-confirm"
                        >
                          {{ dialogs.providerDeleteConfirm }}
                          <button
                            type="button"
                            class="rounded border border-red-500/40 px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                            data-test-id="pi-delete-confirm-yes"
                            :disabled="busyProviderId === provider.id"
                            @click="confirmDelete(provider.id)"
                          >
                            {{ dialogs.providerDelete }}
                          </button>
                          <button
                            type="button"
                            class="rounded border border-border px-2 py-0.5 text-[10px] text-muted hover:text-surface"
                            data-test-id="pi-delete-confirm-cancel"
                            @click="cancelDelete(provider.id)"
                          >
                            {{ dialogs.providerDeleteCancel }}
                          </button>
                        </span>
                        <span class="text-[9px] text-muted">{{
                          dialogs.providerDeleteConfirmHint
                        }}</span>
                      </template>
                    </div>

                    <!-- T97/T80：模型目录搜索 + 平铺展示——纯浏览不提供行内选择（模型选择归设计模型卡，
                     行内 Combobox 已移除）；行纯 span 无点击语义 -->
                    <input
                      v-model="modelSearch"
                      type="search"
                      class="mt-2 w-full rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
                      :placeholder="dialogs.modelSearchPlaceholder"
                      data-test-id="pi-model-search"
                    />

                    <div
                      class="scrollbar-thin mt-1.5 max-h-40 overflow-y-auto rounded bg-panel p-1.5"
                    >
                      <div
                        v-for="model in filterCatalogModels(provider.models, modelSearch)"
                        :key="model.id"
                        class="flex items-center justify-between gap-2 px-1 py-0.5 text-[10px]"
                        :data-model-id="model.id"
                        data-test-id="pi-model-row"
                      >
                        <span class="min-w-0 flex-1 truncate text-surface">{{ model.name }}</span>
                        <span class="flex shrink-0 items-center gap-1.5 text-muted">
                          <Tip v-if="supportsImageInput(model)" :label="dialogs.modelSupportsImage">
                            <span
                              class="flex items-center gap-0.5 text-muted"
                              data-test-id="pi-model-image-input"
                            >
                              <icon-lucide-image class="size-3" />
                            </span>
                          </Tip>
                          <span v-if="model.contextWindow" data-test-id="pi-model-context">
                            {{ contextLabel(model) }}
                          </span>
                          <span class="truncate">{{ model.id }}</span>
                        </span>
                      </div>
                      <p
                        v-if="filterCatalogModels(provider.models, modelSearch).length === 0"
                        class="px-1 py-1 text-[10px] text-muted"
                        data-test-id="pi-model-search-empty"
                      >
                        {{ dialogs.modelSearchEmpty }}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <button
            v-if="formMode === 'closed'"
            type="button"
            class="mt-2 flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-[11px] font-medium text-surface hover:bg-panel-field"
            data-test-id="pi-add-provider"
            @click="startAdd"
          >
            <icon-lucide-plus class="size-3" />
            {{ dialogs.addProvider }}
          </button>

          <!-- T100 C2：自定义 provider 表单——add / edit 共用同一组件、按 mode 切换标题与提交语义。
           edit 态 id 只读；提交错误下沉到对应 providerId 行（edit）或 '__custom__' 虚拟行（add） -->
          <div
            v-else
            class="mt-2 flex flex-col gap-1.5 rounded border border-border bg-panel-field px-3 py-2"
            data-test-id="pi-provider-form"
            :data-form-mode="formMode"
          >
            <p class="text-[11px] font-medium text-surface">
              {{
                formMode === 'edit' ? dialogs.providerFormTitleEdit : dialogs.providerFormTitleAdd
              }}
            </p>
            <p
              v-if="
                rowErrors[
                  formMode === 'edit' && editTargetProviderId ? editTargetProviderId : '__custom__'
                ]
              "
              class="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-400"
              data-test-id="pi-provider-form-error"
            >
              {{
                rowErrors[
                  formMode === 'edit' && editTargetProviderId ? editTargetProviderId : '__custom__'
                ]
              }}
            </p>
            <input
              v-model="customId"
              type="text"
              class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus disabled:opacity-60"
              :placeholder="dialogs.providerId"
              :disabled="formMode === 'edit'"
              :readonly="formMode === 'edit'"
              data-test-id="pi-provider-id-input"
            />
            <p
              v-if="formMode === 'edit'"
              class="text-[9px] text-muted"
              data-test-id="pi-provider-id-readonly-hint"
            >
              {{ dialogs.providerFormIdReadonlyHint }}
            </p>
            <input
              v-model="customBaseURL"
              type="text"
              class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
              :placeholder="dialogs.providerBaseUrl"
              data-test-id="pi-provider-baseurl-input"
            />
            <select
              v-model="customAPI"
              class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none"
              data-test-id="pi-provider-api-select"
            >
              <option v-for="api in CUSTOM_API_TYPES" :key="api" :value="api">{{ api }}</option>
            </select>
            <textarea
              v-model="customModelIds"
              rows="3"
              class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
              :placeholder="dialogs.providerModelIds"
              data-test-id="pi-provider-models-input"
            />
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded bg-accent px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
                data-test-id="pi-provider-save"
                :disabled="
                  busyProviderId ===
                  (formMode === 'edit' && editTargetProviderId
                    ? editTargetProviderId
                    : '__custom__')
                "
                @click="submitCustomForm"
              >
                {{ formMode === 'edit' ? dialogs.providerFormSaveEdit : dialogs.providerSave }}
              </button>
              <button
                type="button"
                class="rounded border border-border px-2.5 py-1.5 text-[11px] text-muted hover:text-surface"
                data-test-id="pi-provider-form-cancel"
                @click="closeForm"
              >
                {{ dialogs.providerDeleteCancel }}
              </button>
            </div>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>
