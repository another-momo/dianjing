/**
 * 2026-09-27 sl-w2-locus-gate：run 期施工页全局状态（§7.3 感知三件套数据源）。
 *
 * PagesPanel / ChatLocusStatusRow / ChatPanel.handleSubmit 三处均需消费
 * 「run 起始捕获的 pageId」与「run 进行中旗标」——避免各自起 watcher、收
 * 风险不一致，单一事实源落在此模块。ChatPanel 装订 bindRunPageTracking 后
 * 把 runStartedPageId 写回这里；同时维护 runActive（=chat.status ∈
 * {submitted, streaming}），下游用同一份 ref 做派生。
 *
 * 同时维护「当前落点页」状态（来自 GET 响应 + PUT 写回的最近一份）。每次
 * 发送前 GET 后调用 setLocusState；发送结束（same-page 放行 / silent-init
 * PUT / gate 决断后 PUT）调用同样的 setter 维持事实新鲜。
 */

import { ref, shallowRef, type Ref } from 'vue'

/** run 进行中旗标（chat.status 派生） */
const runActive = ref(false)

/** run 起始时刻捕获的 pageId（null = run 不在途） */
const runStartedPageId: Ref<string | null> = shallowRef(null)

/** 当前文档落点页 id（GET 响应 / PUT 写回后更新） */
const engagedPageId: Ref<string | null> = shallowRef(null)

/** 当前文档落点页名（仅用于 UI 显示，与 id 同步更新） */
const engagedPageName: Ref<string | null> = shallowRef(null)

export function setRunActive(active: boolean): void {
  runActive.value = active
}

export function setRunStartedPageId(pageId: string | null): void {
  runStartedPageId.value = pageId
}

export function setEngagedPage(args: { id: string | null; name: string | null }): void {
  engagedPageId.value = args.id
  engagedPageName.value = args.name
}

/** 装配层读取（PagesPanel 派生 badge / ChatLocusStatusRow 派生显示） */
export function useLocusState() {
  return {
    runActive,
    runStartedPageId,
    engagedPageId,
    engagedPageName
  }
}
