<!--
  字体设置面板第二段：字体商店。

  - 数据面：fetchStoreServices / fetchStoreCatalog / installFromStore / fetchStoreTasks /
    cancelStoreTask / registerStoreService / deleteStoreService（走 pi-backend 字体商店端点）
  - 视图态：service-list 视图（注册表单 + 服务卡）/ catalog 视图（族列表 + 任务条）
  - 安装授权：复用「op-font-install-confirmed:v1」localStorage key——首次安装弹同款确认
    对话框（MyFontLibrary 的 installConfirm 模型），允许小组件内重复实现

  - 任务轮询：仅存在 running 任务时 1.5s 拉一次 fetchStoreTasks；组件卸载清 timer
  - 用户库联动：任务转 done → userLibraryRevision++（@/app/editor/fonts 既有导出）
-->
<script lang="ts">
/**
 * 已 toast 过的任务 id——模块级 Set：组件随 tab 切换销毁重建，实例级 Set 会让
 * 历史任务重复弹 toast。任务 id 是 UUID，会话内累积量可忽略。
 */
const notifiedTaskIds = new Set<string>()
</script>

<script setup lang="ts">
import { useLocalStorage } from '@vueuse/core'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import type {
  StoreCatalogFamily,
  StoreInstallTaskView,
  StoreServiceDescriptor,
  StoreServiceKind
} from '@/app/ai/pi-backend/client-fonts'
import {
  cancelStoreTask,
  deleteStoreService,
  fetchStoreCatalog,
  fetchStoreServices,
  fetchStoreTasks,
  installFromStore,
  registerStoreService
} from '@/app/ai/pi-backend/client-fonts'
import { userLibraryRevision } from '@/app/editor/fonts'
import { useForkFonts } from '@/app/i18n/fork'
import { toast } from '@/app/shell/ui'
import AppButton from '@/components/ui/button/AppButton.vue'
import AppConfirmationDialog from '@/components/ui/dialog/AppConfirmationDialog.vue'
import AppPlaceholder from '@/components/ui/feedback/AppPlaceholder.vue'
import AppProgress from '@/components/ui/feedback/AppProgress.vue'

const forkMsgs = useForkFonts()

const SERVICES_TITLE_KEY = 'fontsStoreServicesTitle'

interface RegisterFormState {
  name: string
  baseURL: string
  kind: StoreServiceKind
  apiKey: string
  busy: boolean
}

const INSTALL_CONFIRM_KEY = 'op-font-install-confirmed:v1'
const POLL_INTERVAL_MS = 1500

const services = ref<StoreServiceDescriptor[]>([])
const servicesLoading = ref(false)
const servicesError = ref<string | null>(null)
const deleteTarget = ref<StoreServiceDescriptor | null>(null)
// 对话框先于 confirm 关闭（reka DialogClose 同步语义）——open 与 target 必须分开持，
// 否则 close 回环先清掉 target，confirm 读到 null 直接早返。
const deleteDialogOpen = ref(false)

const registerForm = reactive<RegisterFormState>({
  name: '',
  baseURL: '',
  kind: 'standard',
  apiKey: '',
  busy: false
})

const activeService = ref<StoreServiceDescriptor | null>(null)
const catalog = ref<StoreCatalogFamily[] | null>(null)
const catalogError = ref<string | null>(null)
const catalogLoading = ref(false)
const catalogSearch = ref('')

const tasks = ref<StoreInstallTaskView[]>([])
const installingFamily = ref<string | null>(null)
const installConfirmOpen = ref(false)
const installConfirmChecked = ref(false)
const installConfirmFamily = ref<string | null>(null)
const pollTimer = ref<number | null>(null)

const filteredCatalog = computed(() => {
  const query = catalogSearch.value.trim().toLowerCase()
  const list = catalog.value ?? []
  if (query.length === 0) return list
  return list.filter(
    (f) =>
      f.family.toLowerCase().includes(query) ||
      (f.displayName !== undefined && f.displayName.toLowerCase().includes(query))
  )
})

const runningTasks = computed(() => tasks.value.filter((t) => t.status === 'running'))

type StoreKindLabelKey = 'fontsStoreServiceKindStandard' | 'fontsStoreServiceKindGfApi'

