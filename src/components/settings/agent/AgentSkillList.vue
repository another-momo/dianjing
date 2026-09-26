<!--
  管理面：已安装 skill 列表（单件启停 + 分层删除 + 诊断块）——分四块：
   - 顶部「已安装 skill」标题 + 描述
   - 诊断块：仅在 diagnostics 非空时渲染，解释「为什么我放进 skills 目录的件没出现在清单里」
   - 列表行：skill 名 + 描述（截断 + Tip）+ 来源徽标（用户/内置）+ AppSwitch 单件启停
              + 用户层额外出删除按钮（内置行不出——分层语义刻意）
   - 行可展开详情：完整描述、来源层
   - 空态：无已安装 skill 引导文案
   - 删除确认：复用 AppAlertDialogRoot（与 MCP 连接管理面同款原语），确认后调 deletePiSkill
  乐观 toggle 失败回滚 + 错误提示（由父 AgentSettingsPanel 的 saving/errorText 模式兜底）；
  本组件只管 skill 单件 toggle 的乐观/回滚 + 删除流程，顶部 saving/errorText 由父面板管。
-->
<script setup lang="ts">
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogTitle
} from 'reka-ui'
import { onMounted, ref } from 'vue'

import {
  type ManagedSkillEntry,
  type SkillDiagnosticEntry,
  deletePiSkill,
  fetchPiSkills,
  setPiDisabledSkills
} from '@/app/ai/pi-backend/client'
import { useForkAgentCapabilities } from '@/app/i18n/fork'
import AppButton from '@/components/ui/button/AppButton.vue'
import { AppAlertDialogRoot, AppDialogFooter, AppDialogHeader } from '@/components/ui/dialog'
import Tip from '@/components/ui/overlay/Tip.vue'

const msgs = useForkAgentCapabilities()

const skills = ref<ManagedSkillEntry[]>([])
const diagnostics = ref<SkillDiagnosticEntry[]>([])
const saving = ref(false)
const errorText = ref<string | null>(null)
const expandedNames = ref<Set<string>>(new Set())
// 乐观 toggle 期内的目标名——防止连点期间回滚与重发撞车
const pendingNames = ref<Set<string>>(new Set())
// 分层删除：单条删除进行中的目标名 + 待确认删除的目标
const deletingName = ref<string | null>(null)
const deleteCandidate = ref<ManagedSkillEntry | null>(null)
// 对话框开关独立于 candidate——确认点击会先走 reka 关框回调（update:open(false)），
// 若 open 由 candidate 派生，confirmDelete 执行时 candidate 已被清空、静默空转
const deleteOpen = ref(false)

onMounted(async () => {
  await reload()
})

