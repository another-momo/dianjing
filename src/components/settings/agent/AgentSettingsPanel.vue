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
  </section>
</template>
