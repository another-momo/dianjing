<script setup lang="ts">
// Batch 2a 命名分离（2026-09-05）：本组件自 ChatInput.vue 改名 PiChatInput.vue，
// 原名留给 deletedPaths 落账——组件已实质重写，与上游 ChatInput 无合并语义。
//
// Batch ux/inline-selection-chips（2026-09-05）：
//   选区 token 缩略图 chip 从独立 attachment slot 行**内嵌进文本流**——
//   contenteditable div + 分段模型（纯文本段 | 选区 token 段）。token 段在
//   DOM 里渲成 contenteditable="false" 的原子 chip（含 ChatNodePreview 缩略图
//   + 「@画布选区-N」标签），与正文混排、跨行随文。序列化路径不变——
//   模型 → 字面 `「@画布选区-N」` → 既有 serializeSelectionManifest，
//   payload 与上一版（attachment slot 行）逐字节一致。分段的纯函数面
//   （segmentsFromText / segmentsToText）钉扎在 selection-capture.ts 与
//   tests/engine/rebuild/chat/selection-capture.test.ts。
//
// DOM↔模型同步纪律（contenteditable 最大坑点 + ux6 三修：完全非受控）：
//   - **编辑器内容完全非受控（uncontrolled contenteditable）**：Vue **永远**
//     不 patch/卸载编辑器 children。理由：v-if 一旦翻 false 会触发 Vue
//     unmount（不是冻结不 patch）——把挂过的 chip span 整片 remove，浏览器
//     打字产生的文本节点（不在 v-if 分支内）反而幸存 → chip 消失、文字
//     保留（实测三修前的精确机理）。同样的语义陷阱在 IME 上：isComposing
//     翻 true 卸载合成串所在的文本节点 → IME 流断。
//   - **shadowText 是 plain `let`，不响应式**：@input / @compositionend 只
//     扫描 DOM 写入 shadowText（plain var），**不触发任何响应式依赖**。
//     模板依赖的 `input` ref 由结构事件独占写。Vue 响应式依赖图上从
//     `@input` 到模板零路径 → 零重渲 → 零 patch → IME 天然安全（无需
//     isComposing 守卫）。
//   - **结构事件路径（采集插入 / X 删除 / 原子删除 / 粘贴 / clear / restore /
//     submit 清空）**：读 shadowText（DOM 真相）→ 算出新文本 → 写
//     `input.value` + `segVersion++` → Vue 整段重挂（:key 引用 segVersion，
//     新 vnode 子树完整替换——浏览器脏 DOM 一并丢弃，无失配）→ nextTick
//     restoreCaret 落 caret。
//   - **不变量**：shadowText == syncTextFromDom(DOM) 恒成立；`input.value`
//     在结构事件瞬间与 shadowText 对齐；模板**只在结构事件时**渲染。
//   - **IME 守卫移除**：上面已经说——不需要。contenteditable IME 流由浏览器
//     完整维护（DOM-master 模式），compositionstart/end 只是 shadowText
//     同步点。
//   - **chip reactive 数据**：缩略图 graph/renderer 是 ChatNodePreview 内部
//     状态，不在编辑器 children 上——结构重建换 chip 时新 ChatNodePreview
//     实例拿新 props 自渲。chip 文字 label 走 props 也走结构重建。
//   - **删空一击收编为结构事件（2026-09-11 修复，见
//     docs/202609112147-chat-input-seg-root-detached-review.md）**：keydown
//     （Backspace/Delete）+ beforeinput（deleteContent*/deleteByCut）拦「删
//     完即空 / 空文档删除键 / 选区覆盖全文」→ preventDefault 改走
//     commitStructuralChange('')——Vue 重挂 seg-root（带 lone <br>），编辑
//     器永不为空，Blink 永远吃不到 seg-root。空文档再按删除键 = no-op，
//     仅 preventDefault 不触发无意义重挂。
//   - **seg-root 缺失 = 腐化签名 → 崩溃前安全重挂**：syncTextFromDom 检到
//     editorRef 子节点里没有 data-seg-root（Blink 空编辑器规范化吃掉了
//     seg-root，根因同上）→ **不** 走 commitStructuralChange（同一个 patch
//     必炸）→ emit('segRootLost', normalized) 让父级 bump remount key 整
//     树换实例，草稿经 restoreDraft 回填。T98 onErrorCaptured 留作最后防线。
//   - **包裹层必须是正常 block 盒**——display:contents 在 Blink 下不能作为
//     caret/插入点宿主（实测：空编辑器首字符被插到编辑器根部游离、清空重
//     输完全打不进字）；block 盒内 inline 内容照常被包进 text flow，chip
//     仍与文字同行。
//   - **空文档必须显式渲染占位 <br>**：segments=[] 时 seg-root 里只剩
//     Vue fragment 的空文本锚点，Blink 不认锚点为合法插入点——点击 caret
//     落进锚点空文本节点后 insertText（中文/IME 路径）插入成功但 caret
//     停在偏移 0（实测：后续字符插到首字符前面，首字符被挤到文末）。有
//     br 时 caret 规范化为 (seg-root, 0)，insertText 正常消费 br、caret
//     跟随。lone <br> 在序列化侧由 isLoneBr 按 0 长处理，不进文本。
//   - **ux6 三修模板注释已挪出 contenteditable**（2026-09-11 卫生修复）：
//     模板内大段 HTML 注释被 Vue 编译成真实 comment 节点常驻编辑器，实测
//     它先于 seg-root 被 Blink 空编辑器规范化删掉，是 hoist/caret 归位
//     逻辑的长期干扰项。hoistStraysIntoSegRoot 里的 COMMENT_NODE 跳过逻辑
//     保留（防御性）。
import { useTimeoutFn } from '@vueuse/core'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
  TooltipProvider
} from 'reka-ui'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { SkiaRenderer } from '@open-pencil/core/canvas'
import type { SceneGraph } from '@open-pencil/scene-graph'
import { useI18n } from '@open-pencil/vue'

import { piDesignAssignment } from '@/app/ai/pi-backend/assignment'
import {
  ensurePiStudioManifest,
  piStudioManifest,
  piStudioManifestFailed,
  retryPiStudioManifest
} from '@/app/ai/pi-backend/mode-selection'
import { getActiveEditorStoreOrNull } from '@/app/editor/active-store'
import { useForkChips } from '@/app/i18n/fork'
import { openSettingsDialog } from '@/app/settings/dialog'
import ChatModeChips from '@/components/assistant/ChatModeChips.vue'
import ChatNodePreview from '@/components/assistant/ChatNodePreview.vue'
import { deletionEmptiesDocument } from '@/components/assistant/delete-guard'
import {
  resolveSelectionTokenChips,
  type SelectionTokenChip
} from '@/components/assistant/node-preview'
import {
  captureSelectionFromStore,
  createSelectionDraftState,
  removeSelectionToken,
  resetSelectionDraftState,
  restoreSelectionDraftState,
  segmentsFromText,
  scanSelectionTokens,
  selectionTokenText,
  serializeSelectionManifest,
  snapshotSelectionDraftState,
  stripSelectionManifest,
  type SelectionDraftState
} from '@/components/assistant/selection-capture'
import {
  composeSkillSubmission,
  extractLeadingSkillCommand
} from '@/components/assistant/skill-chip'
import IconButton from '@/components/ui/button/IconButton.vue'
import InputGroup from '@/components/ui/input/InputGroup.vue'
const { ai } = useI18n()
const chipsText = useForkChips()

