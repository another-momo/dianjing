<!--
  T87：Agent 能力开关面板（settings 面板 ai 区下小节）。
  T96 重构（预研 §5.2）：章节标题 + 描述；builtinTools 三档 radio 组
  （off 无内建 / readonly 只读四件 / full SDK 默认全集）；agentSkills 开关
  带标签 + 描述（与 builtinTools 解耦，独控 skill 加载）。PUT 全量 body，
  乐观更新失败回滚；保存中禁输入。启动时按 piCapabilities 镜像初值。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { applyPiCapabilities, piCapabilities } from '@/app/ai/pi-backend/mode-selection'
import { useForkAgentCapabilities } from '@/app/i18n/fork'
import SettingsGroup from '@/components/settings/layout/SettingsGroup.vue'
import SettingsSectionHeader from '@/components/settings/layout/SettingsSectionHeader.vue'
import Tip from '@/components/ui/overlay/Tip.vue'

const msgs = useForkAgentCapabilities()

type LocalCapabilities = NonNullable<typeof piCapabilities.value>

const localCapabilities = ref<LocalCapabilities>(
  piCapabilities.value ?? { builtinTools: 'off', agentSkills: false }
)
const saving = ref(false)
const errorText = ref<string | null>(null)

onMounted(() => {
  // ensurePiStudioManifest 已统一拉取 capabilities（与 manifest 同 fetch
  // 调用面）；面板挂载时再读一次以覆盖 settings 面板 open 时机晚于 ChatInput
  // 的场景
  if (piCapabilities.value) {
    localCapabilities.value = { ...piCapabilities.value }
  }
})