const kindOptions: { value: StoreServiceKind; labelKey: StoreKindLabelKey }[] = [
  { value: 'standard', labelKey: 'fontsStoreServiceKindStandard' },
  { value: 'gf-api', labelKey: 'fontsStoreServiceKindGfApi' }
]

async function loadServices(): Promise<void> {
  servicesLoading.value = true
  servicesError.value = null
  try {
    services.value = await fetchStoreServices()
  } catch (error) {
    servicesError.value = error instanceof Error ? error.message : String(error)
  } finally {
    servicesLoading.value = false
  }
}

async function loadTasks(): Promise<void> {
  try {
    tasks.value = await fetchStoreTasks()
    const hasRunning = runningTasks.value.length > 0
    if (hasRunning && pollTimer.value === null) {
      pollTimer.value = window.setInterval(() => void loadTasks(), POLL_INTERVAL_MS)
    } else if (!hasRunning && pollTimer.value !== null) {
      window.clearInterval(pollTimer.value)
      pollTimer.value = null
    }
    // 检测新完成的 task → toast + userLibraryRevision++
    for (const task of tasks.value) {
      if (task.status !== 'running' && !notifiedTaskIds.has(task.id)) {
        notifiedTaskIds.add(task.id)
        emitTaskToast(task)
      }
    }
  } catch (error) {
    // 拉任务失败时保持既有列表——不影响 UI，仅停轮询
    if (pollTimer.value !== null) {
      window.clearInterval(pollTimer.value)
      pollTimer.value = null
    }
    const detail = error instanceof Error ? error.message : String(error)
    console.warn(`[fonts-store] task poll failed: ${detail}`)
  }
}

function emitTaskToast(task: StoreInstallTaskView): void {
  const familyLabel = task.family
  const failedCount = task.failures.length
  if (task.status === 'cancelled') {
    // 取消是用户主动动作：info 提示 + 仍刷用户库（取消前可能已装部分样式）
    toast.info(
      forkMsgs.value.fontsStoreTaskCancelled({
        family: familyLabel,
        done: task.done,
        total: task.total
      })
    )
  } else if (failedCount === 0) {
    toast.info(forkMsgs.value.fontsStoreTaskDoneOk({ family: familyLabel, done: task.done }))
  } else if (failedCount >= task.total) {
    toast.error(forkMsgs.value.fontsStoreTaskFailedAll({ family: familyLabel }))
  } else {
    const firstReason = task.failures[0]?.reason ?? ''
    toast.warning(
      forkMsgs.value.fontsStoreTaskDonePartial({
        family: familyLabel,
        done: task.done - failedCount,
        fail: failedCount
      }) + (firstReason ? ` · ${firstReason}` : '')
    )
  }
  userLibraryRevision.value++
}

async function submitRegister(): Promise<void> {
  if (registerForm.busy) return
  if (registerForm.name.trim().length === 0 || registerForm.baseURL.trim().length === 0) return
  registerForm.busy = true
  try {
    const payload: { name: string; baseURL: string; kind: StoreServiceKind; apiKey?: string } = {
      name: registerForm.name.trim(),
      baseURL: registerForm.baseURL.trim(),
      kind: registerForm.kind
    }
    if (registerForm.kind === 'gf-api' && registerForm.apiKey.trim().length > 0) {
      payload.apiKey = registerForm.apiKey.trim()
    }
    const service = await registerStoreService(payload)
    services.value = [...services.value.filter((s) => s.id !== service.id), service]
    toast.info(forkMsgs.value.fontsStoreRegisterSuccess({ name: service.name }))
    registerForm.name = ''
    registerForm.baseURL = ''
    registerForm.apiKey = ''
    registerForm.kind = 'standard'
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    toast.error(forkMsgs.value.fontsStoreRegisterFailed({ reason: detail }))
  } finally {
    registerForm.busy = false
  }
}

function confirmDeleteService(service: StoreServiceDescriptor): void {
  if (service.builtin) return
  deleteTarget.value = service
  deleteDialogOpen.value = true
}