const { status, disabled = false } = defineProps<{
  status: 'ready' | 'submitted' | 'streaming' | 'error'
  disabled?: boolean
}>()

const emit = defineEmits<{
  submit: [text: string]
  stop: []
  error: [message: string]
  /** 编辑器里的 data-seg-root 被 Blink 空编辑器规范化吃掉（腐化签名）。
   *  父级收到后 bump remount key 整树换实例——比 T98 onErrorCaptured 提前到
   *  崩溃前（runtime-dom 的 unmount 对游离树安全，patch/insert 才会炸）；
   *  payload 是 walk 读出的 DOM 当前文本——空编辑器首字符等游离文本也能
   *  救回。 */
  segRootLost: [text: string]
}>()

/** 文本态模型——三轨结构（ux6 后续修复）：
 *  - shadowText：plain `let` 变量。@input / @compositionend 唯一写入路径。
 *    **非响应式**：写它不会触发任何依赖图上的模板更新（Vue 看不到 plain
 *    var 的变化）。这是「打字期 Vue 渲染次数 = 0」的硬保证。
 *  - input：响应式 ref<string>。**仅由结构事件写入**（采集插入 / X 删除
 *    / 原子删除 / 粘贴 / clear / restore / submit 清空）。模板 segments
 *    依赖它，所以结构事件触发 v-for 重渲 + :key 重挂整段重建。
 *  - hasText：响应式 ref<boolean>。**打字期空判断信号**——所有写 shadowText
 *    的地方同步维护：`commitStructuralChange`（结构事件）+ `syncTextFromDom`
 *    （@input / @compositionend）。模板里发送按钮 disabled 和 placeholder
 *    显隐读它，让鼠标用户在打字后能立即看到按钮亮起来 / 占位符收起——但
 *    `input` 本身保持「结构事件独占写」纪律（打字期不重渲 segments，仍是
 *    零重渲 → 零 patch → IME 天然安全）。
 *    **placeholder 用 v-show 而非 v-if**（详见模板注释）：v-if 在「提交
 *    瞬间 hasText true→false」与 segVersion++ 重挂 seg-root 同一 patch
 *    flush 里翻 true，contenteditable 还拿着焦点 + 活动 Selection 指在
 *    即将卸载的旧 seg-root 子节点内；新 placeholder vnode 挂入 + 旧
 *    seg-root 卸载 + 新 seg-root 挂入三件并发，Vue 内部 anchor 计算偶发
 *    取到 null（实测 Enter 链触发：mountElement `insertBefore` of null /
 *    patchElement `__vnode` of null）。v-show 永远不挂卸——仅切 display
 *    style，零 mount 路径——彻底脱离这条雷区；打字期 live 反馈和 IME 零
 *    重渲两条 ux6 不变量均保持（v-show 只更新 style 属性，不 patch
 *    编辑器子树）。
 *  - 三轨同步点：
 *      - 结构事件：先读 shadowText（DOM 真相），算新文本 → commitStructuralChange
 *        同步写 shadowText + input.value + hasText.value + segVersion++。
 *      - 打字 / IME：@input/@compositionend → syncTextFromDom 写 shadowText
 *        + hasText.value（**不写** input.value / segVersion）。
 *  - 不变量：shadowText === syncTextFromDom(DOM) 恒成立；input.value 在结
 *    构事件瞬间与 shadowText 对齐；hasText.value === !!shadowText.trim()
 *    恒成立。
 *  - 序列化源 = shadowText（提交瞬间 DOM 真相，与旧 textarea 路径字节等价）。
 */
let shadowText = ''
const input = ref('')
const hasText = ref(false)
/** seg-root 腐化一次只上报一次：组件实例被父级换走前，连续 @input 会反复
 *  命中同一腐化签名，重复 emit 既无意义又会逼父级连续 remount。父级 key
 *  一变本实例就卸载，标志位随实例灭失自然复位。 */
let segRootLostEmitted = false

const isStreaming = computed(() => disabled || status === 'streaming' || status === 'submitted')

// ── T70：画布选区采集（内联 token「@画布选区-N」；路线 B = contenteditable
//    chip 内嵌） ────────────────────────────────────────────────────────────
//
// 草稿期 token 状态（登记表 + 序号）刻意不进响应式系统：模板渲染只依赖
// input 文本实扫（segmentsFromText 即从 input 派生），状态仅在采集/提交/
// 回填时读写。
const draftTokens = createSelectionDraftState()
// T27 快照：提交即清空文本+登记表；失败回填时两者一并恢复（restoreDraft）
let lastDraftSnapshot: SelectionDraftState | null = null

/** 编辑器根（contenteditable） */
const editorRef = ref<HTMLDivElement | null>(null)

/** 空选区轻提示：actionToast 桌面端无渲染面（仅 MobileHud 消费），按计划
 *  退化为按钮短暂文案反馈（T70-plan §1.1「若无则按钮短暂文案反馈」） */
const captureEmptyFlash = ref(false)
const { start: scheduleCaptureFlashEnd, stop: cancelCaptureFlashEnd } = useTimeoutFn(
  () => {
    captureEmptyFlash.value = false
  },
  1600,
  { immediate: false }
)

/** 分段模型（响应式）——文本流实扫到 token 即切 token 段；半删残串归文本
 *  段（与 scanSelectionTokens 一致）。序列化永远走 segmentsToText → 既有
 *  serializeSelectionManifest。 */
const segments = computed(() => segmentsFromText(input.value))

/** 内嵌 chip 数据：与上一版（attachment slot 行）同口径——首节点缩略图 +
 *  节点名 label。chip key = n。 */
const tokenChips = computed<SelectionTokenChip[]>(() => {
  const store = getActiveEditorStoreOrNull()
  if (store) void store.state.sceneVersion
  return resolveSelectionTokenChips(input.value, draftTokens.registry, store?.graph ?? null)
})

/** 按 n 查 token chip 数据（渲染时多对一映射：同 n 多次出现共用一张缩略图） */
function chipForN(n: number): SelectionTokenChip | null {
  return tokenChips.value.find((c) => c.n === n) ?? null
}

function chipLabelForN(n: number): string {
  // owner 决议：chip 标签恒为 @画布选区-N（简短清晰），不用节点名（多节点
  // 用 + 连接会过长）。缩略图已由 ChatNodePreview 承担识别职责。
  return `@画布选区-${n}`
}

// chip 缩略图渲染上下文：不用 computed——renderer 挂载是非响应式事件，模板
// 重渲染（chip 出现/变化必伴随 input 变动）时直取现值即可；store 缺席
// （storybook/测试面）→ null，ChatNodePreview 降级为 box 图标 + 名称
function chipRenderContext(): { graph: SceneGraph | null; renderer: SkiaRenderer | null } {
  const store = getActiveEditorStoreOrNull()
  return { graph: store?.graph ?? null, renderer: store?.renderer ?? null }
}