async function reload(): Promise<void> {
  try {
    const result = await fetchPiSkills()
    skills.value = result.skills
    diagnostics.value = result.diagnostics
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
    errorText.value = msgs.value.agentCapabilitiesError({
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    saving.value = false
    pendingNames.value.delete(skill.name)
    pendingNames.value = new Set(pendingNames.value)
  }
}

function startDelete(skill: ManagedSkillEntry): void {
  if (skill.source !== 'user') return
  deleteCandidate.value = skill
  deleteOpen.value = true
}

function cancelDelete(): void {
  deleteOpen.value = false
  deleteCandidate.value = null
  deletingName.value = null
}

function onDeleteDialogOpenChange(open: boolean): void {
  // 只同步开关——candidate 的清理由 cancelDelete / confirmDelete 各自负责
  deleteOpen.value = open
}

async function confirmDelete(): Promise<void> {
  const target = deleteCandidate.value
  if (!target) return
  deletingName.value = target.name
  errorText.value = null
  try {
    await deletePiSkill(target.name)
    deleteCandidate.value = null
    deletingName.value = null
    await reload()
  } catch (error) {
    deletingName.value = null
    deleteCandidate.value = null
    errorText.value = msgs.value.installedSkillsDeleteFailed({
      name: target.name,
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

function diagnosticMessage(d: SkillDiagnosticEntry): string {
  const name = d.skillName ?? ''
  switch (d.code) {
    case 'parse-failed':
      return msgs.value.installedSkillsDiagnosticParseFailed({ skillName: name })
    case 'name-invalid':
      return msgs.value.installedSkillsDiagnosticNameInvalid({ skillName: name })
    case 'no-description':
      return msgs.value.installedSkillsDiagnosticNoDescription({ skillName: name })
    case 'shadowed-by-user':
      return msgs.value.installedSkillsDiagnosticShadowedByUser({ skillName: name })
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
      v-if="diagnostics.length > 0"
      class="flex flex-col gap-1 rounded border border-border bg-panel-field/40 px-3 py-2"
      data-test-id="settings-agent-skills-diagnostics"
    >
      <p class="text-[11px] font-medium text-surface">
        {{ msgs.installedSkillsDiagnosticsTitle }}
      </p>
      <ul class="flex flex-col gap-0.5">
        <li
          v-for="(d, idx) in diagnostics"
          :key="`${d.code}-${d.skillName ?? ''}`"
          class="text-[10px] text-muted"
          :data-test-id="`settings-agent-skill-diagnostic-${idx}`"
        >
          <span class="mr-1 text-warning">!</span>{{ diagnosticMessage(d) }}
        </li>
      </ul>
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
          <div class="flex items-center gap-2">
            <AppButton
              v-if="skill.source === 'user'"
              color="neutral"
              variant="ghost"
              :aria-label="msgs.installedSkillsDeleteLabel({ name: skill.name })"
              :data-test-id="`settings-agent-skill-delete-${skill.name}`"
              @click="startDelete(skill)"
            >
              {{ msgs.installedSkillsDeleteAction }}
            </AppButton>
            <AppSwitch
              :model-value="skill.enabled"
              :label="
                skill.enabled
                  ? msgs.installedSkillsDisabledLabel({ name: skill.name })
                  : msgs.installedSkillsEnabledLabel({ name: skill.name })
              "
              :disabled="saving"
              :data-test-id="`settings-agent-skill-switch-${skill.name}`"
              @update:model-value="(next: boolean) => toggleSkill(skill, next)"
            />
          </div>
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
      {{ errorText }}
    </p>

    <AppAlertDialogRoot :open="deleteOpen" @update:open="onDeleteDialogOpenChange">
      <AppDialogHeader
        :heading="msgs.installedSkillsDeleteConfirmTitle"
        :description="
          deleteCandidate
            ? msgs.installedSkillsDeleteConfirmDescription({ name: deleteCandidate.name })
            : ''
        "
        :show-close="false"
      >
        <template #title>
          <AlertDialogTitle as-child>
            <span>{{ msgs.installedSkillsDeleteConfirmTitle }}</span>
          </AlertDialogTitle>
        </template>
        <template #description>
          <AlertDialogDescription as-child>
            <span>{{
              deleteCandidate
                ? msgs.installedSkillsDeleteConfirmDescription({ name: deleteCandidate.name })
                : ''
            }}</span>
          </AlertDialogDescription>
        </template>
      </AppDialogHeader>
      <AppDialogFooter>
        <AlertDialogCancel as-child>
          <AppButton color="neutral" variant="ghost" @click="cancelDelete">
            {{ msgs.installedSkillsDeleteConfirmCancel }}
          </AppButton>
        </AlertDialogCancel>
        <AlertDialogAction as-child>
          <AppButton
            color="error"
            variant="solid"
            :loading="deletingName !== null"
            @click="confirmDelete"
          >
            {{ msgs.installedSkillsDeleteConfirmAction }}
          </AppButton>
        </AlertDialogAction>
      </AppDialogFooter>
    </AppAlertDialogRoot>
  </section>
</template>
