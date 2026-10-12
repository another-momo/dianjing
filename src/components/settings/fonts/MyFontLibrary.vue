<!--
  字体设置面板第一段：用户已安装字体库。

  - 数据面：fetchInstalledFonts()（走 pi-backend 字库端点列族聚合视图）。
  - bundled 段同时调 fontManager.listFamilyOptions() 过滤 source==='bundled'，
    避免「装入应用但没在用户库」冗余。
  - 安装：Electron 走桌面选择对话框（拿绝对路径后逐一 readElectronFile），
    浏览器形态走 <input type="file" multiple>。两条路径都经 installLocalFont
    校验 + 可选 woff2 转码，再提交到 pi-backend install 端点。
-->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { fontManager } from '@open-pencil/core/text'
import type { FontFamilyOption } from '@open-pencil/core/text'
import { installLocalFont } from '@open-pencil/core/text/font/installed/install'

/**
 * woff2 → sfnt 转码封装懒加载：wasm 体积大（约 315KB）不进首屏 bundle。
 * 加载失败（如纯浏览器形态无法解析 node:module）时返回 null，installLocalFont
 * 会以 unsupported-container 拒收 woff2 文件——UI 提示用户改用 ttf/otf。
 */
let transcodeImpl: ((bytes: Uint8Array) => Promise<Uint8Array>) | null = null
async function loadTranscoder(): Promise<typeof transcodeImpl> {
  if (transcodeImpl) return transcodeImpl
  try {
    const mod = await import('@open-pencil/core/text/font/installed/woff2')
    transcodeImpl = mod.transcodeWoff2ToSfnt
  } catch {
    transcodeImpl = null
  }
  return transcodeImpl
}

import {
  deleteInstalledFont,
  fetchInstalledFonts,
  installFontBytes,
  type FamilyView
} from '@/app/ai/pi-backend/client-fonts'
import { userLibraryRevision } from '@/app/editor/fonts'
import { useForkFonts } from '@/app/i18n/fork'
import { isElectron } from '@/app/shell/electron'
import { chooseElectronOpenPaths, readElectronFile } from '@/app/shell/electron-file-channel'
import { toast } from '@/app/shell/ui'
import AppButton from '@/components/ui/button/AppButton.vue'
import AppConfirmationDialog from '@/components/ui/dialog/AppConfirmationDialog.vue'
import AppPlaceholder from '@/components/ui/feedback/AppPlaceholder.vue'

const forkMsgs = useForkFonts()

interface DisplayFamily extends FamilyView {
  /** UI 呈现用：来自列表时的展示名（如有），否则 fallback 到 family */
  displayName?: string
  /** 通过对照 core 列表得到：'user'（用户安装）/ 'bundled'（内置兜底） */
  source: 'user' | 'bundled'
  /** 安装媒体形态：sfnt=ttf/otf；坏字体 = 可疑字段 */
  healthy: boolean
}

const INSTALL_CONFIRM_KEY = 'op-font-install-confirmed:v1'
const loading = ref(false)
const families = ref<DisplayFamily[]>([])
const installBusy = ref(false)
const installConfirmOpen = ref(false)
const installConfirmChecked = ref(false)
const installPathsPending = ref<File[] | null>(null)
const uninstallOpen = ref(false)
const uninstallTarget = ref<DisplayFamily | null>(null)
const uninstallStyleKey = ref<string | null>(null)

const SAMPLE_TEXT = 'Aa 你好 一一 '

const SOURCE_LABEL_KEY = {
  user: 'fontsSourceUser',
  bundled: 'fontsSourceBundled'
} as const

async function loadLibrary(): Promise<void> {
  loading.value = true
  try {
    const [installed, list] = await Promise.all([
      fetchInstalledFonts(),
      fontManager.listFamilyOptions({ includeDisabled: true })
    ])
    const installedNames = new Set(installed.map((view) => view.family))
    const userRows = installed.map<DisplayFamily>((view) => ({
      ...view,
      displayName: view.displayName,
      source: 'user' as const,
      healthy: isHealthy(view)
    }))
    // bundled 段：用户库已覆盖的同名族不在 bundled 行重复展示
    const bundledRows = list
      .filter(
        (option: FontFamilyOption) =>
          option.source === 'bundled' && !installedNames.has(option.family)
      )
      .map<DisplayFamily>((option) => ({
        family: option.family,
        displayName: option.displayName,
        styles: [],
        totalSize: 0,
        installedAt: 0,
        source: 'bundled' as const,
        healthy: true
      }))
    families.value = [
      ...userRows.sort((a, b) => a.family.localeCompare(b.family)),
      ...bundledRows.sort((a, b) => a.family.localeCompare(b.family))
    ]
  } finally {
    loading.value = false
  }
}

function isHealthy(view: FamilyView): boolean {
  // manifest 校验已保证 variable → wghtRange 必填；此处仅查空族/零字节
  return view.styles.length > 0 && view.totalSize > 0
}

const badFamilies = computed(() => families.value.filter((family) => !family.healthy))