// ── 结构事件渲染面（ux6 三修：编辑器完全非受控） ───────────────────────────
//
// segVersion：结构事件触发时递增；segments 容器 :key 引用 → Vue 整段重挂
// （unmount 旧子树 + mount 新子树）——浏览器脏 DOM 一并丢弃，无失配。
//
// pendingCaretOffset：结构事件写 model 前存"目标 caret 文本偏移"，watch
// 触发 + nextTick 后由 restoreCaret 走 textOffsetToDom 落回。
//
// 关键：input.value 仅由结构事件写。@input 路径只写 shadowText（plain var）。
// 模板 segments 依赖 input.value → 响应式依赖图上 @input → 模板零路径。
// Vue 零重渲 = 天然零 patch = IME / 打字 / 删字全程无 patch。

const segVersion = ref(0)
/** 下一次 segments 重渲后要把 caret 落到的文本偏移；null = 不动 caret */
const pendingCaretOffset = ref<number | null>(null)

/** 结构事件写 model：同步更新 shadowText + input.value + segVersion++。
 *  三者必须同步——shadowText 是序列化源/DOM 同步基线，input.value 触发
 *  响应式重渲，segVersion 触发 :key 重挂。
 *  重挂单位是 data-seg-root 包裹层（真实 div，必须正常 block 盒——
 *  display:contents 在 Blink 下不能做 caret 宿主，见模板注释）：Vue 卸载
 *  旧树 = removeChild(包裹层) → 整个子树连同浏览器打字搬动过的脏节点一并
 *  移除；新树往编辑器里挂全新包裹层。Vue 从不对同一批 children 做原地
 *  patch（实测：逐 vnode 回收收不回被浏览器搬出 span 的文本节点 → 文本重复；
 *  同步 replaceChildren 又会让 Vue 的 insertBefore 锚点失配 → 崩溃）。 */
function commitStructuralChange(nextText: string): void {
  shadowText = nextText
  segVersion.value += 1
  input.value = nextText
  hasText.value = nextText.trim().length > 0
}

watch(input, () => {
  // input 仅由 commitStructuralChange 写 → 此回调只对应结构事件。
  // 不需要再做 renderLock 判定——DOM-source 路径根本不写 input.value。
  const target = pendingCaretOffset.value
  pendingCaretOffset.value = null
  if (target != null) {
    void nextTick(() => restoreCaret(target))
  }
})

/** 结构事件后 caret 落位：把目标文本偏移转成 {node, offset}，用 Selection/Range
 *  落在编辑器内。失焦（采集按钮抢焦点）时先 focus 再落 caret——否则浏览器
 *  默认 caret 停在编辑器起点（实测：采集后光标落在 chip 前，应在 chip 后）。
 *  是 domOffsetToTextOffset 的严格反向。 */
function restoreCaret(targetOffset: number): void {
  const el = editorRef.value
  if (!el) return
  if (document.activeElement !== el) el.focus()
  // 空文档（seg-root 只有浏览器自动占位的 lone <br>）时 textOffsetToDom
  // 扫不到任何节点 → 退化为显式落包裹层起点，保证 caret 一定在 seg-root 内
  const pos =
    textOffsetToDom(el, targetOffset) ??
    (() => {
      const rootEl = el.querySelector(':scope > [data-seg-root]')
      return rootEl ? { node: rootEl as Node, offset: 0 } : null
    })()
  if (!pos) return
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  try {
    range.setStart(pos.node, pos.offset)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  } catch (e) {
    // 节点可能尚未挂载（竞态）——放弃本次 caret 恢复
    console.warn('[chat-input] restoreCaret race, skipped', e)
  }
}

/** Chrome 给空 contenteditable 块自动补的占位 <br>（父节点唯一子节点）。
 *  它不是用户换行——四个 DOM↔text 桥函数统一按 0 长处理，否则清空后的
 *  编辑器会被序列化成 '\n'（幻影换行进 payload），caret 换算也会偏 1。 */
function isLoneBr(el: HTMLElement): boolean {
  const p = el.parentNode
  return !!p && p.childNodes.length === 1
}

/** caret 归位：把落在 data-seg-root 之外的 caret 收进包裹层。
 *  Blink 在这种 contenteditable 嵌套结构下会把 caret 放到编辑器根级
 *  （空文档点击、清空后、chip mousedown.prevent 后 focus 残留），甚至
 *  focus 在编辑器而 selection 还挂在别的元素上——此时键入要么在根级
 *  产生游离文本节点（hoist 挪动后 caret 丢失，首字符被挤到文末，实测），
 *  要么整字被吞（selection 在编辑器外时 insertText 静默失败，实测）。
 *  点击（浏览器默认落 caret 之后）与 keydown（键入前）各调一次兜底。 */
function ensureCaretInSegRoot(): void {
  const el = editorRef.value
  if (!el || document.activeElement !== el) return
  const rootEl = el.querySelector(':scope > [data-seg-root]')
  if (!rootEl) return
  const sel = window.getSelection()
  const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
  if (range && rootEl.contains(range.startContainer)) return // 正常 caret/选区不动
  // anchor 在编辑器根级 → 按 DOM 位置换算文本偏移；anchor 不在编辑器内
  // （或根本没有 range）→ 文末（空文档即 0，restoreCaret 有空文档兜底）
  let target = shadowText.length
  if (range && el.contains(range.startContainer)) {
    target = domOffsetToTextOffset(el, range.startContainer, range.startOffset)
  }
  restoreCaret(target)
}

/** 模型文本偏移 → DOM 位置 {node, offset}。扫描 editor 子节点累计
 *  文本/BR/token 长度，命中目标偏移后返回节点 + 节点内偏移。
 *  与 domOffsetToTextOffset 互为反向——同算法正反两遍，保证 roundtrip。
 *  仅在结构事件后 Vue mount 新 children 之后调用——此时编辑器子树是
 *  Vue 挂的干净 vnode 树，扫描无脏 DOM。 */
function textOffsetToDom(root: HTMLElement, target: number): { node: Node; offset: number } | null {
  let acc = 0
  const walk = (n: Node): { node: Node; offset: number } | null => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.textContent ?? '').length
      if (target <= acc + len) {
        return { node: n, offset: target - acc }
      }
      acc += len
      return null
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return null
    const el = n as HTMLElement
    if (el.tagName === 'BR') {
      if (isLoneBr(el)) return null // 空块占位 br：0 长
      if (target <= acc + 1) {
        // <br> 之前：返回父节点 + br 的位置
        const parent = el.parentNode
        if (!parent) return null
        return { node: parent, offset: Array.from(parent.childNodes).indexOf(el) }
      }
      acc += 1
      return null
    }
    if (el.dataset.tokenN) {
      const len = selectionTokenText(Number(el.dataset.tokenN)).length
      if (target <= acc + len) {
        // 目标落在 chip 内（chip 是原子）→ 落到 chip 之后
        const parent = el.parentNode
        if (!parent) return null
        return { node: parent, offset: Array.from(parent.childNodes).indexOf(el) + 1 }
      }
      acc += len
      return null
    }
    for (const child of Array.from(el.childNodes)) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  return walk(root)
}

