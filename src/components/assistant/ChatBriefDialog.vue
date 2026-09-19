<script setup lang="ts">
/**
 * T66（决策②）：需求单大面板——详情编辑从 ChatContextBar popover 迁出为独立
 * dialog。蓝本 = 旧分支 feature/agent-backend BriefPanelDialog.vue（存档
 * doc/t66-ref-BriefPanelDialog.vue），适配当前仓：
 *
 *  - core 原语：brief-edit.ts（readBrief/updateBriefContent/updateMaterialCaption/
 *    removeBriefMaterial）+ brief.ts addBriefMaterialEntry（bytes 内部走
 *    figma.createImage 内容寻址入库）；桥 = makeFigmaFromStore。
 *  - 素材四能力：上传图片（useFileDialog → arrayBuffer → Uint8Array →
 *    addBriefMaterialFromUpload）、从画布选区添加（IMAGE fill 扫描——一律复制，
 *    无移动选择器，偏差已记录）、素材删除、缩略图（objectURL 面板级缓存 Map +
 *    关闭/卸载 revoke）。
 *  - 画布真相纪律：dialog 零自有事实源——打开/每次写回后 readBriefView 重读；
 *    brief 已删（missing）/结构不完整（broken）显式提示，不试图修复。
 *  - 草稿纪律 commit-before-act：@change 提交写回；素材增删等动作前先落盘
 *    未提交草稿（content/caption dirty 比较派生）。关闭即丢弃未提交草稿
 *    （蓝本同律——重开以画布为准）。
 *  - 每次写回 = 一次 undo 事务 + computeAllLayouts 排版结算（active-design.ts
 *    applyBriefMutation）——T65 排版错乱根因修复对素材结构变更同样生效。
 */
import { useFileDialog } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { RASTER_IMAGE_FILE_ACCEPT } from '@open-pencil/core/bytes'
import type { BriefView } from '@open-pencil/core/tools/fork/marketing/brief-edit'
import { useSelectionState } from '@open-pencil/vue'

import { piStudioManifest } from '@/app/ai/pi-backend/mode-selection'
import { getActiveEditorStoreOrNull } from '@/app/editor/active-store'
import { useForkPanels } from '@/app/i18n/fork'
import { toast } from '@/app/shell/ui'
import { AppDialogBody, AppDialogHeader, AppDialogRoot } from '@/components/ui/dialog'
import AppTextarea from '@/components/ui/input/AppTextarea.vue'

import {
  addBriefMaterialFromUpload,
  addBriefMaterialsFromSelection,
  briefDialogBriefId,
  briefDialogOpen,
  closeBriefDialog,
  findSelectionImageNodes,
  readBriefView,
  removeBriefMaterialEntry,
  saveBriefContent,
  saveMaterialCaption
} from './active-design'

const panelsText = useForkPanels()

/** missing = 目标节点已不在画布；broken = 在画布但结构不完整（readBrief null） */
type DialogState = { kind: 'ok'; view: BriefView } | { kind: 'broken' } | { kind: 'missing' }

const state = ref<DialogState>({ kind: 'missing' })
const view = computed(() => (state.value.kind === 'ok' ? state.value.view : null))
const contentDraft = ref('')
/** 素材标题草稿：entryId → 编辑中文本（整对象替换重建，不用动态 delete） */
const captionDrafts = ref<Record<string, string>>({})
const captionInputs = new Map<string, HTMLInputElement>()
const applyFailed = ref(false)

function refresh(): void {
  const store = getActiveEditorStoreOrNull()
  const briefId = briefDialogBriefId.value
  const next = store && briefId ? readBriefView(store, briefId) : null
  if (next) {
    state.value = { kind: 'ok', view: next }
    contentDraft.value = next.content
    captionDrafts.value = Object.fromEntries(
      next.materials.map((material) => [material.entryId, material.caption])
    )
    return
  }
  const onCanvas = !!(store && briefId && store.graph.getNode(briefId))
  state.value = onCanvas ? { kind: 'broken' } : { kind: 'missing' }
  contentDraft.value = ''
  captionDrafts.value = {}
}

// ── 缩略图：面板级 objectURL 缓存，关闭/卸载 revoke（蓝本 :59-78 范式） ──

const thumbUrls = new Map<string, string>()

function thumbURL(hash: string): string {
  const cached = thumbUrls.get(hash)
  if (cached) return cached
  const bytes = getActiveEditorStoreOrNull()?.getImage(hash)
  if (!bytes) return ''
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
  thumbUrls.set(hash, url)
  return url
}

function releaseThumbs(): void {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url)
  thumbUrls.clear()
}

watch(briefDialogOpen, (open) => {
  if (open) {
    applyFailed.value = false
    refresh()
  } else {
    releaseThumbs()
  }
})
onBeforeUnmount(releaseThumbs)

