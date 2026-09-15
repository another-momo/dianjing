/**
 * ask_user_question 卡片答案摘要纯函数（labelForOption / summarizeAnswer）行为钉扎。
 *
 * 原样搬迁自 AskUserQuestionCard.vue 427-455 行；i18n 文案以入参方式注入，避免
 * pure module 反向依赖 useForkAsk。
 */
import { describe, expect, test } from 'bun:test'

import {
  FREE_TEXT_OPTION_ID,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'

import {
  labelForOption,
  summarizeAnswer,
  type AskDialogStrings
} from '@/components/assistant/ask/summary'

const strings: AskDialogStrings = { askOtherOption: '其他' }

function single(id: string): AskQuestionSpec {
  return {
    id,
    kind: 'single_select',
    label: `问题 ${id}`,
    required: true,
    options: [
      { id: 'a', label: '选项 A', hint: '提示' },
      { id: 'b', label: '选项 B' }
    ]
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
    imageOptions: [{ nodeId: '0:1', label: '帧1' }, { nodeId: '0:2' }]
  }
}

describe('labelForOption', () => {
  test('FREE_TEXT_OPTION_ID → 「其他」文案（与 kind 无关）', () => {
    const q = single('q1')
    const qi = image('qi')
    expect(labelForOption(q, FREE_TEXT_OPTION_ID, strings)).toBe('其他')
    expect(labelForOption(qi, FREE_TEXT_OPTION_ID, strings)).toBe('其他')
  })

  test('image_select 走 imageOptions；缺 label 回落 nodeId', () => {
    const q = image('q1')
    expect(labelForOption(q, '0:1', strings)).toBe('帧1')
    expect(labelForOption(q, '0:2', strings)).toBe('0:2') // 无 label 回落
    expect(labelForOption(q, '不存在', strings)).toBe('不存在')
  })

  test('其它 kind 走 options；缺 label 回落 id', () => {
    const q = single('q1')
    expect(labelForOption(q, 'a', strings)).toBe('选项 A')
    expect(labelForOption(q, 'b', strings)).toBe('选项 B')
    expect(labelForOption(q, '不存在', strings)).toBe('不存在')
  })
})

describe('summarizeAnswer', () => {
  test('answer undefined → 空串', () => {
    expect(summarizeAnswer(single('q1'), undefined, strings)).toBe('')
  })

  test('multi_select：values 数组 → 顿号 join；「其他」优先 freeText 否则「其他」文案', () => {
    const q = multi('q1')
    expect(summarizeAnswer(q, { values: ['a', 'b'] }, strings)).toBe('A、B')
    expect(
      summarizeAnswer(q, { values: ['a', FREE_TEXT_OPTION_ID], freeText: '我的想法' }, strings)
    ).toBe('A、我的想法')
    expect(summarizeAnswer(q, { values: ['a', FREE_TEXT_OPTION_ID] }, strings)).toBe('A、其他')
    expect(
      summarizeAnswer(q, { values: [FREE_TEXT_OPTION_ID], freeText: '   我的想法   ' }, strings)
    ).toBe('我的想法')
    expect(summarizeAnswer(q, { values: [] }, strings)).toBe('')
  })

  test('multi_select：自由文本同时存在 values + freeText（freeText 优先）', () => {
    const q = multi('q1')
    // values 含「其他」+ freeText → 该位置展示 freeText
    expect(
      summarizeAnswer(q, { values: ['a', FREE_TEXT_OPTION_ID], freeText: '我的想法' }, strings)
    ).toBe('A、我的想法')
    // values 仅含「其他」+ freeText → 展示 freeText
    expect(
      summarizeAnswer(q, { values: [FREE_TEXT_OPTION_ID], freeText: '我的想法' }, strings)
    ).toBe('我的想法')
  })

  test('「其他」单选：freeText trim 非空白 → freeText；空白 → 「其他」文案', () => {
    const q = single('q1')
    expect(summarizeAnswer(q, { value: FREE_TEXT_OPTION_ID, freeText: '我的想法' }, strings)).toBe(
      '我的想法'
    )
    expect(
      summarizeAnswer(q, { value: FREE_TEXT_OPTION_ID, freeText: '   我的想法   ' }, strings)
    ).toBe('我的想法')
    expect(summarizeAnswer(q, { value: FREE_TEXT_OPTION_ID, freeText: '' }, strings)).toBe('其他')
    expect(summarizeAnswer(q, { value: FREE_TEXT_OPTION_ID }, strings)).toBe('其他')
  })

  test('普通选项：value 非空 → labelForOption；空串 → 空', () => {
    const q = single('q1')
    expect(summarizeAnswer(q, { value: 'a' }, strings)).toBe('选项 A')
    expect(summarizeAnswer(q, { value: '' }, strings)).toBe('')
  })

  test('image_select：value 走 labelForOption（imageOptions 路径）', () => {
    const q = image('q1')
    expect(summarizeAnswer(q, { value: '0:1' }, strings)).toBe('帧1')
    expect(summarizeAnswer(q, { value: '0:2' }, strings)).toBe('0:2')
  })

  test('value 非字符串且非 FREE_TEXT_OPTION_ID：fallback freeText trim', () => {
    // 防御：极异常路径（value=undefined）→ 走 freeText
    expect(summarizeAnswer(single('q1'), { freeText: '  备注  ' }, strings)).toBe('备注')
    expect(summarizeAnswer(single('q1'), { freeText: '' }, strings)).toBe('')
  })
})