// ── contenteditable DOM 同步面（DOM-source 路径，ux6 三修） ────────────────
//
// DOM↔text 桥的纯字符串扫描层。syncTextFromDom 不读 selection，只走 DOM
// 子节点 → 文本：chip span（data-token-n）→ 字面 `「@画布选区-N」`；
// <br> → \n；其余文本节点 textContent 拼接。结果与 segmentsToText(segmentsFromText(input))
// 字节等价（半删残串情形除外——残串被切到文本段里，反向还原自然对齐）。
//
/** 打字期归一：浏览器会把新文本节点塞到编辑器根（data-seg-root 包裹层外，
 *  例如空编辑器首字符、caret 在边界时）。游离节点不归 Vue 任何 vnode 管，
 *  结构事件卸载包裹层时它们会幸存 → 与新挂载文本并存即重复（实测 X 删除
 *  后文本翻倍）。每次 @input 扫描前把包裹层外节点按文档序挪回包裹层。 */
function hoistStraysIntoSegRoot(el: HTMLElement): void {
  const rootEl = el.querySelector(':scope > [data-seg-root]')
  if (!rootEl) return
  const before: Node[] = []
  const after: Node[] = []
  let seenRoot = false
  for (const child of Array.from(el.childNodes)) {
    if (child === rootEl) {
      seenRoot = true
      continue
    }
    if (child.nodeType === Node.COMMENT_NODE) continue
    ;(seenRoot ? after : before).push(child)
  }
  for (const n of before.reverse()) {
    const first = rootEl.firstChild
    if (first) first.before(n)
    else rootEl.appendChild(n)
  }
  for (const n of after) rootEl.appendChild(n)
}
// **关键（ux6 三修）**：本函数只写 shadowText（plain `let`）+ hasText.value，
// **不写 input.value / segVersion**。shadowText 是 plain var 不是 ref → Vue
// 响应式系统看不到 → 零重渲。hasText 是唯一允许在打字路径被写的响应式
// 状态——但模板里只有「placeholder 显隐」和「发送按钮 disabled」两处依赖
// 它（DOM 局部更新，不重渲编辑器子树）。这是「打字路径 Vue 编辑器子
// 树渲染次数 = 0」+「按钮 / 占位符实时跟随打字」的硬保证。
// input.value 由 commitStructuralChange 独占（结构事件路径）。

function syncTextFromDom(): string {
  const el = editorRef.value
  if (!el) return shadowText
  hoistStraysIntoSegRoot(el)
  // 腐化签名（2026-09-11）：hoist 之后 seg-root 仍缺席 = Blink 把整个
  // data-seg-root div 从编辑器里吃掉了（空编辑器规范化，唯一会吃 seg-root
  // 的 native 路径）。此路径**严禁**调 commitStructuralChange（同一个 patch
  // 必炸——已游离的旧 seg-root.el 算插入容器得 null → insertBefore 崩溃），
  // 继续走下面的 walk 同步 shadowText 即可：编辑器根级游离文本照样能 walk
  // 读到（草稿恢复源），emit 由父级整树换实例（恢复草稿 + 重挂 seg-root）。
  const segRootMissing = el.querySelector(':scope > [data-seg-root]') === null
  let text = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.dataset.tokenN) {
      const n = Number(el.dataset.tokenN)
      if (Number.isFinite(n)) text += selectionTokenText(n)
      return
    }
    if (el.tagName === 'BR') {
      if (!isLoneBr(el)) text += '\n'
      return
    }
    for (const child of Array.from(el.childNodes)) walk(child)
  }
  walk(el)
  // 归一：去掉 ZWSP 与 CRLF，与旧 textarea 路径字节等价
  const normalized = text.replace(/\u200B/g, '').replace(/\r\n?/g, '\n')
  shadowText = normalized
  hasText.value = normalized.trim().length > 0
  if (segRootMissing && !segRootLostEmitted) {
    segRootLostEmitted = true
    emit('segRootLost', normalized)
  }
  return normalized
}

/** 从 DOM 现扫文本——序列化源（提交 / restoreDraft 时以 DOM 真相为准）。
 *  与 syncTextFromDom 同算法但写 shadowText 是副作用——此函数无副作用，
 *  返回值即"DOM 当前文本"。 */
function readTextFromDom(): string {
  const el = editorRef.value
  if (!el) return shadowText
  let text = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (el.dataset.tokenN) {
      const n = Number(el.dataset.tokenN)
      if (Number.isFinite(n)) text += selectionTokenText(n)
      return
    }
    if (el.tagName === 'BR') {
      if (!isLoneBr(el)) text += '\n'
      return
    }
    for (const child of Array.from(el.childNodes)) walk(child)
  }
  walk(el)
  return text.replace(/\u200B/g, '').replace(/\r\n?/g, '\n')
}

/** 子树文本长度——与 domOffsetToTextOffset / syncTextFromDom 的 walk 计长
 *  同规则（chip → token 字面长、非 lone <br> → 1、其余元素递归子节点）。 */
function nodeTextLength(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').length
  if (n.nodeType !== Node.ELEMENT_NODE) return 0
  const el = n as HTMLElement
  if (el.tagName === 'BR') return isLoneBr(el) ? 0 : 1
  if (el.dataset.tokenN) return selectionTokenText(Number(el.dataset.tokenN)).length
  let len = 0
  for (const child of Array.from(el.childNodes)) len += nodeTextLength(child)
  return len
}

/** DOM 文本位置 → 模型文本偏移：扫描 DOM 子节点累计文本/BR/token 长度，
 *  命中目标节点后返回累计 + offset。
 *  Selection offset 双语义（Range 契约）：锚点是 Text 节点时 offset = 字符
 *  偏移；锚点是 Element 节点时 offset = 子节点索引（restoreCaret 把 caret
 *  落在 chip 之后产生的正是 Element 锚点）——后者必须累加前 offset 个
 *  子节点的文本长度；当字符数直接加会把插入点算进 token 字面中间
 *  （2026-09-14 实测：连采两次，第二个 token 在偏移 4 处劈开第一个）。 */
function domOffsetToTextOffset(root: HTMLElement, node: Node, offset: number): number {
  let acc = 0
  let found = false
  const walk = (n: Node): boolean => {
    if (found) return true
    if (n === node) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(n.childNodes).slice(0, offset)) {
          acc += nodeTextLength(child)
        }
      } else {
        acc += offset
      }
      found = true
      return true
    }
    if (n.nodeType === Node.TEXT_NODE) {
      acc += (n.textContent ?? '').length
      return false
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return false
    const el = n as HTMLElement
    if (el.tagName === 'BR') {
      if (!isLoneBr(el)) acc += 1
      return false
    }
    if (el.dataset.tokenN) {
      acc += selectionTokenText(Number(el.dataset.tokenN)).length
      return false
    }
    for (const child of Array.from(el.childNodes)) {
      if (walk(child)) return true
    }
    return false
  }
  walk(root)
  return acc
}

// 卸载前清理守卫态
onBeforeUnmount(() => {
  // ux6 三修：移除 isComposing ref，无须清理
})

// T24→T61：manifest 数据源不变；失败改显式暴露（错误条 + 重试，08 P0-2）
onMounted(() => {
  void ensurePiStudioManifest()
})

// ── 事件处理（IME / 粘贴 / 键入 / 原子删除，ux6 三修：完全非受控） ───────

function handleCompositionStart() {
  // ux6 三修：IME 守卫移除。浏览器原生 IME 流由 contenteditable 维护，
  // 我们只在 compositionend 读 DOM 同步 shadowText（无响应式触发）。
}

function handleCompositionEnd() {
  // 合成完毕 → DOM 已是确定文本 → 写 shadowText（plain var，零响应式）
  syncTextFromDom()
}

