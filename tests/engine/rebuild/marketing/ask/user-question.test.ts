/**
 * T56（Phase 3 W2/T-B5）：ask_user_question 校验矩阵 + awaiting 信封 + formId 模式 +
 * Case B 四项组合 + 答案信封序列化/解析 round-trip（验收锚 T56-plan §3.1）。
 * T95：answers 改 per-question `{ value?, freeText? }` 结构（FREE_TEXT_OPTION_ID =
 * 「其他」选项），旧格式（T83 裸 string 值 / 全局 freeText 键）迁移 + 作答校验
 * 纯函数矩阵（isAskQuestionAnswered/missingRequiredAskAnswers）。
 * 波3 #10：single_select options preview 校验——收录并原文回显、
 * multi_select 拒收（preview_not_allowed）、空白预览静默忽略、
 * imageOptions 不受影响。
 *
 * core 层（#core/tools/fork/marketing/ask-user-question）纯函数直测；
 * pi 工具工厂（@/app/ai/pi-backend/ask-user-question）经注入确定性 formId 钉
 * awaiting 信封字段与软终止指令文本。
 */
import { describe, expect, test } from 'bun:test'

import {
  FORM_ID_PATTERN,
  FREE_TEXT_OPTION_ID,
  isAskQuestionAnswered,
  makeFormId,
  missingRequiredAskAnswers,
  parseAskAnswer,
  serializeAskAnswer,
  validateAskUserQuestions,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'

import { createAskUserQuestionTool } from '@/app/ai/pi-backend/ask/user-question'

function singleSelect(id: string) {
  return {
    id,
    kind: 'single_select',
    label: `问题 ${id}`,
    options: [
      { id: 'a', label: '选项 A', hint: '提示' },
      { id: 'b', label: '选项 B' }
    ]
  }
}

describe('validateAskUserQuestions 校验矩阵', () => {
  test('合法 single_select 通过；required 缺省补 true；选项 trim 归一', () => {
    const result = validateAskUserQuestions({ questions: [singleSelect('q1')] })
    expect('questions' in result).toBe(true)
    if (!('questions' in result)) return
    expect(result.questions).toHaveLength(1)
    expect(result.questions[0].required).toBe(true)
    expect(result.questions[0].options).toHaveLength(2)
  })

  test('questions 非数组 / 0 条 / 9 条 → {error, message} 不 throw', () => {
    for (const input of [{}, { questions: 'nope' }, { questions: [] }]) {
      const result = validateAskUserQuestions(input)
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toBe('questions_bounds')
        expect(typeof result.message).toBe('string')
      }
    }
    const nine = {
      questions: Array.from({ length: 9 }, (_, i) => singleSelect(`q${i}`))
    }
    expect('error' in validateAskUserQuestions(nine)).toBe(true)
  })

  test('8 条边界通过', () => {
    const eight = {
      questions: Array.from({ length: 8 }, (_, i) => singleSelect(`q${i}`))
    }
    expect('questions' in validateAskUserQuestions(eight)).toBe(true)
  })

  test('id 空 / 重复 → error', () => {
    expect(
      'error' in validateAskUserQuestions({ questions: [{ ...singleSelect(''), id: '  ' }] })
    ).toBe(true)
    const dup = validateAskUserQuestions({
      questions: [singleSelect('q1'), singleSelect('q1')]
    })
    expect('error' in dup).toBe(true)
    if ('error' in dup) expect(dup.error).toBe('question_id')
  })

  test('label 空 → error', () => {
    const result = validateAskUserQuestions({
      questions: [{ ...singleSelect('q1'), label: ' ' }]
    })
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toBe('question_label')
  })

  test('非法 kind → error', () => {
    const result = validateAskUserQuestions({
      questions: [{ id: 'q1', kind: 'ranking', label: 'x' }]
    })
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toBe('question_kind')
  })

  test('single_select：options 1 个 / 13 个 / 缺失 → error；携带 imageOptions → error', () => {
    const one = validateAskUserQuestions({
      questions: [{ ...singleSelect('q1'), options: [{ id: 'a', label: 'A' }] }]
    })
    expect('error' in one).toBe(true)
    const thirteen = validateAskUserQuestions({
      questions: [
        {
          ...singleSelect('q1'),
          options: Array.from({ length: 13 }, (_, i) => ({ id: `o${i}`, label: `O${i}` }))
        }
      ]
    })
    expect('error' in thirteen).toBe(true)
    expect(
      'error' in
        validateAskUserQuestions({ questions: [{ id: 'q1', kind: 'single_select', label: 'x' }] })
    ).toBe(true)
    const mixed = validateAskUserQuestions({
      questions: [{ ...singleSelect('q1'), imageOptions: [{ nodeId: '0:1' }] }]
    })
    expect('error' in mixed).toBe(true)
    if ('error' in mixed) expect(mixed.error).toBe('kind_mixed_fields')
  })

  test('single_select：option id 重复 / 空 → error', () => {
    const dup = validateAskUserQuestions({
      questions: [
        {
          ...singleSelect('q1'),
          options: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' }
          ]
        }
      ]
    })
    expect('error' in dup).toBe(true)
    const empty = validateAskUserQuestions({
      questions: [
        {
          ...singleSelect('q1'),
          options: [
            { id: '', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    })
    expect('error' in empty).toBe(true)
  })

  test('image_select：imageOptions 0 个 / 13 个 / nodeId 空 → error；携带 options → error', () => {
    const base = { id: 'q1', kind: 'image_select', label: '选一帧' }
    expect(
      'error' in validateAskUserQuestions({ questions: [{ ...base, imageOptions: [] }] })
    ).toBe(true)
    const thirteen = validateAskUserQuestions({
      questions: [
        { ...base, imageOptions: Array.from({ length: 13 }, (_, i) => ({ nodeId: `0:${i}` })) }
      ]
    })
    expect('error' in thirteen).toBe(true)
    const emptyNode = validateAskUserQuestions({
      questions: [{ ...base, imageOptions: [{ nodeId: ' ' }] }]
    })
    expect('error' in emptyNode).toBe(true)
    if ('error' in emptyNode) expect(emptyNode.error).toBe('image_option_node')
    const mixed = validateAskUserQuestions({
      questions: [
        { ...base, imageOptions: [{ nodeId: '0:1' }], options: [{ id: 'a', label: 'A' }] }
      ]
    })
    expect('error' in mixed).toBe(true)
    if ('error' in mixed) expect(mixed.error).toBe('kind_mixed_fields')
  })

  test('image_select 合法：1 个候选即过，label 可选', () => {
    const result = validateAskUserQuestions({
      questions: [
        { id: 'q1', kind: 'image_select', label: '选一帧', imageOptions: [{ nodeId: '0:1' }] }
      ]
    })
    expect('questions' in result).toBe(true)
  })

  test('text：携带 options/imageOptions → error；required:false 保留', () => {
    const withOptions = validateAskUserQuestions({
      questions: [{ id: 'q1', kind: 'text', label: 'x', options: singleSelect('q').options }]
    })
    expect('error' in withOptions).toBe(true)
    const result = validateAskUserQuestions({
      questions: [{ id: 'q1', kind: 'text', label: '补充说明', required: false }]
    })
    expect('questions' in result).toBe(true)
    if (!('questions' in result)) return
    expect(result.questions[0].required).toBe(false)
  })
})

describe('Case B 复用锚：四项 payload（现有 kinds 组合）通过校验', () => {
  test('①旧设计保留声明 ②新模式新设计区 ③携带物逐项勾选 ④废弃半径声明', () => {
    const caseB = {
      questions: [
        {
          id: 'keep_old_design',
          kind: 'single_select',
          label: '旧设计是否保留？',
          options: [
            { id: 'keep', label: '保留旧设计' },
            { id: 'discard', label: '废弃旧设计' }
          ]
        },
        {
          id: 'new_design_zone',
          kind: 'single_select',
          label: '新模式的新设计区放在哪里？',
          options: [
            { id: 'right', label: '旧设计右侧' },
            { id: 'below', label: '旧设计下方' },
            { id: 'new_page', label: '新页面' }
          ]
        },
        {
          id: 'carry_items',
          kind: 'text',
          label: '逐项列出要携带进新模式的内容',
          required: false
        },
        {
          id: 'discard_radius',
          kind: 'single_select',
          label: '废弃半径声明（换模式时丢弃哪些内容）',
          options: [
            { id: 'current_design', label: '仅当前设计' },
            { id: 'whole_page', label: '整个页面', hint: '谨慎选择' }
          ]
        }
      ]
    }
    const result = validateAskUserQuestions(caseB)
    expect('questions' in result).toBe(true)
    if (!('questions' in result)) return
    expect(result.questions).toHaveLength(4)
    expect(result.questions[2].required).toBe(false)
  })
})

describe('makeFormId', () => {
  test('模式钉扎：form-<时间戳36进制>-<随机6位>', () => {
    expect(
      makeFormId(
        () => 0,
        () => 0
      )
    ).toBe('form-0-000000')
    expect(
      makeFormId(
        () => Date.UTC(2026, 8, 1),
        () => 0.999999
      )
    ).toMatch(FORM_ID_PATTERN)
    expect(makeFormId()).toMatch(FORM_ID_PATTERN)
  })

  test('默认源两次生成不同', () => {
    expect(makeFormId()).not.toBe(makeFormId())
  })
})

describe('createAskUserQuestionTool：校验拒绝（不挂起、无 formId）', () => {
  test('label 超过 2000 字符 → schema 拒绝（typebox maxLength）', async () => {
    const tool = createAskUserQuestionTool({ makeId: () => 'form-test-000000' })
    const longLabel = 'x'.repeat(2001)
    const input = {
      questions: [{ id: 'q1', kind: 'text', label: longLabel }]
    }
    const result = await tool.execute('call-1', input)
    const details = result.details as { error?: string; message?: string; formId?: string }
    expect(details.error).toBeDefined()
    expect(details.formId).toBeUndefined()
  })

  test('非法定义 → {error, message}，无 formId', async () => {
    const tool = createAskUserQuestionTool({ makeId: () => 'form-test-000000' })
    const result = await tool.execute('call-1', { questions: [] })
    const details = result.details as { error?: string; message?: string; formId?: string }
    expect(details.error).toBe('questions_bounds')
    expect(typeof details.message).toBe('string')
    expect(details.formId).toBeUndefined()
  })
})

describe('答案信封 serializeAskAnswer/parseAskAnswer round-trip（T95 per-question 结构）', () => {
  test('作答信封：首行标记 + JSON 行，解析还原 { value } 结构', () => {
    const text = serializeAskAnswer('form-abc-000000', {
      aborted: false,
      answers: { q1: { value: 'a' }, q2: { value: '自由文本' } }
    })
    expect(text.startsWith('[表单作答 formId=form-abc-000000]\n')).toBe(true)
    expect(parseAskAnswer(text)).toEqual({
      formId: 'form-abc-000000',
      aborted: false,
      answers: { q1: { value: 'a' }, q2: { value: '自由文本' } }
    })
  })

  test('per-question「其他」：value=__freeText + freeText 原样 round-trip', () => {
    const text = serializeAskAnswer('form-abc-000000', {
      aborted: false,
      answers: {
        q1: { value: 'a' },
        q2: { value: FREE_TEXT_OPTION_ID, freeText: '我喜欢紫色' }
      }
    })
    expect(parseAskAnswer(text)).toEqual({
      formId: 'form-abc-000000',
      aborted: false,
      answers: {
        q1: { value: 'a' },
        q2: { value: FREE_TEXT_OPTION_ID, freeText: '我喜欢紫色' }
      }
    })
  })

  test('跳过信封：aborted:true + freeText（跳过理由分支不动）', () => {
    const text = serializeAskAnswer('form-abc-000000', { aborted: true, freeText: '都不想选' })
    expect(text.startsWith('[表单跳过 formId=form-abc-000000]\n')).toBe(true)
    expect(parseAskAnswer(text)).toEqual({
      formId: 'form-abc-000000',
      aborted: true,
      freeText: '都不想选'
    })
  })

  test('归一：空键丢弃（value/freeText 均空白）；「其他」无 freeText 仍留 value', () => {
    const parsed = parseAskAnswer(
      '[表单作答 formId=x]\n' +
        JSON.stringify({
          aborted: false,
          answers: {
            q1: { value: '  ', freeText: ' ' },
            q2: { value: 'ok' },
            q3: { value: FREE_TEXT_OPTION_ID }
          }
        })
    )
    expect(parsed).toEqual({
      formId: 'x',
      aborted: false,
      answers: { q2: { value: 'ok' }, q3: { value: FREE_TEXT_OPTION_ID } }
    })
  })

  test('容错：坏 JSON / 缺标记行 / 单行文本 → null', () => {
    expect(parseAskAnswer('[表单作答 formId=x]\n{not json')).toBeNull()
    expect(parseAskAnswer('普通用户消息\n{"aborted":false,"answers":{}}')).toBeNull()
    expect(parseAskAnswer('[表单作答 formId=x]')).toBeNull()
    expect(parseAskAnswer('')).toBeNull()
  })

  test('容错：aborted 与标记不符 / JSON 非对象 → null', () => {
    expect(parseAskAnswer('[表单作答 formId=x]\n{"aborted":true,"freeText":"y"}')).toBeNull()
    expect(parseAskAnswer('[表单跳过 formId=x]\n{"aborted":false,"answers":{}}')).toBeNull()
    expect(parseAskAnswer('[表单作答 formId=x]\n[1,2]')).toBeNull()
    expect(parseAskAnswer('[表单作答 formId=x]\n"str"')).toBeNull()
  })

  test('容错：非对象/空白值过滤；freeText 缺失补空串；标记行尾空白容忍', () => {
    expect(
      parseAskAnswer('[表单作答 formId=x] \n{"aborted":false,"answers":{"a":1,"b":"ok"}}')
    ).toEqual({ formId: 'x', aborted: false, answers: { b: { value: 'ok' } } })
    expect(parseAskAnswer('[表单跳过 formId=x]\n{"aborted":true}')).toEqual({
      formId: 'x',
      aborted: true,
      freeText: ''
    })
  })
})

describe('旧格式迁移（T83 全局 freeText → 首个未作答选择类题的「其他」，审查文档 §5.3/§6.2）', () => {
  const QUESTIONS: AskQuestionSpec[] = [
    {
      id: 'q1',
      kind: 'single_select',
      label: '设计方案',
      required: true,
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' }
      ]
    },
    {
      id: 'q2',
      kind: 'image_select',
      label: '选一帧',
      required: true,
      imageOptions: [{ nodeId: '0:1' }]
    },
    { id: 'q3', kind: 'text', label: '补充', required: false }
  ]
  const legacyEnvelope = (payload: unknown) => `[表单作答 formId=x]\n${JSON.stringify(payload)}`

  test('旧格式：裸 string 值 → { value }；全局 freeText 归到首个未作答选择类题', () => {
    const parsed = parseAskAnswer(
      legacyEnvelope({ aborted: false, answers: { q1: 'a', q3: '备注' }, freeText: '综合想法' }),
      QUESTIONS
    )
    expect(parsed).toEqual({
      formId: 'x',
      aborted: false,
      answers: {
        q1: { value: 'a' },
        q3: { value: '备注' },
        q2: { value: FREE_TEXT_OPTION_ID, freeText: '综合想法' }
      }
    })
  })

  test('旧格式：选择类题全已答 → 不覆盖已选选项，legacy freeText 原样保留', () => {
    const parsed = parseAskAnswer(
      legacyEnvelope({ aborted: false, answers: { q1: 'a', q2: '0:1' }, freeText: '综合想法' }),
      QUESTIONS
    )
    expect(parsed).toEqual({
      formId: 'x',
      aborted: false,
      answers: { q1: { value: 'a' }, q2: { value: '0:1' } },
      freeText: '综合想法'
    })
  })

  test('旧格式：未传 questions → 不猜归属，legacy freeText 原样保留', () => {
    const parsed = parseAskAnswer(
      legacyEnvelope({ aborted: false, answers: { q1: 'a' }, freeText: '综合想法' })
    )
    expect(parsed).toEqual({
      formId: 'x',
      aborted: false,
      answers: { q1: { value: 'a' } },
      freeText: '综合想法'
    })
  })

  test('旧格式：全是 text 题 → 无选择类题可归因，legacy freeText 原样保留', () => {
    const parsed = parseAskAnswer(
      legacyEnvelope({ aborted: false, answers: {}, freeText: '综合想法' }),
      [QUESTIONS[2]]
    )
    expect(parsed).toEqual({
      formId: 'x',
      aborted: false,
      answers: {},
      freeText: '综合想法'
    })
  })

  test('旧格式：空白全局 freeText 直接丢弃（T83 同律）', () => {
    const parsed = parseAskAnswer(
      legacyEnvelope({ aborted: false, answers: { q1: 'a' }, freeText: '  ' }),
      QUESTIONS
    )
    expect(parsed).toEqual({ formId: 'x', aborted: false, answers: { q1: { value: 'a' } } })
    expect(parsed && 'freeText' in parsed).toBe(false)
  })
})

describe('作答校验 isAskQuestionAnswered/missingRequiredAskAnswers（审查文档 §4.4/§5.2）', () => {
  const select: AskQuestionSpec = {
    id: 'q1',
    kind: 'single_select',
    label: '设计方案',
    required: true,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ]
  }
  const text: AskQuestionSpec = { id: 'q2', kind: 'text', label: '补充', required: true }
  const optional: AskQuestionSpec = { id: 'q3', kind: 'text', label: '选答', required: false }

  test('单题有效性：普通选项 / text 值 / 「其他」+freeText / 「其他」空 freeText', () => {
    expect(isAskQuestionAnswered(select, { value: 'a' })).toBe(true)
    expect(isAskQuestionAnswered(select, undefined)).toBe(false)
    expect(isAskQuestionAnswered(select, {})).toBe(false)
    expect(isAskQuestionAnswered(select, { value: FREE_TEXT_OPTION_ID })).toBe(false)
    expect(isAskQuestionAnswered(select, { value: FREE_TEXT_OPTION_ID, freeText: '  ' })).toBe(
      false
    )
    expect(
      isAskQuestionAnswered(select, { value: FREE_TEXT_OPTION_ID, freeText: '我的想法' })
    ).toBe(true)
    expect(isAskQuestionAnswered(text, { value: '  ' })).toBe(false)
    expect(isAskQuestionAnswered(text, { value: '写了一段' })).toBe(true)
  })

  test('必填缺口列表：未答/「其他」空输入被拦；选答不拦；全有效 → 空数组', () => {
    expect(missingRequiredAskAnswers([select, text, optional], {}).map((q) => q.id)).toEqual([
      'q1',
      'q2'
    ])
    expect(
      missingRequiredAskAnswers([select, text, optional], {
        q1: { value: FREE_TEXT_OPTION_ID, freeText: '' },
        q2: { value: 'ok' }
      }).map((q) => q.id)
    ).toEqual(['q1'])
    expect(
      missingRequiredAskAnswers([select, text, optional], {
        q1: { value: 'b' },
        q2: { value: 'ok' }
      })
    ).toEqual([])
    expect(
      missingRequiredAskAnswers([select, text, optional], {
        q1: { value: FREE_TEXT_OPTION_ID, freeText: '紫色' },
        q2: { value: 'ok' }
      })
    ).toEqual([])
  })
})

describe('波3 #10 single_select preview 校验', () => {
  test('single_select 收录并原文回显 preview（markdown 缩进/换行不丢）', () => {
    // 多空格、缩进、列表、代码块缩进——全要原文回显
    const preview = '  ## 方案 A\n\n  - 项一\n  - 项二\n\n    ```ts\n  const x = 1\n    ```\n'
    const result = validateAskUserQuestions({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '选个方案',
          options: [
            { id: 'a', label: 'A', preview },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    })
    expect('questions' in result).toBe(true)
    if (!('questions' in result)) return
    expect(result.questions[0].options?.[0].preview).toBe(preview)
  })

  test('multi_select 任一 option 带非空白 preview → preview_not_allowed', () => {
    const result = validateAskUserQuestions({
      questions: [
        {
          id: 'q1',
          kind: 'multi_select',
          label: '挑几个',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B', preview: '## 方案 B\n\n详情' }
          ]
        }
      ]
    })
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toBe('preview_not_allowed')
      expect(result.message).toContain('multi_select')
      expect(result.message).toContain('single_select only')
    }
  })

  test('空白 preview（"  "）静默忽略（不收录，不报错）', () => {
    const result = validateAskUserQuestions({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '选',
          options: [
            { id: 'a', label: 'A', preview: '  ' },
            { id: 'b', label: 'B', preview: '\n\t  \n' }
          ]
        }
      ]
    })
    expect('questions' in result).toBe(true)
    if (!('questions' in result)) return
    expect(result.questions[0].options?.[0].preview).toBeUndefined()
    expect(result.questions[0].options?.[1].preview).toBeUndefined()
  })

  test('空白 preview 在 multi_select 同样静默忽略（不触发 preview_not_allowed）', () => {
    const result = validateAskUserQuestions({
      questions: [
        {
          id: 'q1',
          kind: 'multi_select',
          label: '挑',
          options: [
            { id: 'a', label: 'A', preview: '   ' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    })
    expect('questions' in result).toBe(true)
  })

  test('image_select 不识别 preview 键——imageOptions 上带 preview 静默忽略不报错', () => {
    // 校验函数对未知键忽略的现状不变；imageOptions 形态无 preview 字段，
    // 但即使原始 payload 在 imageOptions 项上夹带 preview 也不该拦截。
    const result = validateAskUserQuestions({
      questions: [
        {
          id: 'q1',
          kind: 'image_select',
          label: '选一帧',
          imageOptions: [{ nodeId: '0:1', label: 'A', preview: '夹带的预览' }]
        }
      ]
    })
    expect('questions' in result).toBe(true)
    if (!('questions' in result)) return
    // imageOptions 项形态固定为 { nodeId, label? }——preview 不外溢
    expect(result.questions[0].imageOptions?.[0]).toEqual({ nodeId: '0:1', label: 'A' })
  })
})