function onOpenChange(open: boolean): void {
  if (!open) closeBriefDialog()
}

// ── 草稿提交（commit-before-act：@change 提交；动作前 flush） ──

const savedTick = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | undefined

function flashSaved(): void {
  savedTick.value = true
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => {
    savedTick.value = false
  }, 1500)
}

async function commitContent(): Promise<void> {
  const store = getActiveEditorStoreOrNull()
  const current = view.value
  if (!store || !current) return
  if (contentDraft.value === current.content) return
  if (!(await saveBriefContent(store, current.briefId, contentDraft.value))) {
    toast.error(panelsText.value.briefSaveFailed)
    return
  }
  refresh()
  flashSaved()
}

async function commitCaption(entryId: string): Promise<void> {
  const store = getActiveEditorStoreOrNull()
  const current = view.value
  if (!store || !current) return
  const material = current.materials.find((entry) => entry.entryId === entryId)
  if (!material) return
  const caption = captionDrafts.value[entryId] ?? ''
  if (caption === material.caption) return
  if (!(await saveMaterialCaption(store, entryId, caption))) {
    toast.error(panelsText.value.briefSaveFailed)
    return
  }
  refresh()
  flashSaved()
}

/** 素材结构动作前落盘全部未提交草稿（内容 + 各标题） */
async function commitDrafts(): Promise<void> {
  await commitContent()
  const current = view.value
  if (!current) return
  for (const material of current.materials) {
    await commitCaption(material.entryId)
  }
}

// ── 素材四能力 ──

async function onRemoveMaterial(entryId: string): Promise<void> {
  const store = getActiveEditorStoreOrNull()
  if (!store || !view.value) return
  await commitDrafts()
  if (!(await removeBriefMaterialEntry(store, entryId))) {
    applyFailed.value = true
    return
  }
  applyFailed.value = false
  refresh()
  flashSaved()
}

const { open: pickImage, onChange: onFilesPicked } = useFileDialog({
  // 素材消费 = 光栅字节（figma.createImage 入库）——收 GIF/BMP 与全入口光栅面一致；
  // SVG 不入（素材管线无矢量化环节，canvaskit 解不了）
  accept: RASTER_IMAGE_FILE_ACCEPT,
  multiple: false
})
onFilesPicked(async (files) => {
  const file = files?.[0]
  const store = getActiveEditorStoreOrNull()
  const current = view.value
  if (!file || !store || !current) return
  await commitDrafts()
  const bytes = new Uint8Array(await file.arrayBuffer())
  // 空标题入库，随后聚焦新条目的标题输入框（蓝本 :127-138 范式）
  const entryId = await addBriefMaterialFromUpload(store, current.briefId, bytes)
  if (!entryId) {
    applyFailed.value = true
    return
  }
  applyFailed.value = false
  refresh()
  flashSaved()
  await nextTick()
  captionInputs.get(entryId)?.focus()
})

const { selectedIds } = useSelectionState()
const selectionImageCount = computed(() => {
  const store = getActiveEditorStoreOrNull()
  return store ? findSelectionImageNodes(store, selectedIds.value).length : 0
})

async function onAddFromSelection(): Promise<void> {
  const store = getActiveEditorStoreOrNull()
  const current = view.value
  if (!store || !current || selectionImageCount.value === 0) return
  await commitDrafts()
  const added = await addBriefMaterialsFromSelection(store, current.briefId)
  if (added === 0) {
    applyFailed.value = true
    return
  }
  applyFailed.value = false
  refresh()
  flashSaved()
}

function setCaptionInput(entryId: string, el: unknown): void {
  if (el instanceof HTMLInputElement) captionInputs.set(entryId, el)
  else captionInputs.delete(entryId)
}

/** 关联设计区条目 mode 投影（与 ChatContextBar 同 manifest 数据源） */
function modeLabel(modeId: string): string {
  return piStudioManifest.value?.modes.find((mode) => mode.id === modeId)?.label ?? modeId
}
</script>