function handleInput() {
  // 打字 / 删除 / IME 中途事件 → DOM 是真相 → 写 shadowText。
  // **不写 input.value**——零响应式触发 → Vue 零重渲 → 编辑器 children
  // 由浏览器独占维护，与 Vue vnode 解耦。
  syncTextFromDom()
}

function handlePaste(event: ClipboardEvent) {
  // 拦截 paste → 只插纯文本（与上一版纪律一致）。这是结构事件（用户
  // 明确意图往文本流里加字符），统一走 commitStructuralChange → Vue
  // 整段重挂 → restoreCaret。
  const text = event.clipboardData?.getData('text/plain')
  if (text == null) return
  event.preventDefault()
  insertTextAtSelection(text)
}

/** 在当前 selection 处插入纯文本。结构事件路径——读 shadowText（DOM 真相）
 *  → 算新文本 → commitStructuralChange（同步 shadowText + input.value +
 *  segVersion++）→ watch → nextTick restoreCaret。 */
function insertTextAtSelection(text: string): void {
  const el = editorRef.value
  const sel = window.getSelection()
  let offset: number
  const anchorNode = sel?.anchorNode ?? null
  if (!el || !sel || sel.rangeCount === 0 || !anchorNode || !el.contains(anchorNode)) {
    offset = shadowText.length // 失焦/选区外 → 追加文末
  } else {
    offset = domOffsetToTextOffset(el, anchorNode, sel.anchorOffset)
  }
  const caretAfter = offset + text.length
  pendingCaretOffset.value = caretAfter
  const next = shadowText.slice(0, offset) + text + shadowText.slice(offset)
  commitStructuralChange(next)
}

function handleKeydown(event: KeyboardEvent) {
  // 键入前兜底 caret 归位（IME 合成期不动——合成串的插入点由浏览器独占维护）
  if (!event.isComposing) ensureCaretInSegRoot()
  // T91p：光标在 0 位且有钉头 chip 时 Backspace 移除 chip（chip 不进文本流，
  // 它是光标前唯一的「东西」；mention chip 行首 Backspace 删除的通行交互）
  if (event.code === 'Backspace' && pinnedSkill.value && !event.isComposing) {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      if (range.collapsed && isCaretAtEditorStart(range)) {
        event.preventDefault()
        pinnedSkill.value = null
        return
      }
    }
  }
  // 删空一击收编（2026-09-11 修复，详见
  // docs/202609112147-chat-input-seg-root-detached-review.md）→ 抽 helper
  // 控制 handleKeydown 复杂度（基线本就贴着 20 阈值）
  if (tryGuardDeletionEmptiesFromKeydown(event)) return
  // T70：Backspace/Delete 紧邻 chip 时原子删除——contenteditable=false 天然原子
  // 浏览器会自动删除整个 chip span + 触发 input 事件；不需要 keydown 拦截。
  // 唯一需要兜底：IME 合成期（浏览器不会删 chip）。
  if ((event.code === 'Backspace' || event.code === 'Delete') && !event.isComposing) {
    if (handleAtomicChipDeletion(event)) return
  }
  if (event.code !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  const target = event.currentTarget
  if (target instanceof HTMLElement) target.closest('form')?.requestSubmit()
}

function isCaretAtEditorStart(range: Range): boolean {
  const el = editorRef.value
  if (!el) return false
  if (range.startContainer !== el && !el.contains(range.startContainer)) return false
  const r = document.createRange()
  r.selectNodeContents(el)
  r.setEnd(range.startContainer, range.startOffset)
  return r.toString().replace(/\u200B/g, '').length === 0
}

/** 从当前 Selection 算出 keydown 视角的删除区间 [s, e)。
 *  collapsed + Backspace → [o-1, o)；collapsed + Delete → [o, o+1)。
 *  非 collapsed → 选区两端各算文本偏移。anchor 不在编辑器内 / 拿不到选区
 *  → null（让浏览器走默认路径）。 */
function selectionToDeletionRange(direction: 'backward' | 'forward'): [number, number] | null {
  const el = editorRef.value
  if (!el) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (range.startContainer !== el && !el.contains(range.startContainer)) return null
  if (range.collapsed) {
    const o = domOffsetToTextOffset(el, range.startContainer, range.startOffset)
    return direction === 'backward' ? [o - 1, o] : [o, o + 1]
  }
  const s = domOffsetToTextOffset(el, range.startContainer, range.startOffset)
  const e = domOffsetToTextOffset(el, range.endContainer, range.endOffset)
  // 防御：浏览器偶发把反向选区（end < start）抛上来——按最小在前归一
  return s <= e ? [s, e] : [e, s]
}

/** 从 InputEvent.getTargetRanges() 拿到的 StaticRange 算出 [s, e)。
 *  beforeinput 的 target ranges 由浏览器基于「这次输入将要修改的 DOM 区段」
 *  算出，是 keydown 看不到的路径（Ctrl+Backspace 词删除、右键剪切等）的
 *  权威层。无 target ranges / 容器不在编辑器内 → null。 */
function staticRangeToDeletionRange(range: StaticRange): [number, number] | null {
  const el = editorRef.value
  if (!el) return null
  if (range.startContainer !== el && !el.contains(range.startContainer)) return null
  if (range.endContainer !== el && !el.contains(range.endContainer)) return null
  const s = domOffsetToTextOffset(el, range.startContainer, range.startOffset)
  const e = domOffsetToTextOffset(el, range.endContainer, range.endOffset)
  return s <= e ? [s, e] : [e, s]
}

/** keydown 入口：判定 Backspace/Delete（合成期跳过）→ 调 guardDeletionEmpties。
 *  返回 true = 已拦截（外层 return）。抽出来是为了压住 handleKeydown 的
 *  复杂度阈值。 */
function tryGuardDeletionEmptiesFromKeydown(event: KeyboardEvent): boolean {
  if (event.code !== 'Backspace' && event.code !== 'Delete') return false
  if (event.isComposing) return false
  return guardDeletionEmpties(event, event.code === 'Backspace' ? 'backward' : 'forward')
}

/** keydown 拦截统一出口：算出 [s, e) → 调 deletionEmptiesDocument →
 *  命中则 preventDefault + commitClearUnlessSegRootMissing，返回 true
 *  表示已拦截（外层应当 return）。 */
function guardDeletionEmpties(event: KeyboardEvent, direction: 'backward' | 'forward'): boolean {
  const range = selectionToDeletionRange(direction)
  if (!range) return false
  const [s, e] = range
  if (!deletionEmptiesDocument(shadowText, s, e)) return false
  event.preventDefault()
  commitClearUnlessSegRootMissing()
  return true
}

/** 清空统一出口：仅 seg-root 健在才走结构事件清空。seg-root 缺席 =
 *  处于腐化窗口（B 方案已 emit、父级重挂在途）——此时 commit 同一个
 *  patch 必炸（已游离的旧 seg-root.el 算插入容器得 null → insertBefore
 *  崩溃），只 preventDefault 阻断浏览器、等重挂即可。事件循环序（emit
 *  同步 → flush microtask → 下一 keydown macrotask）本已使该窗口不可达，
 *  此守卫把它从时序论证升级为结构保证。 */
