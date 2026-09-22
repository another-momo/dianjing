<script setup lang="ts">
/**
 * 2026-09-18 broker P1：pending 决断卡（一骨架多皮肤，设计真源
 * docs/202609181745-agent-permission-broker-design.md §5/§6）。
 *
 *  - ask 皮肤：沿用 AskUserQuestionCard 视觉与交互语义（内嵌复用，不重实现），
 *    submit 事件原样转发给 ChatPanel（统一 decision-answer 端点在面板侧收口）。
 *  - authz 皮肤（系统授权）：按 toolName 分支——
 *    · bash：命令原文等宽 + cwd + 规则原文（「你将放行的是什么」）+ 按钮组
 *      「允许一次 / 按规则放行（按钮呈现规则原文）/ 拒绝（可附一句话）」。
 *    · install_skill：skill 名 + 文件清单（可折叠） + 适配摘要 + overwrite=true
 *      时覆盖警示（旧版本将移入备份目录）。按钮仅「允许一次 / 拒绝」——
 *      install_skill 无规则记忆（install-skill.ts:610 后端 hard-deny
 *      `answer.decision !== 'allow-once'`），不允许 rule 按钮渲染。
 *
 * 视觉分界 = 防伪造安全边界（§6）：authz 卡内容与 ask 卡不同源——ask 卡文案由
 * 模型撰写，若两卡同皮肤模型可经 ask 伪造授权请求。authz 皮肤专属 warning 色族
 * （--color-warning-* 双主题令牌，浅/深均有色值）+ shield 图标 +「系统授权」标
 * + 事实层标注「系统直出（未经模型撰写）」，与 ask 的 accent 蓝族明确可区分。
 *
 * 降级：decide POST 失败不崩——卡留未决态、按钮复位可重试、错误行显后端 message
 * （端点未落地 404 同路径）。提交成功经 markAuthzResolved 写会话级已决记录：
 * pinned dock 立即收卡，消息流内同 formId 的 data part 转已决归档渲染。
 */
import { computed, ref } from 'vue'

import type { AskFormSubmission } from '@open-pencil/core/tools/fork/marketing/ask-user-question'

import Tip from '@/components/ui/overlay/Tip.vue'

import AskUserQuestionCard from './AskUserQuestionCard.vue'
import {
  deriveDefaultBashRule,
  markAuthzResolved,
  postDecisionAnswer,
  type AskDecisionView,
  type AuthzDecision,
  type AuthzDecisionRecord,
  type AuthzDecisionView,
  type BashAuthzRequestData,
  type DecisionAnswerPayload,
  type InstallSkillAuthzRequestData,
  type PendingDecisionView
} from './pending-decision'

const { decision } = defineProps<{
  decision: PendingDecisionView
}>()

const emit = defineEmits<{
  askSubmit: [submission: AskFormSubmission]
}>()

/** kind 判别收窄（模板联合类型直用 vue-tsc 收窄不稳，走 computed 显式收窄） */
const askView = computed<AskDecisionView | null>(() => (decision.kind === 'ask' ? decision : null))
const authz = computed<AuthzDecisionView | null>(() =>
  decision.kind === 'authz' ? decision : null
)
/** toolName 二级判别收窄——返回收窄后的请求体（布尔 guard 不收窄联合，
 *  vue-tsc 会报 TS2339；模板直取 command/cwd 走这里） */
const bashRequest = computed<BashAuthzRequestData | null>(() =>
  authz.value?.request.toolName === 'bash' ? authz.value.request : null
)
const installSkill = computed<InstallSkillAuthzRequestData | null>(() =>
  authz.value?.request.toolName === 'install_skill' ? authz.value.request : null
)

/** 按钮呈现的规则原文：后端 matchedRule 优先，缺席按 §11-4 默认口径派生。
 *  install_skill 无规则原文概念，bash 专属 */
const ruleText = computed(() => {
  const view = authz.value
  if (!view || view.request.toolName !== 'bash') return ''
  return view.request.matchedRule ?? deriveDefaultBashRule(view.request.command)
})