<template>
  <AppDialogRoot
    :open="briefDialogOpen"
    size="lg"
    data-test-id="chat-brief-dialog"
    @update:open="onOpenChange"
  >
    <AppDialogHeader
      :heading="panelsText.briefDialogTitle"
      :description="panelsText.briefDialogDescription"
    />

    <AppDialogBody>
      <!-- 目标已不在画布（可能已被删除） -->
      <div
        v-if="state.kind === 'missing'"
        class="text-[11px] text-muted"
        data-test-id="chat-brief-dialog-missing"
      >
        {{ panelsText.briefDialogMissing }}
      </div>

      <!-- 结构不完整：显式提示，不试图修复 -->
      <div
        v-else-if="state.kind === 'broken'"
        class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200"
        data-test-id="chat-brief-dialog-broken"
      >
        {{ panelsText.briefOpenFailed }}
      </div>

      <template v-else-if="view">
        <!-- 内容区 -->
        <section>
          <div class="mb-1.5 flex items-center gap-2 text-xs font-semibold text-surface">
            <span>{{ panelsText.briefContent }}</span>
            <span
              v-if="savedTick"
              data-test-id="chat-brief-dialog-saved"
              class="font-normal text-green-400"
            >
              {{ panelsText.briefSaved }}
            </span>
          </div>
          <AppTextarea
            v-model="contentDraft"
            :rows="6"
            :placeholder="panelsText.briefContentPlaceholder"
            data-test-id="chat-brief-dialog-content"
            @change="commitContent"
          />
        </section>

        <!-- 素材区（上传 / 选区添加 / 删除 / 缩略图 + 标题） -->
        <section class="mt-4">
          <div class="mb-1.5 text-xs font-semibold text-surface">
            {{ panelsText.briefMaterials }}
          </div>
          <div v-if="view.materials.length === 0" class="mb-2 text-[11px] text-muted">
            {{ panelsText.briefEmptySection }}
          </div>
          <div
            v-for="material in view.materials"
            :key="material.entryId"
            class="mb-2 flex items-center gap-2"
            data-test-id="chat-brief-dialog-material"
          >
            <div
              class="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-input"
            >
              <img
                v-if="material.imageHash && thumbURL(material.imageHash)"
                :src="thumbURL(material.imageHash)"
                :alt="material.caption"
                class="size-full object-cover"
              />
              <icon-lucide-image v-else class="size-4 text-muted" />
            </div>
            <!-- 原生 input 而非 AppInput：:ref 需要拿到 HTMLInputElement 供
                 上传后聚焦新条目标题（蓝本 :118-121 范式） -->
            <input
              :ref="(el) => setCaptionInput(material.entryId, el)"
              v-model="captionDrafts[material.entryId]"
              type="text"
              class="min-w-0 flex-1 rounded-md border border-border bg-input px-2 py-1 text-xs text-surface placeholder:text-muted"
              :placeholder="panelsText.briefMaterialCaptionPlaceholder"
              data-test-id="chat-brief-dialog-caption"
              @change="commitCaption(material.entryId)"
            />
            <button
              type="button"
              class="shrink-0 rounded p-1 text-muted hover:bg-hover hover:text-surface"
              :aria-label="panelsText.briefMaterialRemove"
              data-test-id="chat-brief-dialog-remove-material"
              @click="onRemoveMaterial(material.entryId)"
            >
              <icon-lucide-trash-2 class="size-3.5" />
            </button>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover hover:text-surface"
              data-test-id="chat-brief-dialog-add-material"
              @click="pickImage()"
            >
              {{ panelsText.briefMaterialAdd }}
            </button>
            <button
              type="button"
              class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover hover:text-surface disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="selectionImageCount === 0"
              data-test-id="chat-brief-dialog-add-from-selection"
              @click="onAddFromSelection"
            >
              {{ panelsText.briefMaterialAddSelection({ count: selectionImageCount }) }}
            </button>
          </div>
        </section>

        <!-- AI 结论区（只读） -->
        <section class="mt-4">
          <div class="mb-1.5 text-xs font-semibold text-surface">
            {{ panelsText.briefConclusions }}
          </div>
          <div v-if="view.conclusions.length === 0" class="text-[11px] text-muted">
            {{ panelsText.briefEmptySection }}
          </div>
          <div
            v-for="(conclusion, index) in view.conclusions"
            v-else
            :key="index"
            class="py-0.5 text-[11px] text-surface"
          >
            · {{ conclusion.text }}
            <span v-if="conclusion.designName" class="text-[11px] text-muted">
              （{{ conclusion.designName }}）
            </span>
          </div>
        </section>

        <!-- 关联设计区（只读） -->
        <section class="mt-4">
          <div class="mb-1.5 text-xs font-semibold text-surface">
            {{ panelsText.briefDesigns }}
          </div>
          <div v-if="view.designs.length === 0" class="text-[11px] text-muted">
            {{ panelsText.briefEmptySection }}
          </div>
          <div
            v-for="design in view.designs"
            v-else
            :key="design.designId"
            class="truncate text-[11px] text-surface"
            :data-design-id="design.designId"
          >
            {{ design.name }}
            <span class="text-[11px] text-muted">{{ modeLabel(design.modeId) }}</span>
          </div>
        </section>
      </template>

      <p
        v-if="applyFailed"
        class="mt-3 text-[11px] text-red-400"
        data-test-id="chat-brief-dialog-error"
      >
        {{ panelsText.briefApplyFailed }}
      </p>
    </AppDialogBody>
  </AppDialogRoot>
</template>