function commitClearUnlessSegRootMissing(): void {
  const el = editorRef.value
  if (!el || !el.querySelector(':scope > [data-seg-root]')) return
  if (shadowText.length > 0) commitStructuralChange('')
}

/** beforeinput 拦截统一出口：inputType 是删除族且 [s, e) 删空 →
 *  preventDefault + commitClearUnlessSegRootMissing。getTargetRanges 为
 *  空 → 不拦截（让浏览器走默认路径，与既有 getSelection 拿不到同律）。 */
function handleBeforeInput(event: InputEvent): void {
  if (event.isComposing) return
  const t = event.inputType
  const isDelete = t.startsWith('deleteContent') || t === 'deleteByCut'
  if (!isDelete) return
  const ranges = event.getTargetRanges()
  if (ranges.length === 0) return
  const target = ranges[0]
  const range = staticRangeToDeletionRange(target)
  if (!range) return
  const [s, e] = range
  if (!deletionEmptiesDocument(shadowText, s, e)) return
  event.preventDefault()
  commitClearUnlessSegRootMissing()
}

/** 原子 chip 删除兜底：结构事件路径。IME 合成期浏览器不删 chip；
 *  兜底从模型侧删占位串，watch 触发 Vue 整段重建，restoreCaret 落点。 */
function handleAtomicChipDeletion(event: KeyboardEvent): boolean {
  const el = editorRef.value
  if (!el) return false
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return false
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return false
  const dir = event.code === 'Backspace' ? 'backward' : 'forward'
  const offset = domOffsetToTextOffset(el, range.startContainer, range.startOffset)
  const tokens = scanSelectionTokens(shadowText)
  for (const token of tokens) {
    if (dir === 'backward' && token.end === offset) {
      event.preventDefault()
      pendingCaretOffset.value = token.start
      commitStructuralChange(removeSelectionToken(shadowText, token.n))
      return true
    }
    if (dir === 'forward' && token.start === offset) {
      event.preventDefault()
      pendingCaretOffset.value = token.start
      commitStructuralChange(removeSelectionToken(shadowText, token.n))
      return true
    }
  }
  return false
}

function handleCaptureSelection() {
  const store = getActiveEditorStoreOrNull()
  if (!store) return
  const entry = captureSelectionFromStore(store, draftTokens.nextSeq)
  if (!entry) {
    captureEmptyFlash.value = true
    cancelCaptureFlashEnd()
    scheduleCaptureFlashEnd()
    return
  }
  draftTokens.nextSeq += 1
  draftTokens.registry.set(entry.n, entry)
  insertTokenAtSelection(selectionTokenText(entry.n))
}

/** 在当前 selection 处插入 token 字面（采集按钮默认插入路径）。
 *  ux6 三修：DOM 真相（shadowText）+ DOM 偏移 → 算新文本 → commitStructuralChange
 *  → Vue 整段重挂 → restoreCaret 落点。 */
function insertTokenAtSelection(token: string) {
  const el = editorRef.value
  const sel = window.getSelection()
  let offset: number
  const anchorNode = sel?.anchorNode ?? null
  if (!el || !sel || sel.rangeCount === 0 || !anchorNode || !el.contains(anchorNode)) {
    offset = shadowText.length // 采集按钮无焦点/选区外 → 追加文末
  } else {
    offset = domOffsetToTextOffset(el, anchorNode, sel.anchorOffset)
  }
  const caretAfter = offset + token.length
  pendingCaretOffset.value = caretAfter
  commitStructuralChange(shadowText.slice(0, offset) + token + shadowText.slice(offset))
}

/** chip X 按钮：结构事件路径——读 shadowText 找最左匹配 → caret 落删除段
 *  起点 → commitStructuralChange → Vue 整段重挂 → restoreCaret。
 *  打字期由 contenteditable=false 天然原子删除（不会走本函数）；本函数
 *  仅在 IME 期/手动删 chip 触发。 */
function handleRemoveToken(n: number) {
  const tokens = scanSelectionTokens(shadowText)
  const firstMatch = tokens.find((t) => t.n === n)
  if (!firstMatch) return
  pendingCaretOffset.value = firstMatch.start
  commitStructuralChange(removeSelectionToken(shadowText, n))
}

/** contenteditable 上的 mousedown 拦截——chip 自身的 mousedown 阻止默认光标
 *  移动（chip 是 contenteditable=false，浏览器默认会把 selection 放 chip 内） */
function handleChipMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (!target) return
  if (target.closest('.chat-inline-chip')) {
    event.preventDefault()
  }
}

// T21：模型由后端 catalog/指派决定，聊天输入只读展示当前指派
// T25：pi 已是唯一路径（门退役），旧模型/资料切换臂与图片附件流已切除
// T61：T24 ChatModeSelect/ChatStyleProfileSelect 退役——mode/profile 由 chips
// （active_design 回显 + 新建意图暂存）承载
// T65（决策 A/B）：输入条瘦身——只放随下次发送生效的内容（mode/profile chips +
// 模型名 label 暂留）；设计/需求单/gallery 三面板按钮移出，状态查看归 header 的
// 画布工作状态面板（ChatContextBar），gallery 组件删除

// pi-model-explicit-config（§3 落地清单 4）—— piChatInput 现在只在引导门 ready 渲染
//（ChatPanel v-if=isGateReady），指派必然存在；designModelDefault fallback 分支死亡。
// i18n 键 designModelDefault 的删除由主 agent 统一处理（见汇报）。
const piModelLabel = computed(() => piDesignAssignment.value?.modelId ?? '')

// T91p：skill chip（钉头单例内联芯片，替代 T89 文本内 token）——owner 决议：
// skill 是命令不是引用，与选区 token（任意位置、多实例）本质不同；chip 恒钉
// 消息最前、全消息最多一个、新选覆盖旧选。chip 是纯组件状态（pinnedSkill），
// 不进 contenteditable 文本流；视觉上以覆盖层 chip + 编辑器首行
// text-indent 让出首行宽度实现「在输入框内、与正文同行同高」（owner 效果图）。
// 提交时 composeSkillSubmission 把 `/skill:<name>` 拼到消息头；移除靠光标在
// 0 位时按 Backspace。
const skillSearch = ref('')
const skillComboboxOpen = ref(false)
/** 钉头 skill chip（null = 未选）；新选直接覆盖旧选 */
const pinnedSkill = ref<string | null>(null)
const skillChipRef = ref<HTMLElement | null>(null)
/** chip 实测宽度 → 编辑器首行 text-indent（chip 与正文同行衔接） */
const skillChipIndent = ref(0)

watch(pinnedSkill, async () => {
  await nextTick()
  skillChipIndent.value =
    pinnedSkill.value && skillChipRef.value ? skillChipRef.value.offsetWidth : 0
})

const availableSkills = computed(() => {
  const manifest = piStudioManifest.value
  if (!manifest || !manifest.capabilities.agentSkills) return []
  return manifest.skills
})

const filteredSkills = computed(() => {
  const needle = skillSearch.value.trim().toLowerCase()
  if (!needle) return availableSkills.value
  return availableSkills.value.filter(
    (s) => s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle)
  )
})

function handleSkillSelect(event: Event, name: string): void {
  event.preventDefault()
  // 钉头单例：赋值即覆盖旧选
  pinnedSkill.value = name
  skillSearch.value = ''
  skillComboboxOpen.value = false
  // 触发后 refocus 编辑器
  void nextTick(() => {
    editorRef.value?.focus()
  })
}

