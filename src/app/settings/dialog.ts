import { ref } from 'vue'

export type SettingsSection = 'general' | 'ai' | 'media' | 'storage' | 'fonts'

/**
 * T97：打开设置面板时的深链锚点——引导门 deep-link 展开指定 provider 行（合并面板形态）。
 * 关闭时由调用方清空，避免下次打开残留旧锚点。
 */
export type SettingsDialogAnchor = { provider?: string }

export const settingsDialogOpen = ref(false)
export const settingsDialogSection = ref<SettingsSection>('general')

/** 当前打开的深链锚点；PiModelsPanel 在 onMounted/watch 读它展开对应行并聚焦 key 输入 */
export const settingsDialogAnchor = ref<SettingsDialogAnchor | null>(null)

export function openSettingsDialog(section?: SettingsSection, anchor?: SettingsDialogAnchor): void {
  if (section) settingsDialogSection.value = section
  settingsDialogAnchor.value = anchor ?? null
  settingsDialogOpen.value = true
}

export function closeSettingsDialog(): void {
  settingsDialogOpen.value = false
  settingsDialogAnchor.value = null
}
