<script setup lang="ts">
/**
 * T54→T66：generate_image 凭证面板——Provider 类型下拉 + baseUrl/model/key
 * 自由输入（T66 P0/P1：预设下拉退役，预设表已删）。T71：测试连接按钮移除
 * （owner 裁决 2026-09-01：并非所有 provider 支持探针端点）。T77 P6：
 * baseUrl/model 占位文案按当前选中 providerType 从注册表 entry 读取，
 * 缺省回退 i18n 通用占位（注册表未填 placeholder 的族走旧行为）。
 * key 直送 pi 后端凭证面（image-gen/routes.ts），前端不持久化、不回显
 * （状态只有 configured/providerType/baseUrl/model 元数据）。
 * 空 key 保存 = 清除（00 #7：清除必须生效）。
 */
import { computed, onMounted, ref, watch } from 'vue'

import {
  clearImageGenCredential,
  DEFAULT_IMAGE_GEN_PROVIDER_TYPE,
  IMAGE_GEN_PROVIDER_TYPES,
  imageGenCredentialError,
  imageGenCredentialLoading,
  imageGenCredentialStatus,
  refreshImageGenCredentialStatus,
  setImageGenCredential,
  type ImageGenProviderType
} from '@/app/ai/pi-backend/image-gen/client'
import { useForkImageGen } from '@/app/i18n/fork'

const msgs = useForkImageGen()

const providerType = ref<ImageGenProviderType>(
  (imageGenCredentialStatus.value?.providerType as ImageGenProviderType | undefined) ??
    DEFAULT_IMAGE_GEN_PROVIDER_TYPE
)
const baseURL = ref(imageGenCredentialStatus.value?.baseUrl ?? '')
const model = ref(imageGenCredentialStatus.value?.model ?? '')
const keyInput = ref('')
const busy = ref(false)
const actionError = ref<string | null>(null)

const configured = computed(() => imageGenCredentialStatus.value?.configured === true)

// T77 P6：占位文案按选中 providerType 从注册表 entry 读取，缺省回退 i18n。
// 切换 providerType 时即跟随切换；注册表无 placeholder 字段的族保持旧 i18n 串。
const selectedProviderEntry = computed(() =>
  IMAGE_GEN_PROVIDER_TYPES.find((entry) => entry.id === providerType.value)
)
const baseURLPlaceholder = computed(
  () => selectedProviderEntry.value?.baseUrlPlaceholder ?? msgs.value.imageGenBaseUrlPlaceholder
)
const modelPlaceholder = computed(
  () => selectedProviderEntry.value?.modelPlaceholder ?? msgs.value.imageGenModelPlaceholder
)

// 状态回读即回填表单（已配置时 baseUrl/model/providerType 可直接改存；key 永不回显）
watch(
  imageGenCredentialStatus,
  (status) => {
    if (status?.configured) {
      if (status.providerType) providerType.value = status.providerType as ImageGenProviderType
      baseURL.value = status.baseUrl ?? ''
      model.value = status.model ?? ''
    }
  },
  { immediate: false }
)

async function save(): Promise<void> {
  busy.value = true
  actionError.value = null
  try {
    // 空 key = 清除（后端 store 内部分派）
    await setImageGenCredential({
      providerType: providerType.value,
      baseUrl: baseURL.value.trim(),
      model: model.value.trim(),
      apiKey: keyInput.value.trim()
    })
    keyInput.value = ''
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

async function clear(): Promise<void> {
  busy.value = true
  actionError.value = null
  try {
    await clearImageGenCredential()
    keyInput.value = ''
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

onMounted(() => void refreshImageGenCredentialStatus())
</script>

<template>
  <section class="flex flex-col gap-1.5" data-test-id="image-gen-keys-section">
    <h3 class="text-xs font-semibold text-surface">{{ msgs.imageGenTitle }}</h3>

    <p
      v-if="imageGenCredentialError"
      class="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400"
      data-test-id="image-gen-offline"
    >
      {{ msgs.imageGenOffline }} ({{ imageGenCredentialError }})
    </p>

    <label class="text-[10px] text-muted">{{ msgs.imageGenProvider }}</label>
    <select
      v-model="providerType"
      class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none"
      data-test-id="image-gen-provider-type-select"
    >
      <option v-for="entry in IMAGE_GEN_PROVIDER_TYPES" :key="entry.id" :value="entry.id">
        {{ entry.label }}
      </option>
    </select>

    <label class="text-[10px] text-muted">{{ msgs.imageGenBaseUrl }}</label>
    <input
      v-model="baseURL"
      type="text"
      spellcheck="false"
      class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
      :placeholder="baseURLPlaceholder"
      data-test-id="image-gen-base-url-input"
    />

    <label class="text-[10px] text-muted">{{ msgs.imageGenModel }}</label>
    <input
      v-model="model"
      type="text"
      spellcheck="false"
      class="rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
      :placeholder="modelPlaceholder"
      data-test-id="image-gen-model-input"
    />

    <div class="flex items-center gap-1.5">
      <input
        v-model="keyInput"
        type="password"
        class="min-w-0 flex-1 rounded border border-border bg-panel px-2 py-1.5 text-[11px] text-surface outline-none focus:border-panel-focus"
        :placeholder="
          configured ? msgs.imageGenKeyPlaceholderConfigured : msgs.imageGenKeyPlaceholderMissing
        "
        data-test-id="image-gen-key-input"
        @keydown.enter="save"
      />
      <button
        type="button"
        class="rounded bg-accent px-2 py-1.5 text-[10px] font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        data-test-id="image-gen-key-save"
        :disabled="busy || imageGenCredentialLoading"
        @click="save"
      >
        {{ msgs.imageGenKeySave }}
      </button>
      <button
        v-if="configured"
        type="button"
        class="rounded border border-border px-2 py-1.5 text-[10px] text-muted hover:text-surface disabled:opacity-50"
        data-test-id="image-gen-key-clear"
        :disabled="busy"
        @click="clear"
      >
        {{ msgs.imageGenKeyClear }}
      </button>
    </div>

    <p
      class="flex items-center gap-1 text-[9px] text-muted"
      :data-state="configured ? 'configured' : 'missing'"
      data-test-id="image-gen-key-status"
    >
      <span
        class="size-1.5 rounded-full bg-muted data-[state=configured]:bg-[var(--color-success)]"
        :data-state="configured ? 'configured' : 'missing'"
      />
      {{ configured ? msgs.imageGenConfigured : msgs.imageGenNotConfigured }}
      <template v-if="configured && imageGenCredentialStatus?.model">
        · {{ imageGenCredentialStatus.model }}
      </template>
    </p>

    <p v-if="actionError" class="text-[10px] text-red-400" data-test-id="image-gen-action-error">
      {{ actionError }}
    </p>
  </section>
</template>
