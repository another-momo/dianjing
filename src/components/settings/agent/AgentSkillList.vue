<!--
  管理面：已安装 skill 列表（单件启停）——分两组：
   - 顶部「已安装 skill」标题 + 描述
   - 列表行：skill 名 + 描述（截断 + Tip 悬浮）+ 来源徽标（用户/内置）+ AppSwitch 单件启停
   - 行可展开详情：完整描述、来源层
   - 空态：无已安装 skill 引导文案
  乐观 toggle 失败回滚 + 错误提示（由父 AgentSettingsPanel 的 saving/errorText 模式兜底）；
  本组件只管 skill 单件 toggle 的乐观/回滚，顶部 saving/errorText 由父面板管。
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'

import {
  type ManagedSkillEntry,
  fetchPiSkills,
  setPiDisabledSkills
} from '@/app/ai/pi-backend/client'
import { useForkAgentCapabilities } from '@/app/i18n/fork'
import Tip from '@/components/ui/overlay/Tip.vue'

const msgs = useForkAgentCapabilities()

const skills = ref<ManagedSkillEntry[]>([])
const saving = ref(false)
const errorText = ref<string | null>(null)
const expandedNames = ref<Set<string>>(new Set())
// 乐观 toggle 期内的目标名——防止连点期间回滚与重发撞车
const pendingNames = ref<Set<string>>(new Set())

onMounted(async () => {
  await reload()
})

async function reload(): Promise<void> {
  try {
    const result = await fetchPiSkills()
    skills.value = result.skills
  } catch (error) {
    // 列表拉取失败留 errorText——面板可见但不阻断（空态由列表空渲染）
    errorText.value = error instanceof Error ? error.message : String(error)
  }
}

function isExpanded(name: string): boolean {
  return expandedNames.value.has(name)
}

function toggleExpanded(name: string): void {
  if (expandedNames.value.has(name)) {
    expandedNames.value.delete(name)
  } else {
    expandedNames.value.add(name)
  }
  // 触发响应式刷新（Set 引用替换）
  expandedNames.value = new Set(expandedNames.value)
}

function sourceLabel(source: ManagedSkillEntry['source']): string {
  return source === 'user'
    ? msgs.value.installedSkillsSourceUser
    : msgs.value.installedSkillsSourceBuiltin
}

async function toggleSkill(skill: ManagedSkillEntry, next: boolean): Promise<void> {
  if (saving.value) return
  if (pendingNames.value.has(skill.name)) return
  const prevSkills = skills.value.map((s) => ({ ...s }))
  // 乐观更新：目标条目 enabled 翻位
  skills.value = skills.value.map((s) => (s.name === skill.name ? { ...s, enabled: next } : s))
  saving.value = true
  pendingNames.value.add(skill.name)
  pendingNames.value = new Set(pendingNames.value)
  errorText.value = null
  try {
    const newDisabled = new Set(skills.value.filter((s) => !s.enabled).map((s) => s.name))
    await setPiDisabledSkills([...newDisabled])
  } catch (error) {
    skills.value = prevSkills
    errorText.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
    pendingNames.value.delete(skill.name)
    pendingNames.value = new Set(pendingNames.value)
  }
}
</script>

<template>
  <section class="flex flex-col gap-3" data-test-id="settings-agent-skills-section">
    <div>
      <h3 class="text-xs font-semibold text-surface">{{ msgs.installedSkillsTitle }}</h3>
      <p class="mt-1 text-[11px] text-muted">{{ msgs.installedSkillsDescription }}</p>
    </div>

    <div
      v-if="skills.length === 0 && !errorText"
      class="flex flex-col rounded border border-border px-3 py-3"
      data-test-id="settings-agent-skills-empty"
    >
      <span class="text-[11px] text-muted">{{ msgs.installedSkillsEmpty }}</span>
    </div>

    <div
      v-else
      class="flex flex-col divide-y divide-border rounded border border-border"
      data-test-id="settings-agent-skills-list"
    >
      <div
        v-for="skill in skills"
        :key="skill.name"
        class="flex flex-col px-3 py-2.5"
        :data-test-id="`settings-agent-skill-row-${skill.name}`"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="truncate text-left text-xs text-surface hover:underline"
                :aria-expanded="isExpanded(skill.name)"
                :data-test-id="`settings-agent-skill-toggle-${skill.name}`"
                @click="toggleExpanded(skill.name)"
              >
                {{ skill.name }}
              </button>
              <span
                class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted"
                :data-test-id="`settings-agent-skill-source-${skill.name}`"
              >
                {{ sourceLabel(skill.source) }}
              </span>
            </div>
            <Tip v-if="skill.description" :label="skill.description">
              <p
                class="mt-0.5 truncate text-[10px] text-muted"
                :data-test-id="`settings-agent-skill-description-${skill.name}`"
              >
                {{ skill.description }}
              </p>
            </Tip>
          </div>
          <AppSwitch
            :model-value="skill.enabled"
            :label="
              skill.enabled
                ? msgs.installedSkillsDisabledLabel({ name: skill.name })
                : msgs.installedSkillsEnabledLabel({ name: skill.name })
            "
            :disabled="saving"
            :data-test-id="`settings-agent-skill-switch-${skill.name}`"
            @update:model-value="(next) => toggleSkill(skill, next)"
          />
        </div>
        <div
          v-if="isExpanded(skill.name)"
          class="mt-2 rounded border border-border bg-panel-field/40 px-3 py-2"
          :data-test-id="`settings-agent-skill-details-${skill.name}`"
        >
          <p class="text-[10px] text-muted">
            {{ skill.description || '—' }}
          </p>
          <p class="mt-1 text-[10px] text-muted">
            {{ sourceLabel(skill.source) }}
          </p>
        </div>
      </div>
    </div>

    <p
      v-if="errorText"
      class="text-[11px] text-red-400"
      data-test-id="settings-agent-skills-error"
      role="alert"
    >
      {{ msgs.agentCapabilitiesError({ message: errorText }) }}
    </p>
  </section>
</template>
