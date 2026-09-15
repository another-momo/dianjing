/**
 * ask_user_question 卡片 reducer 行为钉扎（波3 阶段一抽纯后的回归矩阵）。
 *
 * 范围：src/components/assistant/ask/reducer.ts 暴露的所有 action 路径——
 * 行为基线 = 波2 L3 验证通过的行为全集 + AskUserQuestionCard.vue 原状。
 * 卡片 script 改造后本测试充当卡片交互层的纯函数回归网。
 */
import { describe, expect, test } from 'bun:test'

import {
  FREE_TEXT_OPTION_ID,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'

import {
  createAskCardState,
  isSubmittable,
  reduceAskCard,
  type AskCardContext,
  type AskCardState
} from '@/components/assistant/ask/reducer'

function single(id: string, extra: Partial<AskQuestionSpec> = {}): AskQuestionSpec {
  return {
    id,
    kind: 'single_select',
    label: `问题 ${id}`,
    required: true,
    options: [
      { id: 'a', label: '选项 A', hint: '提示' },
      { id: 'b', label: '选项 B' }
    ],
    ...extra
  }
}
function multi(id: string): AskQuestionSpec {
  return {
    id,
    kind: 'multi_select',
    label: `问题 ${id}`,
    required: true,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ]
  }
}
function image(id: string): AskQuestionSpec {
  return {
    id,
    kind: 'image_select',
    label: `问题 ${id}`,
    required: true,
    imageOptions: [
      { nodeId: '0:1', label: '帧1' },
      { nodeId: '0:2', label: '帧2' }
    ]
  }
}
function text(id: string, required = true): AskQuestionSpec {
  return { id, kind: 'text', label: `问题 ${id}`, required }
}

function freshCtx(questions: AskQuestionSpec[], isLocked = false): AskCardContext {
  return { questions, isLocked }
}

function snapshot(state: AskCardState) {
  return {
    currentIndex: state.currentIndex,
    answers: structuredClone(state.answers),
    submittedKind: state.submittedKind,
    showRequiredHint: state.showRequiredHint,
    globalNotes: state.globalNotes,
    previewFocus: { ...state.previewFocus }
  }
}

/** single_select + 选项 a 带 preview 的最小题集（波3 阶段二契约层已就位） */
function singleWithPreview(id: string): AskQuestionSpec {
  return {
    id,
    kind: 'single_select',
    label: `问题 ${id}`,
    required: true,
    options: [
      { id: 'a', label: '选项 A', preview: '**A 详情**\n- 用途1\n- 用途2' },
      { id: 'b', label: '选项 B' }
    ]
  }
}

describe('createAskCardState 初值工厂', () => {
  test('零副作用默认：空 answers / 0 页 / 无 hint / 无备注 / 未提交 / 焦点空', () => {
    const s = createAskCardState()
    expect(s.currentIndex).toBe(0)
    expect(s.answers).toEqual({})
    expect(s.submittedKind).toBeNull()
    expect(s.showRequiredHint).toBe(false)
    expect(s.globalNotes).toBe('')
    expect(s.previewFocus).toEqual({})
  })
})

describe('ensureSlots：questions 流式到达补槽 + 锁定钳末尾', () => {
  test('新题到 → 槽位恒存在；锁定后再到题不抢光当前页', () => {
    const s = createAskCardState()
    const q = [single('q1'), single('q2')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    expect(snapshot(s).answers).toEqual({ q1: {}, q2: {} })

    // 模拟 questions 扩展到 4 题；用户停在第 1 题（index=1）但被外部锁定
    s.currentIndex = 1
    const expanded = [single('q1'), single('q2'), single('q3'), single('q4')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(expanded, true))
    // 锁定态：currentIndex 不被钳（保持原位）
    expect(s.currentIndex).toBe(1)
    expect(Object.keys(s.answers).sort()).toEqual(['q1', 'q2', 'q3', 'q4'])

    // 未锁定 + currentIndex 超界 → 钳到末尾
    const s2 = createAskCardState()
    s2.currentIndex = 99
    reduceAskCard(s2, { type: 'ensureSlots' }, freshCtx([single('q1'), single('q2'), single('q3')]))
    expect(s2.currentIndex).toBe(2)
  })

  test('questions 为空 + 未锁定：不钳末尾（保持 currentIndex 越界后续 goTo 早退）', () => {
    const s = createAskCardState()
    s.currentIndex = 5
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx([]))
    // length=0 时不进钳末尾分支（length>0 才生效）
    expect(s.currentIndex).toBe(5)
  })
})