function previewFontFamily(family: string): string {
  return `'${family}', sans-serif`
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isConfirmCleared(): boolean {
  if (typeof window === 'undefined') return true
  return window.localStorage.getItem(INSTALL_CONFIRM_KEY) === '1'
}

function markConfirmed(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(INSTALL_CONFIRM_KEY, '1')
  }
}

async function pickFiles(): Promise<File[]> {
  if (isElectron()) {
    const paths = await chooseElectronOpenPaths(true, [
      { name: 'Font files', extensions: FONT_ACCEPT_EXTENSIONS }
    ])
    if (paths.length === 0) return []
    const reads: File[] = []
    for (const path of paths) {
      const result = await readElectronFile(path)
      if (!result) continue
      const bytes = new Uint8Array(result.data)
      reads.push(new File([bytes], result.name, { type: 'application/octet-stream' }))
    }
    return reads
  }
  return openWebPicker()
}

const FONT_ACCEPT_EXTENSIONS = ['ttf', 'otf', 'woff', 'woff2']

function openWebPicker(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = FONT_ACCEPT_EXTENSIONS.map((extension) => `.${extension}`).join(',')
    input.style.display = 'none'
    const cleanup = () => {
      input.remove()
    }
    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : []
      cleanup()
      resolve(files)
    })
    document.body.appendChild(input)
    input.click()
  })
}

async function handleInstallClick() {
  const targets = await pickFiles()
  if (targets.length === 0) return
  if (!isConfirmCleared()) {
    installPathsPending.value = targets
    installConfirmChecked.value = false
    installConfirmOpen.value = true
    return
  }
  await runInstall(targets)
}

async function onConfirmInstall() {
  if (!installConfirmChecked.value) return
  markConfirmed()
  installConfirmOpen.value = false
  const targets = installPathsPending.value
  installPathsPending.value = null
  if (targets && targets.length > 0) await runInstall(targets)
}

function onCancelInstall() {
  installConfirmOpen.value = false
  installPathsPending.value = null
}

// X / overlay / Escape 关闭对话框不触发 @cancel——open 变 false 即清 pending，
// 防第二次安装把上次的文件数组接着堆
watch(installConfirmOpen, (open) => {
  if (!open) installPathsPending.value = null
})

async function runInstall(targets: File[]) {
  installBusy.value = true
  let ok = 0
  let fail = 0
  let firstReason = ''
  const transcode = await loadTranscoder()
  try {
    for (const file of targets) {
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      const result = await installLocalFont(bytes, {
        transcode: transcode ?? undefined,
        post: async (bytes) => {
          await installFontBytes(bytes)
        }
      })
      if (result.ok) {
        ok++
      } else {
        fail++
        if (!firstReason) firstReason = result.detail ?? result.reason
      }
    }
  } finally {
    installBusy.value = false
  }
  if (fail === 0) {
    toast.info(forkMsgs.value.fontsInstallResultOk({ ok }))
  } else {
    toast.error(
      forkMsgs.value.fontsInstallResult({ ok, fail }) + (firstReason ? ` · ${firstReason}` : '')
    )
  }
  userLibraryRevision.value++
  await loadLibrary()
}

function openUninstall(family: DisplayFamily, styleKey?: string) {
  uninstallTarget.value = family
  uninstallStyleKey.value = styleKey ?? null
  uninstallOpen.value = true
}

async function onConfirmUninstall() {
  const target = uninstallTarget.value
  const styleKey = uninstallStyleKey.value
  uninstallOpen.value = false
  uninstallTarget.value = null
  uninstallStyleKey.value = null
  if (!target) return
  if (target.source !== 'user') return
  try {
    await deleteInstalledFont(target.family, styleKey ?? undefined)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    toast.error(detail)
    return
  }
  userLibraryRevision.value++
  await loadLibrary()
}

function onCancelUninstall() {
  uninstallOpen.value = false
  uninstallTarget.value = null
  uninstallStyleKey.value = null
}

async function removeBadFamily(family: DisplayFamily) {
  if (family.source !== 'user') return
  try {
    await deleteInstalledFont(family.family)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    toast.error(detail)
    return
  }
  userLibraryRevision.value++
  await loadLibrary()
}

onMounted(() => {
  void loadLibrary()
})
</script>