// ── install_skill 文件清单折叠态（卡片级单文件，开关独立——同一会话多张 install 卡
//    时互不干扰） ──

const filesExpanded = ref(false)

// ── authz 决断提交（卡片自闭环：in-flight + 失败可重试态都在本地） ──────────────

const submitting = ref(false)
const submitError = ref<string | null>(null)
/** 拒绝附言（可选，一句话回 agent；仅随 deny 决断上送） */
const denyNote = ref('')

async function decide(action: AuthzDecision): Promise<void> {
  const view = authz.value
  if (!view || view.mode !== 'pending' || submitting.value) return
  submitting.value = true
  submitError.value = null
  const note = denyNote.value.trim()
  const formId = view.request.formId
  let payload: DecisionAnswerPayload
  if (action === 'allow-rule' && view.request.toolName === 'bash') {
    payload = { kind: 'authz', formId, decision: 'allow-rule', ruleText: ruleText.value }
  } else if (action === 'deny') {
    payload = note
      ? { kind: 'authz', formId, decision: 'deny', note }
      : { kind: 'authz', formId, decision: 'deny' }
  } else {
    payload = { kind: 'authz', formId, decision: 'allow-once' }
  }
  const result = await postDecisionAnswer(payload)
  submitting.value = false
  if (!result.ok) {
    // 优雅降级：端点未落地/pending 已失效/网络错误——卡留未决态可重试
    submitError.value = result.message
    return
  }
  const record: AuthzDecisionRecord = { formId, decision: action }
  if (view.request.toolName === 'bash') {
    record.command = view.request.command
    record.cwd = view.request.cwd
    if (action === 'allow-rule') record.ruleText = ruleText.value
  }
  if (action === 'deny' && note) record.note = note
  markAuthzResolved(record)
}

// ── 已决/失效归档的展示派生 ──

const decisionBadge = computed(() => {
  const record = authz.value?.record
  if (!record) return ''
  switch (record.decision) {
    case 'allow-once':
      return '已允许一次'
    case 'allow-rule':
      return '已按规则放行'
    case 'deny':
      return '已拒绝'
  }
})

const expiredLine = computed(() => {
  const view = authz.value
  if (!view || view.mode !== 'expired') return ''
  switch (view.expiredHint) {
    case 'executed':
      return '轮次已结束——该命令其后已执行（决断详情随会话失效）'
    case 'blocked':
      return '轮次已结束——该命令未执行（被拒绝或轮次中断）'
    default:
      return '轮次已结束，授权请求未答复'
  }
})

/** install_skill 已决归档行——deny 时附言，allow-once 时安装已落地 */
const installSkillResolvedLine = computed(() => {
  const view = authz.value
  if (
    !view ||
    view.mode !== 'resolved' ||
    view.request.toolName !== 'install_skill' ||
    !view.record
  ) {
    return ''
  }
  if (view.record.decision === 'allow-once') {
    return `已安装 skill「${view.request.name}」（${view.request.files.length} 个文件）`
  }
  return `已拒绝安装 skill「${view.request.name}」`
})
</script>