describe('selectSingleOption：单选动作 + 波2 自动翻规则', () => {
  test('普通选项：清空 freeText；≥2 题非末题自动翻；末题原地', () => {
    const s = createAskCardState()
    const q = [single('q1'), single('q2'), single('q3')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    // 先把 freeText 留痕，验证清空
    s.answers['q1'] = { value: FREE_TEXT_OPTION_ID, freeText: '已留痕' }
    reduceAskCard(s, { type: 'selectSingleOption', questionId: 'q1', optionId: 'a' }, freshCtx(q))
    expect(s.answers['q1']).toEqual({ value: 'a' })
    expect(s.currentIndex).toBe(1)

    // 末题原地
    s.currentIndex = 2
    reduceAskCard(s, { type: 'selectSingleOption', questionId: 'q3', optionId: 'b' }, freshCtx(q))
    expect(s.currentIndex).toBe(2)
  })

  test('1 题：单选不自动翻（usePaginate=false）', () => {
    const s = createAskCardState()
    const q = [single('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    reduceAskCard(s, { type: 'selectSingleOption', questionId: 'q1', optionId: 'a' }, freshCtx(q))
    expect(s.currentIndex).toBe(0)
  })

  test('选「其他」：保留 freeText；不自动翻', () => {
    const s = createAskCardState()
    const q = [single('q1'), single('q2')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { value: FREE_TEXT_OPTION_ID, freeText: '我的想法' }
    reduceAskCard(
      s,
      { type: 'selectSingleOption', questionId: 'q1', optionId: FREE_TEXT_OPTION_ID },
      freshCtx(q)
    )
    expect(s.answers['q1']).toEqual({ value: FREE_TEXT_OPTION_ID, freeText: '我的想法' })
    expect(s.currentIndex).toBe(0)
  })
})

describe('selectImageOption：image 选择不动翻页', () => {
  test('image_select 选中不自动翻（grid 选项多）', () => {
    const s = createAskCardState()
    const q = [image('q1'), image('q2')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    reduceAskCard(s, { type: 'selectImageOption', questionId: 'q1', nodeId: '0:2' }, freshCtx(q))
    expect(s.answers['q1']).toEqual({ value: '0:2' })
    expect(s.currentIndex).toBe(0)
  })

  test('image 「其他」：保留 freeText；不自动翻', () => {
    const s = createAskCardState()
    const q = [image('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { value: FREE_TEXT_OPTION_ID, freeText: '自填' }
    reduceAskCard(
      s,
      { type: 'selectImageOption', questionId: 'q1', nodeId: FREE_TEXT_OPTION_ID },
      freshCtx(q)
    )
    expect(s.answers['q1']).toEqual({ value: FREE_TEXT_OPTION_ID, freeText: '自填' })
  })
})

describe('toggleMultiOption：multi_select 勾上/取消 + 「其他」联动', () => {
  test('普通选项勾上/取消：values 数组维护正确；不污染 freeText', () => {
    const s = createAskCardState()
    const q = [multi('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    reduceAskCard(s, { type: 'toggleMultiOption', questionId: 'q1', optionId: 'a' }, freshCtx(q))
    expect(s.answers['q1']?.values).toEqual(['a'])
    reduceAskCard(s, { type: 'toggleMultiOption', questionId: 'q1', optionId: 'b' }, freshCtx(q))
    expect(s.answers['q1']?.values).toEqual(['a', 'b'])
    reduceAskCard(s, { type: 'toggleMultiOption', questionId: 'q1', optionId: 'a' }, freshCtx(q))
    expect(s.answers['q1']?.values).toEqual(['b'])
  })

  test('「其他」勾选：保留已有 freeText（空串/null 保留 undefined）', () => {
    const s = createAskCardState()
    const q = [multi('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { values: ['a'], freeText: '草稿' }
    reduceAskCard(
      s,
      { type: 'toggleMultiOption', questionId: 'q1', optionId: FREE_TEXT_OPTION_ID },
      freshCtx(q)
    )
    expect(s.answers['q1']?.values).toEqual(['a', FREE_TEXT_OPTION_ID])
    expect(s.answers['q1']?.freeText).toBe('草稿')
  })

  test('「其他」取消：清空 freeText（置 undefined）', () => {
    const s = createAskCardState()
    const q = [multi('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { values: ['a', FREE_TEXT_OPTION_ID], freeText: '草稿' }
    reduceAskCard(
      s,
      { type: 'toggleMultiOption', questionId: 'q1', optionId: FREE_TEXT_OPTION_ID },
      freshCtx(q)
    )
    expect(s.answers['q1']?.values).toEqual(['a'])
    expect(s.answers['q1']?.freeText).toBeUndefined()
  })

  test('从空槽勾「其他」：freeText 保留旧值（若有）', () => {
    const s = createAskCardState()
    const q = [multi('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    reduceAskCard(
      s,
      { type: 'toggleMultiOption', questionId: 'q1', optionId: FREE_TEXT_OPTION_ID },
      freshCtx(q)
    )
    expect(s.answers['q1']?.values).toEqual([FREE_TEXT_OPTION_ID])
    // current 为空槽时 current?.freeText 为 undefined → 入参 undefined
    expect(s.answers['q1']?.freeText).toBeUndefined()
  })
})

describe('文本/freeText/单题 notes/globalNotes 写入', () => {
  test('setText 写入 value；合并既有 freeText/notes 不丢', () => {
    const s = createAskCardState()
    const q = [text('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { freeText: '保留' }
    reduceAskCard(s, { type: 'setText', questionId: 'q1', value: '正文' }, freshCtx(q))
    expect(s.answers['q1']).toEqual({ freeText: '保留', value: '正文' })
  })

  test('setFreeText 写入；保留 value（普通选项卡「其他」展开后输入框）', () => {
    const s = createAskCardState()
    const q = [single('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { value: FREE_TEXT_OPTION_ID }
    reduceAskCard(s, { type: 'setFreeText', questionId: 'q1', freeText: '我的想法' }, freshCtx(q))
    expect(s.answers['q1']).toEqual({ value: FREE_TEXT_OPTION_ID, freeText: '我的想法' })
  })

  test('setNotes 写入；与作答字段解耦', () => {
    const s = createAskCardState()
    const q = [{ ...single('q1'), notes: true }]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { value: 'a' }
    reduceAskCard(s, { type: 'setNotes', questionId: 'q1', notes: '补充' }, freshCtx(q))
    expect(s.answers['q1']).toEqual({ value: 'a', notes: '补充' })
  })

  test('setGlobalNotes 写入顶部 globalNotes', () => {
    const s = createAskCardState()
    reduceAskCard(s, { type: 'setGlobalNotes', notes: '全局' }, freshCtx([]))
    expect(s.globalNotes).toBe('全局')
  })
})

describe('goTo / goNext / goPrev：翻页边界 + hint 清零', () => {
  test('goTo 边界：<0 / ≥length / 锁定态早退；合法 index 翻页 + 清 hint', () => {
    const s = createAskCardState()
    const q = [single('q1'), single('q2'), single('q3')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.showRequiredHint = true
    reduceAskCard(s, { type: 'goTo', index: -1 }, freshCtx(q))
    expect(s.currentIndex).toBe(0)
    reduceAskCard(s, { type: 'goTo', index: 99 }, freshCtx(q))
    expect(s.currentIndex).toBe(0)
    expect(s.showRequiredHint).toBe(true)
    reduceAskCard(s, { type: 'goTo', index: 1 }, freshCtx(q))
    expect(s.currentIndex).toBe(1)
    expect(s.showRequiredHint).toBe(false)

    // 锁定态 goTo 早退
    s.showRequiredHint = true
    reduceAskCard(s, { type: 'goTo', index: 2 }, freshCtx(q, true))
    expect(s.currentIndex).toBe(1)
    expect(s.showRequiredHint).toBe(true)
  })

  test('goNext：非末题翻页 + 清 hint；末题原地', () => {
    const s = createAskCardState()
    const q = [single('q1'), single('q2')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.showRequiredHint = true
    reduceAskCard(s, { type: 'goNext' }, freshCtx(q))
    expect(s.currentIndex).toBe(1)
    expect(s.showRequiredHint).toBe(false)
    reduceAskCard(s, { type: 'goNext' }, freshCtx(q))
    expect(s.currentIndex).toBe(1)
  })

  test('goPrev：非首页翻页 + 清 hint；首页原地', () => {
    const s = createAskCardState()
    const q = [single('q1'), single('q2')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.currentIndex = 1
    s.showRequiredHint = true
    reduceAskCard(s, { type: 'goPrev' }, freshCtx(q))
    expect(s.currentIndex).toBe(0)
    expect(s.showRequiredHint).toBe(false)
    reduceAskCard(s, { type: 'goPrev' }, freshCtx(q))
    expect(s.currentIndex).toBe(0)
  })
})

describe('attemptSubmit：缺答跳首未答 + 全答路径', () => {
  test('缺答：hint 翻 true + 跳首个未答；1 题无壳时不跳（已在当前页）', () => {
    const s = createAskCardState()
    const q = [single('q1'), single('q2'), single('q3')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { value: 'a' }
    s.currentIndex = 0
    reduceAskCard(s, { type: 'attemptSubmit' }, freshCtx(q))
    expect(s.showRequiredHint).toBe(true)
    expect(s.currentIndex).toBe(1)

    // 1 题场景：currentIndex 不动
    const s2 = createAskCardState()
    const q1 = [single('only')]
    reduceAskCard(s2, { type: 'ensureSlots' }, freshCtx(q1))
    reduceAskCard(s2, { type: 'attemptSubmit' }, freshCtx(q1))
    expect(s2.showRequiredHint).toBe(true)
    expect(s2.currentIndex).toBe(0)
  })

  test('全答：hint 不翻、可提交', () => {
    const s = createAskCardState()
    const q = [single('q1'), single('q2')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { value: 'a' }
    s.answers['q2'] = { value: 'b' }
    s.showRequiredHint = true
    reduceAskCard(s, { type: 'attemptSubmit' }, freshCtx(q))
    expect(s.showRequiredHint).toBe(true) // reducer 不主动清，全答路径也不动 hint（卡片按 missingRequired 渲染）
    expect(isSubmittable(s, freshCtx(q))).toBe(true)
  })

  test('「其他」空 freeText 视为缺答：attemptSubmit 触发 hint', () => {
    const s = createAskCardState()
    const q = [single('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    s.answers['q1'] = { value: FREE_TEXT_OPTION_ID, freeText: '   ' }
    reduceAskCard(s, { type: 'attemptSubmit' }, freshCtx(q))
    expect(s.showRequiredHint).toBe(true)
  })
})

describe('markSubmitted：幂等且不抹', () => {
  test('answer / skip 标记写入；再次 markSubmitted 覆盖为最新 kind', () => {
    const s = createAskCardState()
    const q = [single('q1')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    reduceAskCard(s, { type: 'markSubmitted', kind: 'answer' }, freshCtx(q))
    expect(s.submittedKind).toBe('answer')
    reduceAskCard(s, { type: 'markSubmitted', kind: 'skip' }, freshCtx(q))
    expect(s.submittedKind).toBe('skip')
  })
})

describe('setPreviewFocus：preview 面板焦点写入 + 隔离 + 不清', () => {
  test('写入：单题多次写入覆盖为最新 optionId', () => {
    const s = createAskCardState()
    const q = [singleWithPreview('q1')]
    reduceAskCard(s, { type: 'setPreviewFocus', questionId: 'q1', optionId: 'a' }, freshCtx(q))
    expect(s.previewFocus).toEqual({ q1: 'a' })
    reduceAskCard(s, { type: 'setPreviewFocus', questionId: 'q1', optionId: 'b' }, freshCtx(q))
    expect(s.previewFocus).toEqual({ q1: 'b' })
  })

  test('多题隔离：不同 qid 互不覆盖', () => {
    const s = createAskCardState()
    const q = [singleWithPreview('q1'), singleWithPreview('q2')]
    reduceAskCard(s, { type: 'setPreviewFocus', questionId: 'q1', optionId: 'a' }, freshCtx(q))
    reduceAskCard(s, { type: 'setPreviewFocus', questionId: 'q2', optionId: 'b' }, freshCtx(q))
    expect(s.previewFocus).toEqual({ q1: 'a', q2: 'b' })
    // 翻 q2 后改 q2 焦点，q1 不动
    reduceAskCard(s, { type: 'setPreviewFocus', questionId: 'q2', optionId: 'a' }, freshCtx(q))
    expect(s.previewFocus).toEqual({ q1: 'a', q2: 'a' })
  })

  test('翻题 / ensureSlots 不清焦点：翻页与流式到题都保留已有 qid 焦点', () => {
    const s = createAskCardState()
    const q = [singleWithPreview('q1'), singleWithPreview('q2')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    reduceAskCard(s, { type: 'setPreviewFocus', questionId: 'q1', optionId: 'a' }, freshCtx(q))
    expect(s.previewFocus).toEqual({ q1: 'a' })

    // 翻页（goTo / goNext / goPrev）不动 previewFocus
    reduceAskCard(s, { type: 'goTo', index: 1 }, freshCtx(q))
    reduceAskCard(s, { type: 'goPrev' }, freshCtx(q))
    reduceAskCard(s, { type: 'goNext' }, freshCtx(q))
    expect(s.previewFocus).toEqual({ q1: 'a' })

    // 流式扩展到 4 题 + ensureSlots：q1 焦点保留
    const expanded = [singleWithPreview('q1'), singleWithPreview('q2'), single('q3'), single('q4')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(expanded))
    expect(s.previewFocus).toEqual({ q1: 'a' })
  })

  test('已选「其他」/ 已锁定 / submit 路径都不影响 previewFocus', () => {
    const s = createAskCardState()
    const q = [singleWithPreview('q1'), single('q2')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    reduceAskCard(s, { type: 'setPreviewFocus', questionId: 'q1', optionId: 'a' }, freshCtx(q))
    reduceAskCard(
      s,
      { type: 'selectSingleOption', questionId: 'q1', optionId: FREE_TEXT_OPTION_ID },
      freshCtx(q)
    )
    expect(s.previewFocus).toEqual({ q1: 'a' })

    reduceAskCard(s, { type: 'attemptSubmit' }, freshCtx(q))
    expect(s.previewFocus).toEqual({ q1: 'a' })

    reduceAskCard(s, { type: 'markSubmitted', kind: 'answer' }, freshCtx(q))
    expect(s.previewFocus).toEqual({ q1: 'a' })
  })
})

describe('快照：典型交互链 不变量', () => {
  test('3 题 single_select 全答路径：ensureSlots → 选 a → 翻 q2 → 选 a → 翻 q3 → 选 b → 原地', () => {
    const s = createAskCardState()
    const q = [single('q1'), single('q2'), single('q3')]
    reduceAskCard(s, { type: 'ensureSlots' }, freshCtx(q))
    expect(snapshot(s)).toEqual({
      currentIndex: 0,
      answers: { q1: {}, q2: {}, q3: {} },
      submittedKind: null,
      showRequiredHint: false,
      globalNotes: '',
      previewFocus: {}
    })

    reduceAskCard(s, { type: 'selectSingleOption', questionId: 'q1', optionId: 'a' }, freshCtx(q))
    expect(snapshot(s).answers['q1']).toEqual({ value: 'a' })
    expect(s.currentIndex).toBe(1)

    reduceAskCard(s, { type: 'selectSingleOption', questionId: 'q2', optionId: 'a' }, freshCtx(q))
    expect(snapshot(s).answers['q2']).toEqual({ value: 'a' })
    expect(s.currentIndex).toBe(2)

    reduceAskCard(s, { type: 'selectSingleOption', questionId: 'q3', optionId: 'b' }, freshCtx(q))
    expect(snapshot(s).answers['q3']).toEqual({ value: 'b' })
    expect(s.currentIndex).toBe(2) // 末题原地
  })
})