<template>
  <section class="flex flex-col gap-3" data-test-id="fonts-my-library">
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-xs font-semibold text-surface">{{ forkMsgs.fontsMyLibrary }}</h3>
      <AppButton
        type="button"
        color="primary"
        variant="solid"
        size="xs"
        :disabled="installBusy"
        data-test-id="fonts-install-button"
        @click="handleInstallClick"
      >
        {{ forkMsgs.fontsInstallLocal }}
      </AppButton>
    </div>

    <p
      v-if="badFamilies.length > 0"
      class="flex items-center justify-between gap-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-surface"
      data-test-id="fonts-bad-banner"
    >
      <span>{{ forkMsgs.fontsBadFamilyBanner({ count: badFamilies.length }) }}</span>
      <span class="flex flex-wrap gap-1">
        <AppButton
          v-for="family in badFamilies"
          :key="family.family"
          type="button"
          color="neutral"
          variant="soft"
          size="xs"
          data-test-id="fonts-bad-family-remove"
          @click="removeBadFamily(family)"
        >
          {{ family.family }}
        </AppButton>
      </span>
    </p>

    <AppPlaceholder v-if="loading" :label="forkMsgs.fontsLoading" />
    <AppPlaceholder v-else-if="families.length === 0" :label="forkMsgs.fontsEmpty" />
    <div v-else class="flex flex-col gap-2">
      <article
        v-for="family in families"
        :key="family.family"
        :data-source="family.source"
        class="flex flex-col gap-2 rounded border border-border p-3"
        data-test-id="fonts-library-card"
      >
        <div class="flex items-baseline justify-between gap-2">
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-surface">
              {{ family.displayName ?? family.family }}
            </p>
            <p
              v-if="family.displayName && family.displayName !== family.family"
              class="truncate text-[9px] text-muted"
            >
              {{ family.family }}
            </p>
          </div>
          <span
            class="rounded bg-input px-1.5 py-0.5 text-[9px] uppercase text-muted"
            :data-test-id="`fonts-library-source-${family.family}`"
          >
            {{ forkMsgs[SOURCE_LABEL_KEY[family.source]] }}
          </span>
        </div>

        <div
          class="rounded bg-surface-alt px-2 py-1.5 text-base leading-snug"
          :style="{ fontFamily: previewFontFamily(family.family) }"
          data-test-id="fonts-library-sample"
        >
          {{ SAMPLE_TEXT }}
        </div>

        <div
          v-if="family.source === 'user' && family.styles.length > 0"
          class="flex flex-col gap-1 text-[10px] text-muted"
          data-test-id="fonts-library-styles"
        >
          <div
            v-for="style in family.styles"
            :key="style.key"
            class="flex items-center justify-between gap-2"
            data-test-id="fonts-library-style-row"
          >
            <span class="min-w-0 truncate">
              {{ style.key }} · {{ style.weight }}{{ style.italic ? ' italic' : '' }}
              <span
                v-if="style.variable"
                class="ml-1 rounded bg-input px-1 py-0.5 text-[9px] uppercase text-muted"
              >
                {{ forkMsgs.fontsVariableBadge }}
              </span>
            </span>
            <AppButton
              type="button"
              color="neutral"
              variant="ghost"
              size="xs"
              data-test-id="fonts-library-style-remove"
              @click="openUninstall(family, style.key)"
            >
              {{ forkMsgs.fontsUninstallFamily }}
            </AppButton>
          </div>
        </div>

        <div class="flex items-center justify-between gap-2 text-[9px] text-muted">
          <span v-if="family.source === 'user'">{{ formatBytes(family.totalSize) }}</span>
          <span v-else>—</span>
          <AppButton
            v-if="family.source === 'user'"
            type="button"
            color="neutral"
            variant="soft"
            size="xs"
            data-test-id="fonts-library-family-remove"
            @click="openUninstall(family)"
          >
            {{ forkMsgs.fontsUninstallFamily }}
          </AppButton>
        </div>
      </article>
    </div>

    <p class="text-[10px] leading-relaxed text-muted" data-test-id="fonts-storage-hint">
      {{ forkMsgs.fontsStorageHint }}
    </p>

    <AppConfirmationDialog
      v-model:open="installConfirmOpen"
      :heading="forkMsgs.fontsInstallLocal"
      :description="forkMsgs.fontsInstallConfirm"
      :cancel-label="forkMsgs.fontsCancel"
      :confirm-label="forkMsgs.fontsInstallLocal"
      :confirm-disabled="!installConfirmChecked"
      @cancel="onCancelInstall"
      @confirm="onConfirmInstall"
    >
      <label class="mt-2 flex items-start gap-2 text-[10px] text-surface">
        <input
          v-model="installConfirmChecked"
          type="checkbox"
          class="mt-0.5 size-3 accent-accent"
          data-test-id="fonts-install-confirm-checkbox"
        />
        <span>{{ forkMsgs.fontsInstallConfirm }}</span>
      </label>
    </AppConfirmationDialog>

    <AppConfirmationDialog
      v-model:open="uninstallOpen"
      tone="danger"
      :heading="forkMsgs.fontsUninstallFamily"
      :description="
        uninstallTarget && uninstallStyleKey
          ? `${uninstallTarget.displayName ?? uninstallTarget.family} · ${uninstallStyleKey}`
          : uninstallTarget
            ? forkMsgs.fontsUninstallConfirm({
                family: uninstallTarget.displayName ?? uninstallTarget.family,
                count: uninstallTarget.styles.length
              })
            : ''
      "
      :cancel-label="forkMsgs.fontsCancel"
      :confirm-label="forkMsgs.fontsUninstallFamily"
      @cancel="onCancelUninstall"
      @confirm="onConfirmUninstall"
    />
  </section>
</template>