<template>
  <div data-test-id="pending-decision-card" :data-kind="decision.kind">
    <!-- ask 皮肤：沿用现有表单卡（视觉与交互语义不变），未决时 pinned 承接 -->
    <AskUserQuestionCard
      v-if="askView"
      :part="askView.part"
      :part-state="askView.partState"
      @submit="emit('askSubmit', $event)"
    />

    <!-- authz 皮肤：系统授权专属视觉（warning 色族 + shield + 系统直出标） -->
    <div
      v-else-if="authz"
      data-test-id="pending-decision-authz"
      :data-mode="authz.mode"
      :data-tool-name="authz.request.toolName"
      class="space-y-2 rounded-lg border p-3"
      :class="
        authz.mode === 'expired'
          ? 'border-border bg-canvas'
          : 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]'
      "
    >
      <div class="flex items-center gap-2">
        <icon-lucide-shield-check
          v-if="authz.mode === 'resolved' && authz.record?.decision !== 'deny'"
          class="size-3.5 shrink-0 text-[var(--color-success)]"
        />
        <icon-lucide-shield-x
          v-else-if="authz.mode === 'resolved'"
          class="size-3.5 shrink-0 text-[var(--color-error)]"
        />
        <icon-lucide-shield-alert
          v-else
          class="size-3.5 shrink-0"
          :class="authz.mode === 'pending' ? 'text-[var(--color-warning-action)]' : 'text-muted'"
        />
        <span class="text-[11px] font-medium text-surface">系统授权</span>
        <span
          class="rounded border border-[var(--color-warning-border)] px-1 py-px text-[9px] text-[var(--color-warning-text)]"
        >
          系统直出
        </span>
        <span class="text-[10px] text-muted">{{ authz.request.toolName }}</span>
        <span
          v-if="authz.mode === 'resolved'"
          data-test-id="pending-decision-resolved-badge"
          class="ml-auto rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted"
        >
          {{ decisionBadge }}
        </span>
        <span
          v-else-if="authz.mode === 'expired'"
          data-test-id="pending-decision-expired-badge"
          class="ml-auto rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted"
        >
          已失效
        </span>
      </div>

      <!-- 事实层标注：防伪造分界的明示属性（§8——内容系统直出，无模型撰写位） -->
      <div v-if="authz.mode === 'pending'" class="text-[10px] text-muted">
        <template v-if="bashRequest">命令原文与工作目录由系统直出（未经模型撰写）</template>
        <template v-else-if="installSkill">
          skill 元信息（名/文件清单/适配摘要）由系统直出（未经模型撰写）
        </template>
      </div>

      <!-- bash 分支：命令原文 + 工作目录 + 规则原文 + 三按钮 -->
      <template v-if="bashRequest">
        <pre
          data-test-id="pending-decision-authz-command"
          class="overflow-x-auto rounded bg-input px-2 py-1.5 font-mono text-[11px] break-all whitespace-pre-wrap text-surface"
          >{{ bashRequest.command }}</pre>
        <div v-if="bashRequest.cwd" class="text-[10px] text-muted">
          工作目录：<span class="font-mono">{{ bashRequest.cwd }}</span>
        </div>
      </template>

      <!-- install_skill 分支：skill 名 + 文件清单（可折叠） + 适配摘要 + overwrite 警示 -->
      <template v-else-if="installSkill">
        <div class="space-y-1.5">
          <div class="flex items-baseline gap-2">
            <span class="text-[10px] text-muted">Skill 名</span>
            <span
              data-test-id="pending-decision-authz-skill-name"
              class="font-mono text-[12px] text-surface"
              >{{ installSkill.name }}</span
            >
          </div>
          <div v-if="installSkill.overwrite" class="text-[10px] text-[var(--color-warning-action)]">
            已存在同名 skill——本次安装将把旧版本移入备份目录
          </div>
          <div class="space-y-0.5">
            <button
              type="button"
              class="flex items-center gap-1 text-[10px] text-muted hover:text-surface"
              data-test-id="pending-decision-authz-files-toggle"
              @click="filesExpanded = !filesExpanded"
            >
              <icon-lucide-chevron-right
                v-if="!filesExpanded"
                class="size-3 shrink-0 transition-transform"
              />
              <icon-lucide-chevron-down v-else class="size-3 shrink-0 transition-transform" />
              <span
                >文件清单（{{ installSkill.files.length }} 个）{{
                  filesExpanded ? '' : '——点击展开'
                }}</span
              >
            </button>
            <ul
              v-if="filesExpanded"
              data-test-id="pending-decision-authz-files"
              class="ml-2 space-y-0.5 rounded bg-input px-2 py-1 font-mono text-[10px] text-surface"
            >
              <li v-for="file in installSkill.files" :key="file" class="break-all">
                {{ file }}
              </li>
            </ul>
          </div>
          <div class="space-y-0.5">
            <div class="text-[10px] text-muted">适配摘要</div>
            <pre
              data-test-id="pending-decision-authz-adapter-summary"
              class="overflow-x-auto rounded bg-input px-2 py-1.5 font-mono text-[10px] break-all whitespace-pre-wrap text-surface"
              >{{ installSkill.adapterSummary }}</pre>
          </div>
        </div>
      </template>

      <template v-if="authz.mode === 'pending'">
        <!-- bash 分支：规则原文 + 三按钮（allow-once / allow-rule / deny） -->
        <template v-if="bashRequest">
          <div class="text-[10px] text-muted">
            你将放行的是什么：<span class="font-mono text-surface">{{ ruleText }}</span>
            ——选「按规则放行」后，本会话内匹配该规则的命令不再询问
          </div>

          <input
            v-model="denyNote"
            type="text"
            :disabled="submitting"
            placeholder="附言（可选）——随「拒绝」回传给 agent"
            data-test-id="pending-decision-authz-note"
            class="block w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
          />

          <div
            v-if="submitError"
            data-test-id="pending-decision-submit-error"
            class="text-[10px] text-[var(--color-error)]"
          >
            提交失败：{{ submitError }}——授权请求仍在等待，可重试
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              :disabled="submitting"
              data-test-id="pending-decision-allow-once"
              class="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              @click="decide('allow-once')"
            >
              允许一次
            </button>
            <Tip :label="ruleText">
              <button
                type="button"
                :disabled="submitting"
                data-test-id="pending-decision-allow-rule"
                class="flex min-w-0 items-center gap-1 rounded-md border border-[var(--color-warning-border)] px-2.5 py-1 text-[11px] text-[var(--color-warning-action)] hover:bg-[var(--color-warning-bg)] disabled:cursor-not-allowed disabled:opacity-60"
                @click="decide('allow-rule')"
              >
                按规则放行：<span class="max-w-48 truncate font-mono">{{ ruleText }}</span>
              </button>
            </Tip>
            <button
              type="button"
              :disabled="submitting"
              data-test-id="pending-decision-deny"
              class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
              @click="decide('deny')"
            >
              拒绝
            </button>
          </div>
        </template>

        <!-- install_skill 分支：仅双按钮（allow-once / deny）——allow-rule 不启用
             （install-skill.ts:610 后端 hard-deny `decision !== 'allow-once'`） -->
        <template v-else-if="installSkill">
          <input
            v-model="denyNote"
            type="text"
            :disabled="submitting"
            placeholder="附言（可选）——随「拒绝」回传给 agent"
            data-test-id="pending-decision-authz-note"
            class="block w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[11px] text-surface outline-none placeholder:text-muted focus:border-accent disabled:opacity-60"
          />

          <div
            v-if="submitError"
            data-test-id="pending-decision-submit-error"
            class="text-[10px] text-[var(--color-error)]"
          >
            提交失败：{{ submitError }}——授权请求仍在等待，可重试
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              :disabled="submitting"
              data-test-id="pending-decision-allow-once"
              class="rounded-md bg-accent px-2.5 py-1 text-[11px] text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              @click="decide('allow-once')"
            >
              允许安装
            </button>
            <button
              type="button"
              :disabled="submitting"
              data-test-id="pending-decision-deny"
              class="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
              @click="decide('deny')"
            >
              拒绝安装
            </button>
          </div>
        </template>
      </template>

      <!-- 已决归档：决断结果（哪个按钮、规则原文/附言如有） -->
      <div v-else-if="authz.mode === 'resolved' && authz.record" class="space-y-0.5 text-[10px]">
        <div v-if="installSkill" data-test-id="pending-decision-authz-resolved-summary">
          {{ installSkillResolvedLine }}
        </div>
        <div
          v-if="authz.record.decision === 'allow-rule' && authz.record.ruleText"
          class="text-muted"
        >
          规则原文：<span class="font-mono text-surface">{{ authz.record.ruleText }}</span>
        </div>
        <div v-if="authz.record.decision === 'deny' && authz.record.note" class="text-muted">
          附言：{{ authz.record.note }}
        </div>
      </div>

      <!-- 失效归档：未答复但轮次已结束（含工具终态弱化推导） -->
      <div v-else-if="authz.mode === 'expired'" class="text-[10px] text-muted">
        {{ expiredLine }}
      </div>
    </div>
  </div>
</template>