async function onConfirmDelete(): Promise<void> {
  const target = deleteTarget.value
  deleteDialogOpen.value = false
  deleteTarget.value = null
  if (!target || target.builtin) return
  try {
    await deleteStoreService(target.id)
    services.value = services.value.filter((s) => s.id !== target.id)
    if (activeService.value?.id === target.id) {
      activeService.value = null
      catalog.value = null
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    toast.error(forkMsgs.value.fontsStoreDeleteFailed({ reason: detail }))
  }
}

function onCancelDelete(): void {
  deleteDialogOpen.value = false
}

async function openService(service: StoreServiceDescriptor): Promise<void> {
  activeService.value = service
  catalog.value = null
  catalogError.value = null
  catalogSearch.value = ''
  await loadCatalog()
}

async function loadCatalog(): Promise<void> {
  if (!activeService.value) return
  catalogLoading.value = true
  catalogError.value = null
  try {
    catalog.value = await fetchStoreCatalog(activeService.value.id)
  } catch (error) {
    catalogError.value = error instanceof Error ? error.message : String(error)
  } finally {
    catalogLoading.value = false
  }
}

function backToServices(): void {
  activeService.value = null
  catalog.value = null
  catalogError.value = null
  catalogSearch.value = ''
}

const installConfirmed = useLocalStorage(INSTALL_CONFIRM_KEY, false)

function isConfirmCleared(): boolean {
  return installConfirmed.value
}

function markConfirmed(): void {
  installConfirmed.value = true
}

function startInstall(family: StoreCatalogFamily): void {
  if (installingFamily.value !== null) return
  if (!isConfirmCleared()) {
    installConfirmFamily.value = family.family
    installConfirmChecked.value = false
    installConfirmOpen.value = true
    return
  }
  void runInstall(family)
}

watch(installConfirmOpen, (open) => {
  if (!open) installConfirmFamily.value = null
})

async function onConfirmInstall(): Promise<void> {
  if (!installConfirmChecked.value) return
  markConfirmed()
  installConfirmOpen.value = false
  const familyName = installConfirmFamily.value
  installConfirmFamily.value = null
  if (!familyName || !catalog.value) return
  const target = catalog.value.find((f) => f.family === familyName)
  if (target) await runInstall(target)
}

function onCancelInstall(): void {
  installConfirmOpen.value = false
  installConfirmFamily.value = null
}

async function runInstall(family: StoreCatalogFamily): Promise<void> {
  if (!activeService.value) return
  installingFamily.value = family.family
  try {
    const result = await installFromStore({
      service: activeService.value.id,
      family: family.family
    })
    if (!result.shortCircuited) {
      toast.info(forkMsgs.value.fontsStoreTaskStarted({ family: family.family }))
    }
    await loadTasks()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    toast.error(detail)
  } finally {
    installingFamily.value = null
  }
}

async function cancelTask(taskId: string): Promise<void> {
  try {
    await cancelStoreTask(taskId)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    toast.error(detail)
    return
  }
  await loadTasks()
}

function truncateURL(url: string): string {
  if (url.length <= 48) return url
  return `${url.slice(0, 24)}…${url.slice(-20)}`
}

onMounted(() => {
  void loadServices()
  void loadTasks()
})

onBeforeUnmount(() => {
  if (pollTimer.value !== null) {
    window.clearInterval(pollTimer.value)
    pollTimer.value = null
  }
})

const TYPE_KEY: Record<StoreServiceKind, StoreKindLabelKey | ''> = {
  fontsource: '',
  standard: 'fontsStoreServiceKindStandard',
  'gf-api': 'fontsStoreServiceKindGfApi'
}

function kindLabel(kind: StoreServiceKind): string {
  const key = TYPE_KEY[kind]
  if (!key) return ''
  return forkMsgs.value[key]
}
</script>

<template>
  <section class="flex flex-col gap-3" data-test-id="fonts-store">
    <!-- 目录视图 -->
    <template v-if="activeService">
      <div class="flex items-center justify-between gap-2">
        <AppButton
          type="button"
          color="neutral"
          variant="soft"
          size="xs"
          data-test-id="fonts-store-catalog-back"
          @click="backToServices"
        >
          {{ forkMsgs.fontsStoreCatalogBack }}
        </AppButton>
        <span class="truncate text-[10px] text-muted" :title="activeService.baseURL">
          {{ activeService.name }} · {{ truncateURL(activeService.baseURL) }}
        </span>
      </div>

      <!-- 任务条：仅存在 running 任务时显示 -->
      <div
        v-if="runningTasks.length > 0"
        class="flex flex-col gap-2 rounded border border-border p-2"
        data-test-id="fonts-store-tasks"
      >
        <div
          v-for="task in runningTasks"
          :key="task.id"
          class="flex flex-col gap-1"
          :data-task-id="task.id"
        >
          <div class="flex items-center justify-between gap-2 text-[10px] text-surface">
            <span
              >{{ task.family }} ·
              {{ forkMsgs.fontsStoreTaskProgress({ done: task.done, total: task.total }) }}</span
            >
            <AppButton
              type="button"
              color="neutral"
              variant="soft"
              size="xs"
              :data-test-id="`fonts-store-task-cancel-${task.id}`"
              @click="cancelTask(task.id)"
            >
              {{ forkMsgs.fontsStoreTaskCancel }}
            </AppButton>
          </div>
          <AppProgress
            :amount="{ value: task.done, max: task.total }"
            :aria-label="`${task.family} ${task.done}/${task.total}`"
          />
        </div>
      </div>

      <input
        v-model="catalogSearch"
        type="text"
        :placeholder="forkMsgs.fontsStoreCatalogSearch"
        class="w-full rounded border border-input bg-surface px-2 py-1 text-xs text-surface outline-none focus:border-accent"
        data-test-id="fonts-store-catalog-search"
      />

      <AppPlaceholder v-if="catalogLoading" :label="forkMsgs.fontsStoreCatalogLoading" />
      <div
        v-else-if="catalogError"
        class="flex flex-col gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-surface"
        data-test-id="fonts-store-catalog-error"
      >
        <span>{{ forkMsgs.fontsStoreCatalogUnavailable }}</span>
        <AppButton
          type="button"
          color="neutral"
          variant="soft"
          size="xs"
          data-test-id="fonts-store-catalog-retry"
          @click="loadCatalog"
        >
          {{ forkMsgs.fontsStoreCatalogRetry }}
        </AppButton>
      </div>
      <AppPlaceholder
        v-else-if="filteredCatalog.length === 0"
        :label="forkMsgs.fontsStoreCatalogEmpty"
      />
      <div v-else class="flex flex-col gap-2" data-test-id="fonts-store-catalog-list">
        <article
          v-for="family in filteredCatalog"
          :key="family.family"
          class="flex flex-col gap-2 rounded border border-border p-3"
          :data-family="family.family"
          data-test-id="fonts-store-family-card"
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
              v-if="!family.license"
              class="rounded bg-input px-1.5 py-0.5 text-[9px] uppercase text-muted"
              :data-test-id="`fonts-store-family-license-${family.family}`"
            >
              {{ forkMsgs.fontsStoreFamilyLicenseMissing }}
            </span>
          </div>
          <div class="flex items-center justify-between gap-2 text-[10px] text-muted">
            <span>
              {{ forkMsgs.fontsStoreFamilyStylesCount({ count: family.styles.length }) }}
              <span
                v-if="family.styles.some((s) => s.variable)"
                class="ml-1 rounded bg-input px-1 py-0.5 text-[9px] uppercase text-muted"
              >
                {{ forkMsgs.fontsVariableBadge }}
              </span>
            </span>
            <AppButton
              type="button"
              color="primary"
              variant="solid"
              size="xs"
              :disabled="installingFamily === family.family"
              :data-test-id="`fonts-store-family-install-${family.family}`"
              @click="startInstall(family)"
            >
              {{
                installingFamily === family.family
                  ? forkMsgs.fontsStoreFamilyInstalling
                  : forkMsgs.fontsStoreFamilyInstall
              }}
            </AppButton>
          </div>
        </article>
      </div>
    </template>

    <!-- 服务清单视图 -->
    <template v-else>
      <h3 class="text-xs font-semibold text-surface">{{ forkMsgs[SERVICES_TITLE_KEY] }}</h3>

      <form
        class="flex flex-col gap-2 rounded border border-border p-2"
        data-test-id="fonts-store-register-form"
        @submit.prevent="submitRegister"
      >
        <input
          v-model="registerForm.name"
          type="text"
          :placeholder="forkMsgs.fontsStoreServiceNameLabel"
          class="w-full rounded border border-input bg-surface px-2 py-1 text-xs text-surface outline-none focus:border-accent"
          data-test-id="fonts-store-register-name"
        />
        <input
          v-model="registerForm.baseURL"
          type="url"
          :placeholder="forkMsgs.fontsStoreServiceBaseUrlLabel"
          class="w-full rounded border border-input bg-surface px-2 py-1 text-xs text-surface outline-none focus:border-accent"
          data-test-id="fonts-store-register-base-url"
        />
        <div class="flex items-center gap-2 text-[10px] text-muted">
          <select
            v-model="registerForm.kind"
            class="rounded border border-input bg-surface px-2 py-1 text-xs text-surface outline-none focus:border-accent"
            data-test-id="fonts-store-register-kind"
          >
            <option v-for="opt in kindOptions" :key="opt.value" :value="opt.value">
              {{ forkMsgs[opt.labelKey] }}
            </option>
          </select>
          <input
            v-if="registerForm.kind === 'gf-api'"
            v-model="registerForm.apiKey"
            type="password"
            :placeholder="forkMsgs.fontsStoreServiceApiKeyLabel"
            class="flex-1 rounded border border-input bg-surface px-2 py-1 text-xs text-surface outline-none focus:border-accent"
            data-test-id="fonts-store-register-api-key"
          />
        </div>
        <AppButton
          type="submit"
          color="primary"
          variant="solid"
          size="xs"
          :disabled="
            registerForm.busy ||
            registerForm.name.trim().length === 0 ||
            registerForm.baseURL.trim().length === 0
          "
          data-test-id="fonts-store-register-submit"
        >
          {{ forkMsgs.fontsStoreServiceSubmit }}
        </AppButton>
      </form>

      <AppPlaceholder v-if="servicesLoading" :label="forkMsgs.fontsLoading" />
      <div
        v-else-if="servicesError"
        class="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-surface"
        data-test-id="fonts-store-services-error"
      >
        {{ servicesError }}
      </div>
      <div v-else-if="services.length === 0" class="text-[10px] text-muted">
        {{ forkMsgs.fontsStoreEmpty }}
      </div>
      <div v-else class="flex flex-col gap-2" data-test-id="fonts-store-services-list">
        <article
          v-for="service in services"
          :key="service.id"
          class="flex flex-col gap-1 rounded border border-border p-3"
          :data-service-id="service.id"
          data-test-id="fonts-store-service-card"
        >
          <div class="flex items-baseline justify-between gap-2">
            <button
              type="button"
              class="min-w-0 flex-1 text-left"
              :data-test-id="`fonts-store-service-open-${service.id}`"
              @click="openService(service)"
            >
              <p class="truncate text-xs font-medium text-surface">{{ service.name }}</p>
              <p class="truncate text-[9px] text-muted" :title="service.baseURL">
                {{ truncateURL(service.baseURL) }}
              </p>
            </button>
            <span
              v-if="service.builtin"
              class="rounded bg-input px-1.5 py-0.5 text-[9px] uppercase text-muted"
            >
              {{ forkMsgs.fontsStoreServiceBuiltin }}
            </span>
            <span v-else class="rounded bg-input px-1.5 py-0.5 text-[9px] uppercase text-muted">
              {{ kindLabel(service.kind) }}
            </span>
            <AppButton
              v-if="!service.builtin"
              type="button"
              color="neutral"
              variant="soft"
              size="xs"
              :data-test-id="`fonts-store-service-delete-${service.id}`"
              @click="confirmDeleteService(service)"
            >
              {{ forkMsgs.fontsStoreServiceDelete }}
            </AppButton>
          </div>
        </article>
      </div>
    </template>

    <!-- 安装确认对话框 -->
    <AppConfirmationDialog
      v-model:open="installConfirmOpen"
      :heading="forkMsgs.fontsStoreInstallConfirmTitle"
      :description="forkMsgs.fontsInstallConfirmDesc"
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
          data-test-id="fonts-store-install-confirm-checkbox"
        />
        <span>{{ forkMsgs.fontsStoreInstallConfirmBody }}</span>
      </label>
    </AppConfirmationDialog>

    <!-- 服务删除确认 -->
    <AppConfirmationDialog
      v-model:open="deleteDialogOpen"
      tone="danger"
      :heading="forkMsgs.fontsStoreServiceDelete"
      :description="
        deleteTarget ? forkMsgs.fontsStoreServiceDeleteConfirm({ name: deleteTarget.name }) : ''
      "
      :cancel-label="forkMsgs.fontsCancel"
      :confirm-label="forkMsgs.fontsStoreServiceDelete"
      @cancel="onCancelDelete"
      @confirm="onConfirmDelete"
    />
  </section>
</template>