async function updateCapabilities(patch: Partial<LocalCapabilities>): Promise<void> {
  if (saving.value) return
  saving.value = true
  errorText.value = null
  const prev = { ...localCapabilities.value }
  // 乐观更新：失败回滚
  localCapabilities.value = { ...localCapabilities.value, ...patch }
  try {
    const res = await fetch('/api/pi/capabilities', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(localCapabilities.value)
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const body = (await res.json()) as LocalCapabilities
    applyPiCapabilities(body)
    localCapabilities.value = body
  } catch (error) {
    localCapabilities.value = prev
    errorText.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

const agentSkills = computed({
  get: () => localCapabilities.value.agentSkills,
  set: (next: boolean) => void updateCapabilities({ agentSkills: next })
})

const builtinTools = computed({
  get: () => localCapabilities.value.builtinTools,
  set: (next: LocalCapabilities['builtinTools']) => void updateCapabilities({ builtinTools: next })
})

// P2-11：studio 文件夹入口。当前 fork 尚未提供 Electron/Tauri IPC 桥让 UI
// 直接调 shell.openPath；浏览器环境也无 file:// 链接等价行为。采用降级策略：
// 显式展示路径文本 + 「复制路径」按钮——用户自行粘贴到资源管理器/终端/Finder
// 打开。后续打开文件夹通路就位后可在此 hook 上接，UI 与 i18n 不变。
//
// D2 起 userDir 随状态根走 = <OS 应用数据目录>/Dianjing/studio（resolveAppDataRoot
// 单源，与 Electron userData 同位）。浏览器侧无 IPC 解析绝对路径，按 UA 粗判
// 平台给出对应形态的展示路径（env 变量/`~` token 形态，资源管理器与 shell 均可
// 直接粘贴识别）；判不出的平台回退 Linux 形态。
const isWindowsUA = navigator.userAgent.includes('Windows')
const isMacUA = !isWindowsUA && navigator.userAgent.includes('Mac')
function platformStudioFolderPath(): string {
  if (isWindowsUA) return '%APPDATA%\\Dianjing\\studio'
  if (isMacUA) return '~/Library/Application Support/Dianjing/studio'
  return '~/.config/Dianjing/studio'
}
const studioFolderPath = platformStudioFolderPath()
const copyStatus = ref<'idle' | 'copied' | 'failed'>('idle')

async function copyStudioFolderPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(studioFolderPath)
    copyStatus.value = 'copied'
  } catch {
    copyStatus.value = 'failed'
  }
  // 1.2s 后回归 idle，避免状态文字长期残留
  setTimeout(() => {
    copyStatus.value = 'idle'
  }, 1200)
}

const copyStatusLabel = computed(() => {
  if (copyStatus.value === 'copied') return '已复制'
  if (copyStatus.value === 'failed') return '复制失败'
  return '复制路径'
})
</script>

<template>
  <!-- T96：章节标题 + 描述 + 分组容器（对齐 GeneralSettingsPanel 形态） -->
  <section class="flex flex-col gap-3" data-test-id="settings-agent-panel">
    <div>
      <h3 class="text-xs font-semibold text-surface">{{ msgs.agentCapabilitiesTitle }}</h3>
      <p class="mt-1 text-[11px] text-muted">{{ msgs.agentCapabilitiesDescription }}</p>
    </div>

    <!-- 内建工具三档位 -->
    <div class="flex flex-col rounded border border-border">
      <div class="px-3 py-2.5">
        <p class="text-[10px] text-muted">{{ msgs.builtinToolsLabel }}</p>
        <div class="mt-2 flex flex-col gap-2" data-test-id="settings-agent-builtin-tools">
          <label class="flex items-center gap-2">
            <input
              v-model="builtinTools"
              type="radio"
              name="agent-builtin-tools"
              value="off"
              class="size-3"
              :disabled="saving"
              data-test-id="settings-agent-tools-off"
            />
            <span class="text-[11px] text-surface">{{ msgs.builtinToolsOff }}</span>
          </label>
          <label class="flex items-center gap-2">
            <input
              v-model="builtinTools"
              type="radio"
              name="agent-builtin-tools"
              value="readonly"
              class="size-3"
              :disabled="saving"
              data-test-id="settings-agent-tools-readonly"
            />
            <span class="text-[11px] text-surface">{{ msgs.builtinToolsReadonly }}</span>
          </label>
          <label class="flex items-center gap-2">
            <input
              v-model="builtinTools"
              type="radio"
              name="agent-builtin-tools"
              value="full"
              class="size-3"
              :disabled="saving"
              data-test-id="settings-agent-tools-full"
            />
            <span class="text-[11px] text-surface">{{ msgs.builtinToolsFull }}</span>
          </label>
        </div>
      </div>
    </div>

    <!-- skill 系统开关（与内建工具解耦） -->
    <div class="flex flex-col rounded border border-border">
      <label class="flex items-center justify-between gap-4 px-3 py-2.5">
        <span>
          <span class="block text-xs text-surface">{{ msgs.agentSkillsLabel }}</span>
          <span class="block text-[10px] text-muted">{{ msgs.agentSkillsDescription }}</span>
        </span>
        <AppSwitch
          v-model="agentSkills"
          :label="msgs.agentSkillsLabel"
          :disabled="saving"
          data-test-id="settings-agent-skills-switch"
        />
      </label>
    </div>

    <p v-if="saving" class="text-[10px] text-muted" data-test-id="settings-agent-saving">
      {{ msgs.agentCapabilitiesSaving }}
    </p>
    <p
      v-if="errorText"
      class="text-[11px] text-red-400"
      data-test-id="settings-agent-error"
      role="alert"
    >
      {{ msgs.agentCapabilitiesError({ message: errorText }) }}
    </p>

    <!-- P2-11：Studio 资产扩展——自定义 workflow/profile 的落地入口 -->
    <div class="border-t border-border" />
    <SettingsSectionHeader>
      Studio 资产扩展
      <template #description>
        你的自定义 workflow / profile 放在应用数据目录
        <code>{{ studioFolderPath }}/</code> 下，以同名子目录包裹（<code
          >workflows/&lt;id&gt;/workflow.md</code
        >
        与 <code>profiles/&lt;id&gt;/profile.md</code>）。首跑时已自动复制
        <code>_example</code> 示例模板，复制后即可改名改写。
      </template>
    </SettingsSectionHeader>

    <SettingsGroup>
      <div class="flex items-center justify-between gap-4 px-3 py-2.5">
        <div class="min-w-0">
          <span class="block text-xs text-surface">Studio 文件夹路径</span>
          <Tip :label="studioFolderPath">
            <span
              class="mt-0.5 block truncate font-mono text-[10px] text-muted"
              data-test-id="settings-studio-folder-path"
              >{{ studioFolderPath }}</span
            >
          </Tip>
        </div>
        <button
          type="button"
          class="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-surface transition-colors hover:bg-panel-field disabled:opacity-50"
          :disabled="copyStatus !== 'idle'"
          data-test-id="settings-studio-folder-copy"
          @click="copyStudioFolderPath"
        >
          {{ copyStatusLabel }}
        </button>
      </div>
    </SettingsGroup>
  </section>
</template>