function handleSubmit(e: Event) {
  e.preventDefault()
  // ux6 三修：序列化源 = DOM 真相（readTextFromDom 现扫），不依赖响应式
  // input.value——避免打字后未触发 input 事件就提交时 input 与 DOM 漂移。
  const text = readTextFromDom().trim()
  // T91p：chip 单独成命令也允许提交（`/skill:<name>` 纯命令，SDK
  // spaceIndex=-1 路径，args 为空）
  if (!text && !pinnedSkill.value) return
  // T70：文本流实扫占位串 → 尾部追加 [画布选区] 清单（发送瞬间 graph 状态
  // 为准；无 token 时 serialize 原样返回）。store 缺席（storybook/测试面）
  // 退化为原文提交。**内嵌 chip 路径与旧 textarea 路径在序列化层完全一致**：
  // shadowText 是 `「@画布选区-N」` 字面流（DOM 字面），serializeSelectionManifest
  // 按既有实扫规则处理——payload 与上一版逐字节等价。
  const store = getActiveEditorStoreOrNull()
  const submission = store
    ? serializeSelectionManifest(text, draftTokens.registry, store.graph)
    : { text }
  // T27 快照先行：emit 即清空文本+登记表，失败回填（restoreDraft）整体恢复
  lastDraftSnapshot = snapshotSelectionDraftState(draftTokens)
  // T91p：chip 拼到消息头（composeSkillSubmission；SDK 命令契约的宿主侧
  // 整形兜底在 backend normalizeSkillCommandText，双层幂等）
  emit('submit', composeSkillSubmission(pinnedSkill.value, submission.text))
  // 提交后清空编辑器——结构事件路径（清空 = 结构从有到无）。
  pendingCaretOffset.value = null
  commitStructuralChange('')
  pinnedSkill.value = null
  resetSelectionDraftState(draftTokens)
}

// T27：父级在提交失败时回填草稿（emit 即清空是即时反馈设计，失败不该丢稿）；
// 用户已另起新输入（或已另选 chip）时不覆盖
// T70：回填文本 = 提交文本剥掉尾部 [画布选区] 清单（占位串本体保留）；
// token 登记表 + 序号从快照一并恢复（快照只消费一次，防旧快照串新稿）
// T91p：提交文本开头的 /skill:<name> 命令拆回 chip 状态（extractLeadingSkillCommand）
// ux6 三修：DOM-source 检查（如果当前 DOM 已有内容就不覆盖）→
// commitStructuralChange → Vue 整段重挂 → restoreCaret 落文末。
function restoreDraft(text: string) {
  if (readTextFromDom().trim() || pinnedSkill.value) return
  const command = extractLeadingSkillCommand(text)
  if (command) pinnedSkill.value = command.name
  const restored = stripSelectionManifest(command ? command.rest : text)
  pendingCaretOffset.value = restored.length
  commitStructuralChange(restored)
  if (lastDraftSnapshot) {
    restoreSelectionDraftState(draftTokens, lastDraftSnapshot)
    lastDraftSnapshot = null
  }
}
// T61：新建意图确认卡「确认并发送」经父级清掉拦截时回填的草稿
// T70：token 登记表/序号/快照随草稿一并清空（序号归 1）
// T91p：chip 状态随草稿一并清空
// ux6 修复：结构事件路径（清空 = 结构变化）
function clearDraft() {
  pendingCaretOffset.value = null
  commitStructuralChange('')
  pinnedSkill.value = null
  resetSelectionDraftState(draftTokens)
  lastDraftSnapshot = null
}
defineExpose({ restoreDraft, clearDraft })

// ux6 三修：模板不依赖 input.value 是否响应变化——segments 永远挂着，
// :key 引用 segVersion。Vue 只在 commitStructuralChange（结构事件路径）
// 改 segVersion 时才重挂整段 children。打字 / IME 路径不写 input.value /
// segVersion / renderLock，**Vue 响应式依赖图零路径** → 零重渲。
</script>

