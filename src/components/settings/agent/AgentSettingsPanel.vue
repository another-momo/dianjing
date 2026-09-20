<!--
  T87：Agent 能力开关面板（settings 面板 ai 区下小节）。
  T96 重构（预研 §5.2）：章节标题 + 描述；builtinTools 三档 radio 组
  （off 无内建 / readonly 只读四件 / full SDK 默认全集）；agentSkills 开关
  带标签 + 描述（与 builtinTools 解耦，独控 skill 加载）。PUT 全量 body，
  乐观更新失败回滚；保存中禁输入。启动时按 piCapabilities 镜像初值。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { fetchStudioFolderPath, openPiStudioFolder } from '@/app/ai/pi-backend/client'
import { applyPiCapabilities, piCapabilities } from '@/app/ai/pi-backend/mode-selection'
import { useForkAgentCapabilities } from '@/app/i18n/fork'
import SettingsGroup from '@/components/settings/layout/SettingsGroup.vue'
import SettingsSectionHeader from '@/components/settings/layout/SettingsSectionHeader.vue'
import Tip from '@/components/ui/overlay/Tip.vue'

const msgs = useForkAgentCapabilities()

type LocalCapabilities = NonNullable<typeof piCapabilities.value>

const localCapabilities = ref<LocalCapabilities>(
  // 瞬态初值与 capabilities.ts DEFAULTS 对齐（manifest 拉取到达前的首帧）
  piCapabilities.value ?? { builtinTools: 'readonly', agentSkills: true }
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
// 主通路：onMounted 拉取 `GET /api/pi/studio-folder`——后端按真实 platform/env
// 计算展示形态（resolveStudioDirs + toDisplayPath，与图片本地留存 `dir` 同源：
// win32 → %APPDATA% 缩写；非 win32 → ~ 缩写；DIANJING_ROOT_DIR 隔离 / 临时目录
// 前缀不匹配时原样回绝对路径）。fetch 失败时回退到 UA 粗判形态——浏览器无
// IPC 时给出的最后兜底（路径常量与最终真值可能略有偏差，仅文案兜底用）。
const isWindowsUA = navigator.userAgent.includes('Windows')
const isMacUA = !isWindowsUA && navigator.userAgent.includes('Mac')
function fallbackStudioFolderPath(): string {
  if (isWindowsUA) return '%APPDATA%\\Dianjing\\workspace\\.agents'
  if (isMacUA) return '~/Library/Application Support/Dianjing/workspace/.agents'
  return '~/.config/Dianjing/workspace/.agents'
}
const studioFolderPath = ref(fallbackStudioFolderPath())
onMounted(async () => {
  try {
    const result = await fetchStudioFolderPath()
    studioFolderPath.value = result.dir
  } catch (error) {
    // 留 warn 供诊断（no-silent-catch 纪律，ChatPanel 同款）；fetch 失败回退
    // UA 兜底形态，不打断面板
    console.warn('[settings] 自定义拓展目录拉取失败，回退 UA 兜底形态：', error)
  }
})
// ai-panel-ux-consolidation：按钮态机——idle 默认「打开文件夹」；ok=true
// 显示「已打开」1.2s 后回归；ok=false 或 fetch 异常时回退「复制路径」三态
// （copyStatus 的 copied/failed 文案沿用）。调用语义同一按钮，统一从
// handleOpenOrCopy 出发。
const openStatus = ref<'idle' | 'opened' | 'copying' | 'copied' | 'failed'>('idle')

async function copyStudioFolderPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(studioFolderPath.value)
    openStatus.value = 'copied'
  } catch {
    openStatus.value = 'failed'
  }
  // 1.2s 后回归 idle，避免状态文字长期残留
  setTimeout(() => {
    openStatus.value = 'idle'
  }, 1200)
}

async function handleOpenOrCopy(): Promise<void> {
  // 客户端 fetch 调用；若后端 ok:false 或 fetch 异常，回退旧复制行为
  const result = await openPiStudioFolder()
  if (result.ok) {
    openStatus.value = 'opened'
    setTimeout(() => {
      openStatus.value = 'idle'
    }, 1200)
    return
  }
  await copyStudioFolderPath()
}

const openStatusLabel = computed(() => {
  if (openStatus.value === 'opened') return msgs.value.customExtensionsOpened
  if (openStatus.value === 'copied') return msgs.value.customExtensionsCopied
  if (openStatus.value === 'failed') return msgs.value.customExtensionsCopyFailed
  return msgs.value.customExtensionsOpen
})

const openStatusDisabled = computed(() => openStatus.value !== 'idle')
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

    <!-- ai-panel-ux-consolidation：自定义拓展——三类资产（workflow/profile/skill）同根 -->
    <div class="border-t border-border" />
    <SettingsSectionHeader>
      {{ msgs.customExtensionsTitle }}
      <template #description>{{ msgs.customExtensionsDescription }}</template>
    </SettingsSectionHeader>

    <SettingsGroup>
      <div class="flex items-center justify-between gap-4 px-3 py-2.5">
        <div class="min-w-0">
          <span class="block text-xs text-surface">{{ msgs.customExtensionsFolderLabel }}</span>
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
          :disabled="openStatusDisabled"
          data-test-id="settings-studio-folder-open"
          @click="handleOpenOrCopy"
        >
          {{ openStatusLabel }}
        </button>
      </div>
    </SettingsGroup>
  </section>
</template>
