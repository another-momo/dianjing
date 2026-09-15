/**
 * ask_user_question 卡片提交归一（normalizeForSubmit）行为钉扎。
 *
 * 原样搬迁自 AskUserQuestionCard.vue 306-375 行；波2 修复保留：
 *  - notes 携带规则（spec.notes===true 时 trim 非空白才带）
 *  - 「其他」空 freeText → 视为未作答，不落键
 *  - 空键 / 空数组丢弃
 */
import { describe, expect, test } from 'bun:test'

import {
  FREE_TEXT_OPTION_ID,
  type AskQuestionAnswer,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'

import { hasContent, normalizeForSubmit } from '@/components/assistant/ask/submit'

function single(id: string, extra: Partial<AskQuestionSpec> = {}): AskQuestionSpec {
  return {
    id,
    kind: 'single_select',
    label: `问题 ${id}`,
    required: true,
    options: [
      { id: 'a', label: '选项 A' },
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
    imageOptions: [{ nodeId: '0:1', label: '帧1' }]
  }
}
function text(id: string, required = true): AskQuestionSpec {
  return { id, kind: 'text', label: `问题 ${id}`, required }
}

describe('hasContent：至少一个有效字段', () => {
  test('value / values / notes 任一即真；空对象假', () => {
    expect(hasContent({ value: 'x' })).toBe(true)
    expect(hasContent({ values: ['a'] })).toBe(true)
    expect(hasContent({ notes: 'n' })).toBe(true)
    expect(hasContent({})).toBe(false)
    expect(hasContent({ value: undefined, values: undefined, notes: undefined })).toBe(false)
  })
})

describe('normalizeText：trim 后空白丢弃', () => {
  test('非空白 → { value }；空白 / undefined → 空对象（落键被 hasContent 拦下）', () => {
    const q = text('q1')
    expect(normalizeForSubmit([q], { q1: { value: '  正文  ' } })).toEqual({
      q1: { value: '正文' }
    })
    expect(normalizeForSubmit([q], { q1: { value: '   ' } })).toEqual({})
    expect(normalizeForSubmit([q], { q1: { value: '' } })).toEqual({})
    expect(normalizeForSubmit([q], { q1: {} })).toEqual({})
  })
})

describe('normalizeSingleSelect：非空字符串原样落键', () => {
  test('普通选项原样；空字符串视为无内容', () => {
    const q = single('q1')
    expect(normalizeForSubmit([q], { q1: { value: 'a' } })).toEqual({ q1: { value: 'a' } })
    expect(normalizeForSubmit([q], { q1: { value: '' } })).toEqual({})
    expect(normalizeForSubmit([q], { q1: { value: FREE_TEXT_OPTION_ID } })).toEqual({}) // 不带 freeText 时视为未答
  })
})

describe('normalizeFreeText：「其他」+ 非空 freeText 落键', () => {
  test('freeText 非空白 → { value, freeText }；空白 → 空对象', () => {
    const q = single('q1')
    expect(
      normalizeForSubmit([q], { q1: { value: FREE_TEXT_OPTION_ID, freeText: '我的想法' } })
    ).toEqual({
      q1: { value: FREE_TEXT_OPTION_ID, freeText: '我的想法' }
    })
    expect(
      normalizeForSubmit([q], { q1: { value: FREE_TEXT_OPTION_ID, freeText: '   ' } })
    ).toEqual({})
    // 不带 freeText 时也走 freeText 归一
    expect(normalizeForSubmit([q], { q1: { value: FREE_TEXT_OPTION_ID } })).toEqual({})
  })
})

describe('normalizeMulti：数组过滤空白 + 「其他」+空 freeText 清掉', () => {
  test('普通 values：过滤空白值后非空才落键', () => {
    const q = multi('q1')
    expect(normalizeForSubmit([q], { q1: { values: ['a', 'b'] } })).toEqual({
      q1: { values: ['a', 'b'] }
    })
    expect(normalizeForSubmit([q], { q1: { values: ['a', '  ', ''] } })).toEqual({
      q1: { values: ['a'] }
    })
    expect(normalizeForSubmit([q], { q1: { values: [] } })).toEqual({})
  })

  test('「其他」+ 非空白 freeText：values 含 FREE_TEXT_OPTION_ID + freeText 落键', () => {
    const q = multi('q1')
    expect(
      normalizeForSubmit([q], { q1: { values: ['a', FREE_TEXT_OPTION_ID], freeText: '我的想法' } })
    ).toEqual({ q1: { values: ['a', FREE_TEXT_OPTION_ID], freeText: '我的想法' } })
  })

  test('「其他」+ 空白 freeText：FREE_TEXT_OPTION_ID 被剔除（让必填拦下）', () => {
    const q = multi('q1')
    expect(
      normalizeForSubmit([q], { q1: { values: ['a', FREE_TEXT_OPTION_ID], freeText: '   ' } })
    ).toEqual({ q1: { values: ['a'] } })
    // 全是 freeText+空白 → values 整段丢弃
    expect(
      normalizeForSubmit([q], { q1: { values: [FREE_TEXT_OPTION_ID], freeText: '' } })
    ).toEqual({})
  })

  test('非字符串 / 非数组 values 防御', () => {
    const q = multi('q1')
    // 强转测试防御分支：string 而非数组 → cleaned=[]
    expect(normalizeForSubmit([q], { q1: { values: 'oops' as unknown as string[] } })).toEqual({})
  })
})

describe('image_select：与 single_select 同律', () => {
  test('普通 nodeId → { value }；空值丢弃', () => {
    const q = image('q1')
    expect(normalizeForSubmit([q], { q1: { value: '0:1' } })).toEqual({ q1: { value: '0:1' } })
    expect(normalizeForSubmit([q], { q1: { value: '' } })).toEqual({})
  })
})

describe('notes 携带规则：spec.notes===true + trim 非空白才带', () => {
  test('spec.notes=true + 非空白 notes → 携带；空白 notes → 丢弃', () => {
    const q = single('q1', { notes: true })
    expect(normalizeForSubmit([q], { q1: { value: 'a', notes: '  笔记  ' } })).toEqual({
      q1: { value: 'a', notes: '笔记' }
    })
    expect(normalizeForSubmit([q], { q1: { value: 'a', notes: '   ' } })).toEqual({
      q1: { value: 'a' }
    })
  })

  test('spec.notes 缺省 / false → notes 字段不被采集', () => {
    const q1 = single('q1') // notes 缺省
    const q2 = single('q2', { notes: false })
    expect(
      normalizeForSubmit([q1, q2], {
        q1: { value: 'a', notes: '不应携带' },
        q2: { value: 'b', notes: '也不应' }
      })
    ).toEqual({ q1: { value: 'a' }, q2: { value: 'b' } })
  })

  test('notes 独立于作答：未作答的题若 spec.notes=true 仍可携带笔记（与作答解耦）', () => {
    const q = single('q1', { notes: true })
    // 未选值，仅 notes 非空白——hasContent 看 notes 也算有效字段 → 落键
    expect(normalizeForSubmit([q], { q1: { notes: '草稿' } })).toEqual({
      q1: { notes: '草稿' }
    })
    // 全空白 → 不落键
    expect(normalizeForSubmit([q], { q1: { notes: '   ' } })).toEqual({})
  })
})

describe('缺槽 / 跳过题不阻断其它题归一', () => {
  test('某题未出现在 answers 表 → 跳过；其余题按各自规则归一', () => {
    const qs = [single('q1'), single('q2'), text('q3', false)]
    const answers: Record<string, AskQuestionAnswer> = {
      q1: { value: 'a' },
      // q2 缺
      q3: { value: '备注' }
    }
    expect(normalizeForSubmit(qs, answers)).toEqual({
      q1: { value: 'a' },
      q3: { value: '备注' }
    })
  })
})

describe('真实多题型组合归一', () => {
  test('Case B 风格四题型 + notes + freeText 全路径', () => {
    const qs: AskQuestionSpec[] = [
      single('q1'),
      single('q2', { notes: true }),
      text('q3', false),
      single('q4')
    ]
    const answers: Record<string, AskQuestionAnswer> = {
      q1: { value: 'a' },
      q2: { value: FREE_TEXT_OPTION_ID, freeText: '我的想法', notes: '  草稿  ' },
      q3: { value: '正文' },
      q4: { value: 'x', notes: '不应携带' } // q4 spec.notes 缺省
    }
    expect(normalizeForSubmit(qs, answers)).toEqual({
      q1: { value: 'a' },
      q2: { value: FREE_TEXT_OPTION_ID, freeText: '我的想法', notes: '草稿' },
      q3: { value: '正文' },
      q4: { value: 'x' }
    })
  })
})