<template>
  <TooltipProvider>
    <div class="shrink-0 border-t border-border p-2.5">
      <!-- T61：manifest 失败显式暴露（chips 禁用联动 ChatModeChips） -->
      <div
        v-if="piStudioManifestFailed"
        data-test-id="chat-manifest-error"
        class="mb-2 flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5"
      >
        <icon-lucide-triangle-alert class="size-3.5 shrink-0 text-red-400" />
        <span class="min-w-0 flex-1 text-[11px] text-red-300">
          {{ chipsText.chipsManifestFailed }}
        </span>
        <button
          type="button"
          data-test-id="chat-manifest-retry"
          class="shrink-0 rounded-md border border-red-500/40 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-500/20"
          @click="retryPiStudioManifest"
        >
          {{ chipsText.chipsRetry }}
        </button>
      </div>
      <!-- T89：actions 行（采集画布选区 + skill dropdown），位于输入控件上方
           一处承载两件事。采集按钮永远渲染；skill dropdown trigger 仅在
           capabilities.agentSkills && skills.length > 0 时渲染 -->
      <div class="mb-2 flex items-center gap-1" data-test-id="chat-actions-row">
        <button
          type="button"
          data-test-id="chat-capture-selection"
          :disabled="isStreaming"
          class="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted hover:border-accent/50 hover:text-surface disabled:cursor-not-allowed disabled:opacity-60"
          @mousedown.prevent
          @click="handleCaptureSelection"
        >
          <icon-lucide-scan class="size-3 shrink-0" />
          <span>
            {{ captureEmptyFlash ? chipsText.chipsCaptureEmpty : chipsText.chipsCaptureSelection }}
          </span>
        </button>
        <ComboboxRoot
          v-if="availableSkills.length > 0"
          v-model:open="skillComboboxOpen"
          :ignore-filter="true"
        >
          <ComboboxAnchor as-child>
            <ComboboxTrigger
              data-test-id="chat-skill-trigger"
              class="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted hover:border-accent/50 hover:text-surface data-[state=open]:border-accent/60 data-[state=open]:text-surface"
              :disabled="isStreaming"
            >
              <icon-lucide-sparkles class="size-3 shrink-0" />
              <span class="truncate">{{ chipsText.chipsSkillChoose }}</span>
              <icon-lucide-chevron-down class="size-3 shrink-0 opacity-60" />
            </ComboboxTrigger>
          </ComboboxAnchor>
          <ComboboxPortal>
            <ComboboxContent
              position="popper"
              :side-offset="4"
              class="z-50 max-h-64 w-max max-w-[min(28rem,calc(100vw-2rem))] min-w-[var(--reka-combobox-anchor-width)] overflow-hidden rounded-md border border-border bg-panel shadow-lg"
            >
              <ComboboxInput
                v-model="skillSearch"
                :placeholder="chipsText.chipsSkillSearchPlaceholder"
                data-test-id="chat-skill-search"
                class="w-full border-b border-border bg-transparent px-2.5 py-1.5 text-[11px] outline-none placeholder:text-muted"
              />
              <ComboboxViewport class="max-h-52 overflow-y-auto p-1">
                <ComboboxItem
                  v-for="skill in filteredSkills"
                  :key="skill.name"
                  :value="skill.name"
                  data-test-id="chat-skill-option"
                  class="flex cursor-pointer flex-col gap-0.5 rounded px-2 py-1 text-[11px] outline-none data-[highlighted]:bg-hover"
                  @select="handleSkillSelect($event, skill.name)"
                >
                  <span class="truncate font-medium text-surface">「/skill:{{ skill.name }}」</span>
                  <span v-if="skill.description" class="truncate text-muted">{{
                    skill.description
                  }}</span>
                  <ComboboxItemIndicator class="hidden" />
                </ComboboxItem>
                <div
                  v-if="filteredSkills.length === 0"
                  class="px-2 py-1 text-[11px] text-muted"
                  data-test-id="chat-skill-empty"
                >
                  {{ chipsText.chipsSkillEmpty }}
                </div>
              </ComboboxViewport>
            </ComboboxContent>
          </ComboboxPortal>
        </ComboboxRoot>
      </div>
      <form @submit="handleSubmit">
        <InputGroup :disabled="isStreaming">
          <!-- ux/inline-selection-chips：内嵌 chip——contenteditable div 承载
               输入/IME/光标；选区 token 段在 DOM 里渲成 contenteditable=false
               原子 chip（含 ChatNodePreview 缩略图 + 「@画布选区-N」标签 + X 按钮）。
               序列化走既有 serializeSelectionManifest（input 文本流是字面
               `「@画布选区-N」`，与上一版逐字节一致）。backdrop/attachment
               slot 全部退役——chip 与正文同行同高、跨行随文。 -->
          <div class="relative">
            <div
              v-if="pinnedSkill"
              ref="skillChipRef"
              aria-hidden="true"
              data-test-id="chat-skill-chip"
              class="pointer-events-none absolute top-2.5 left-3 z-10 flex items-center gap-1 pr-1 text-xs leading-relaxed text-accent"
              :class="{ 'opacity-60': isStreaming }"
            >
              <icon-lucide-sparkles class="size-3.5 shrink-0" />
              <span class="font-medium">{{ pinnedSkill }}</span>
            </div>
            <div
              v-show="!hasText && !pinnedSkill"
              class="pointer-events-none absolute top-2.5 left-3 text-xs leading-relaxed text-muted"
              :style="skillChipIndent > 0 ? { paddingLeft: `${skillChipIndent}px` } : undefined"
            >
              {{ ai.describeChange }}
            </div>
            <div
              ref="editorRef"
              data-test-id="chat-input"
              spellcheck="false"
              role="textbox"
              aria-label="Describe a change"
              :contenteditable="isStreaming ? 'false' : 'true'"
              class="chat-inline-editor block min-h-12 w-full resize-none overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-3 pt-2.5 pb-1 text-xs leading-relaxed text-surface outline-none disabled:cursor-not-allowed disabled:opacity-60"
              :style="skillChipIndent > 0 ? { textIndent: `${skillChipIndent}px` } : undefined"
              @keydown="handleKeydown"
              @beforeinput="handleBeforeInput"
              @input="handleInput"
              @compositionstart="handleCompositionStart"
              @compositionend="handleCompositionEnd"
              @paste="handlePaste"
              @copy.stop
              @cut.stop
              @click="ensureCaretInSegRoot"
              @focus="ensureCaretInSegRoot"
              @mousedown.capture="handleChipMouseDown"
            >
              <div :key="segVersion" v-memo="[segVersion]" data-seg-root>
                <br v-if="segments.length === 0" />
                <template v-for="(seg, idx) in segments" :key="`seg-${idx}`">
                  <span
                    v-if="seg.kind === 'token'"
                    contenteditable="false"
                    :data-token-n="seg.n"
                    class="chat-inline-chip"
                    data-test-id="chat-token-chip"
                  >
                    <ChatNodePreview
                      v-if="chipForN(seg.n)"
                      :node-id="chipForN(seg.n)!.preview.nodeId"
                      :page-id="chipForN(seg.n)!.preview.pageId"
                      :graph="chipRenderContext().graph"
                      :renderer="chipRenderContext().renderer"
                    />
                    <span v-else class="chat-inline-chip-placeholder" aria-hidden="true"></span>
                    <span class="chat-inline-chip-inner">{{ chipLabelForN(seg.n) }}</span>
                    <button
                      type="button"
                      class="chat-inline-chip-x"
                      aria-label="移除引用"
                      :data-token-n="seg.n"
                      @mousedown.prevent
                      @click.stop="handleRemoveToken(seg.n)"
                    >
                      <icon-lucide-x class="size-3" />
                    </button>
                  </span>
                  <template v-else>
                    <template
                      v-for="(line, lineIdx) in seg.text.split('\n')"
                      :key="`line-${idx}-${lineIdx}`"
                    >
                      <br v-if="lineIdx > 0" />
                      <span>{{ line }}</span>
                    </template>
                  </template>
                </template>
              </div>
            </div>
          </div>

          <template #model>
            <div class="flex min-w-0 items-center">
              <div
                class="flex min-w-0 items-center gap-1 px-1.5 text-[10px] text-muted"
                data-test-id="chat-pi-model-label"
              >
                <icon-lucide-bot class="size-3 shrink-0" />
                <span class="truncate">{{ piModelLabel }}</span>
                <ChatModeChips :disabled="isStreaming" />
              </div>
            </div>
          </template>

          <template #actions>
            <IconButton
              :label="ai.providerSettings"
              size="sm"
              data-test-id="provider-settings-trigger"
              @click="openSettingsDialog('ai')"
            >
              <icon-lucide-settings class="size-3.5" />
            </IconButton>
            <IconButton
              v-if="isStreaming"
              :label="ai.stopGenerating"
              size="sm"
              data-test-id="chat-stop-button"
              class="border border-border"
              @click="emit('stop')"
            >
              <icon-lucide-square class="size-3" />
            </IconButton>
            <IconButton
              v-else
              :label="ai.sendMessage"
              size="sm"
              type="submit"
              data-test-id="chat-send-button"
              class="bg-accent text-white hover:bg-accent/90 hover:text-white"
              :disabled="!hasText"
            >
              <icon-lucide-send class="size-3.5" />
            </IconButton>
          </template>
        </InputGroup>
      </form>
    </div>
  </TooltipProvider>
</template>

<style scoped>
/* contenteditable 内嵌 chip 样式——与正文同行同高、原子边界 */
.chat-inline-editor :deep(.chat-inline-chip) {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin: 0 1px;
  padding: 1px 2px 1px 4px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-panel-field);
  vertical-align: baseline;
  white-space: nowrap;
  /* T91p 的 skillChipIndent 用 text-indent 让首行避开钉头 skill chip；
     text-indent 可继承——chip-inner 是 flex item 被块级化后会把继承来的
     indent 算进自己的内容宽（实测 label 8 字被撑到 254px → chip 302px）。
     在 chip 上归零，子级继承 0。 */
  text-indent: 0;
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
}

.chat-inline-editor :deep(.chat-inline-chip-inner) {
  font-size: 11px;
  color: var(--color-surface);
  line-height: 1.2;
}

.chat-inline-editor :deep(.chat-inline-chip-x) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: var(--color-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}

.chat-inline-editor :deep(.chat-inline-chip-x:hover) {
  background: var(--color-hover);
  color: var(--color-surface);
}
</style>
