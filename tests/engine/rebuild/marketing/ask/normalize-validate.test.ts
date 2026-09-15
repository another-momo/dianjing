/**
 * 2026-09-15 ask 波2 #5/#6：rpiv 验证模块（normalize-params.ts / validate-questionnaire.ts）
 * + prompt 指引段钉扎——补充测试，营销域 ask-* 前缀兄弟文件上限 3（避免触发 steiger FSD
 * 规则；本文件即第 3 个，新增归 ask/ 子目录的边界）。
 *
 * 覆盖：
 *  - normalizeAskParams 三件：行尾规范化、label 空白 collapse + trim、label 归一后重复题去重
 *  - checkReservedLabels：option.id === FREE_TEXT_OPTION_ID → reserved_label
 *  - isValidMultiAnswer：values 形态 + id 集 + freeText 关联
 *  - 与 validateAskUserQuestions 组合（normalize → validate）通过例
 *  - execute 工厂在 normalized/validated 阶段仍走早期失败路径（不挂起）
 *  - ASK_USER_QUESTION_DESCRIPTION 包含波2 #14 prompt 指引段
 */
import { describe, expect, test } from 'bun:test'

import {
  FREE_TEXT_OPTION_ID,
  validateAskUserQuestions,
  type AskQuestionSpec
} from '@open-pencil/core/tools/fork/marketing/ask-user-question'
import { normalizeAskParams } from '@open-pencil/core/tools/fork/marketing/normalize-params'
import {
  RESERVED_OPTION_IDS,
  checkReservedLabels,
  findReservedOptionId,
  isValidMultiAnswer
} from '@open-pencil/core/tools/fork/marketing/validate-questionnaire'

import { createAskPendingStore } from '@/app/ai/pi-backend/ask/pending'
import { createAskUserQuestionTool } from '@/app/ai/pi-backend/ask/user-question'

describe('normalizeAskParams：行尾规范化（再叠加空白 collapse）', () => {
  test('questions[].label、options[].label、options[].hint 内 \\r\\n → \\n 后再压空白', () => {
    const result = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: 'pick\r\none',
          options: [
            { id: 'a', label: 'A\r\nA', hint: 'hint\r\ntext' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    }) as { questions: Array<{ label: string; options: Array<{ label: string; hint?: string }> }> }
    // 行尾归 \\n 后所有空白 run（含 \\n）压成单空格——保留信息语义（其他文本）
    expect(result.questions[0].label).toBe('pick one')
    expect(result.questions[0].options[0].label).toBe('A A')
    expect(result.questions[0].options[0].hint).toBe('hint text')
  })

  test('裸 \\r 行尾也归 \\n（防兜底绕过「Other\\r」）', () => {
    const result = normalizeAskParams({
      questions: [{ id: 'q1', kind: 'text', label: 'old\rmac' }]
    }) as { questions: Array<{ label: string }> }
    expect(result.questions[0].label).toBe('old mac')
  })

  test('先归一使「Other\\r\\n」 与「Other」 字面相等——去重可达', () => {
    const result = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: 'Other\r\n',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        },
        { id: 'q2', kind: 'text', label: 'Other' }
      ]
    }) as { questions: Array<{ id: string }> }
    expect(result.questions.map((q) => q.id)).toEqual(['q1'])
  })
})

describe('normalizeAskParams：空白 collapse + trim', () => {
  test('label 与 option label/hint 内连续空白（空格/Tab/换行）压成单空格并 trim', () => {
    const result = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '   字体  \t 选择\n\n  范围  ',
          options: [
            { id: 'a', label: ' 衬线\t字体  ', hint: '\n  提示  \n 文本 ' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    }) as {
      questions: Array<{ label: string; options: Array<{ label: string; hint?: string }> }>
    }
    expect(result.questions[0].label).toBe('字体 选择 范围')
    expect(result.questions[0].options[0].label).toBe('衬线 字体')
    expect(result.questions[0].options[0].hint).toBe('提示 文本')
  })

  test('空 label 归一为 ""；option 无 hint 不补字段', () => {
    const result = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '   ',
          options: [
            { id: 'a', label: '   ' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    }) as { questions: Array<{ label: string; options: Array<{ label: string; hint?: string }> }> }
    expect(result.questions[0].label).toBe('')
    expect(result.questions[0].options[0].label).toBe('')
    expect(result.questions[0].options[1].hint).toBeUndefined()
  })
})

describe('normalizeAskParams：label 归一后重复题去重', () => {
  test('collapse 后完全相同的题保留首现；后续重复丢弃', () => {
    // q1 normalize → '颜色 偏好'（中段保留 1 空格），q2/q3 同为 '颜色偏好'（无空格）。
    // 中段空格不同 ≠ 字面相等，所以 q1 保留 + q2 保留 + q3 丢 + q4 保留
    const result = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '  颜色 偏好  ',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        },
        {
          id: 'q2',
          kind: 'single_select',
          label: '颜色偏好',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        },
        { id: 'q3', kind: 'text', label: '颜色偏好' },
        { id: 'q4', kind: 'text', label: '补充' }
      ]
    }) as { questions: Array<{ id: string; label: string }> }
    expect(result.questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q4'])
    expect(result.questions[0].label).toBe('颜色 偏好')
    expect(result.questions[1].label).toBe('颜色偏好')
  })

  test('纯空白差异的 label 归一后相等 → 去重生效', () => {
    const result = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '颜色  偏好',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        },
        {
          id: 'q2',
          kind: 'single_select',
          label: '颜色 偏好',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        },
        {
          id: 'q3',
          kind: 'single_select',
          label: '\n 颜色 偏好 \t',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    }) as { questions: Array<{ id: string; label: string }> }
    expect(result.questions.map((q) => q.id)).toEqual(['q1'])
    expect(result.questions[0].label).toBe('颜色 偏好')
  })

  test('label 归一后空串（仅空白）不去重——交给 validate 报 label error', () => {
    const result = normalizeAskParams({
      questions: [
        { id: 'q1', kind: 'text', label: '   ' },
        { id: 'q2', kind: 'text', label: '\t\n  ' }
      ]
    }) as { questions: Array<{ id: string; label: string }> }
    expect(result.questions.map((q) => q.id)).toEqual(['q1', 'q2'])
  })
})

describe('normalizeAskParams：波3 #10 options[].preview 行尾规范化（不 collapse）', () => {
  test('preview 内 \\r\\n → \\n（防兜底绕过）', () => {
    const result = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '选',
          options: [
            { id: 'a', label: 'A', preview: '## 方案\r\n\r\n详情\r\n更多' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    }) as {
      questions: Array<{ options: Array<{ preview?: string }> }>
    }
    expect(result.questions[0].options[0].preview).toBe('## 方案\n\n详情\n更多')
  })

  test('collapse 不碰 preview 内部多空格/缩进（markdown 缩进是语义）', () => {
    // 含代码块缩进、列表缩进——必须原文保留
    const preview =
      '  ## 方案\n\n    - 列表项\n    ```ts\n      const x = 1\n    ```\n\n  段间双空行'
    const result = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '选',
          options: [
            { id: 'a', label: 'A', preview },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    }) as {
      questions: Array<{ options: Array<{ preview?: string }> }>
    }
    // 原样回显（无 LF 也无 collapse 的纯 LF 文本就等于 input；input 没有 \r 所以完全一致）
    expect(result.questions[0].options[0].preview).toBe(preview)
  })

  test('preview 内裸 \\r 行尾也归 \\n', () => {
    const result = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '选',
          options: [
            { id: 'a', label: 'A', preview: 'line1\rline2' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    }) as {
      questions: Array<{ options: Array<{ preview?: string }> }>
    }
    expect(result.questions[0].options[0].preview).toBe('line1\nline2')
  })
})

describe('normalizeAskParams：与 validateAskUserQuestions 组合', () => {
  test('重复 label 题先去重 → validate 不报 duplicate id', () => {
    const normalized = normalizeAskParams({
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: '颜色',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        },
        {
          id: 'q2',
          kind: 'single_select',
          label: '颜色',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' }
          ]
        }
      ]
    })
    const result = validateAskUserQuestions(normalized)
    expect('questions' in result).toBe(true)
    if (!('questions' in result)) return
    expect(result.questions).toHaveLength(1)
  })

  test('非对象 / 非数组 questions 不抛——normalize 兜底后 validate 报边界', () => {
    expect('error' in validateAskUserQuestions(normalizeAskParams(null))).toBe(true)
    expect('error' in validateAskUserQuestions(normalizeAskParams({}))).toBe(true)
  })
})

describe('checkReservedLabels + findReservedOptionId', () => {
  const clean: AskQuestionSpec = {
    id: 'q1',
    kind: 'single_select',
    label: 'x',
    required: true,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' }
    ]
  }

  test('option.id === __freeText → reserved_label', () => {
    const bad: AskQuestionSpec = {
      ...clean,
      options: [
        { id: 'a', label: 'A' },
        { id: FREE_TEXT_OPTION_ID, label: '其他' }
      ]
    }
    expect(findReservedOptionId(bad)).toBe(FREE_TEXT_OPTION_ID)
    expect(checkReservedLabels({ questions: [bad] })).toEqual({
      error: 'reserved_label',
      message: `question "q1" option id "${FREE_TEXT_OPTION_ID}" is reserved by the UI`
    })
  })

  test('image_select（无 options 字段）天然豁免', () => {
    const img: AskQuestionSpec = {
      id: 'q1',
      kind: 'image_select',
      label: '选一帧',
      required: true,
      imageOptions: [{ nodeId: '0:1' }]
    }
    expect(findReservedOptionId(img)).toBeNull()
    expect('questions' in checkReservedLabels({ questions: [img] })).toBe(true)
  })

  test('clean 通过；error 输入透传（不重报）', () => {
    expect('questions' in checkReservedLabels({ questions: [clean] })).toBe(true)
    const passthrough = checkReservedLabels({
      error: 'questions_bounds',
      message: 'x'
    })
    expect(passthrough).toEqual({ error: 'questions_bounds', message: 'x' })
  })

  test('RESERVED_OPTION_IDS 当前仅 FREE_TEXT_OPTION_ID', () => {
    expect([...RESERVED_OPTION_IDS]).toEqual([FREE_TEXT_OPTION_ID])
  })
})

describe('isValidMultiAnswer', () => {
  const spec: AskQuestionSpec = {
    id: 'q1',
    kind: 'multi_select',
    label: '挑几个',
    required: true,
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' }
    ]
  }

  test('values 1..options.length 个 + 每项 id 在 options 集内 → 有效', () => {
    expect(isValidMultiAnswer({ values: ['a'] }, spec)).toBe(true)
    expect(isValidMultiAnswer({ values: ['a', 'b', 'c'] }, spec)).toBe(true)
  })

  test('含 FREE_TEXT_OPTION_ID 时 freeText 必须非空白', () => {
    expect(isValidMultiAnswer({ values: ['a', FREE_TEXT_OPTION_ID] }, spec)).toBe(false)
    expect(
      isValidMultiAnswer({ values: ['a', FREE_TEXT_OPTION_ID], freeText: '我的输入' }, spec)
    ).toBe(true)
    expect(isValidMultiAnswer({ values: [FREE_TEXT_OPTION_ID], freeText: '   ' }, spec)).toBe(false)
  })

  test('空数组 / undefined / values 越界 / 非法 id / 非 string 项 → 无效', () => {
    expect(isValidMultiAnswer({ values: [] }, spec)).toBe(false)
    expect(isValidMultiAnswer(undefined, spec)).toBe(false)
    expect(isValidMultiAnswer({ values: ['a', 'b', 'c', 'd'] }, spec)).toBe(false)
    expect(isValidMultiAnswer({ values: ['zzz'] }, spec)).toBe(false)
    expect(isValidMultiAnswer({ values: ['a', 1] }, spec)).toBe(false)
  })

  test('缺 options 字段（image_select 误用）也按 values 集拦截', () => {
    const textSpec: AskQuestionSpec = { id: 'q', kind: 'text', label: 't', required: true }
    expect(isValidMultiAnswer({ values: ['a'] }, textSpec)).toBe(false)
  })
})

describe('createAskUserQuestionTool：归一后校验失败仍早返（不挂起）', () => {
  function makeTool() {
    const store = createAskPendingStore()
    const tool = createAskUserQuestionTool({
      makeId: () => 'form-test-000000',
      store,
      sessionId: 'test-session'
    })
    return { tool, store }
  }

  test('option.id === __freeText → reserved_label，execute 不挂起、无 formId', async () => {
    const { tool } = makeTool()
    const result = await tool.execute('call-1', {
      questions: [
        {
          id: 'q1',
          kind: 'single_select',
          label: 'x',
          options: [
            { id: 'a', label: 'A' },
            { id: FREE_TEXT_OPTION_ID, label: '其他' }
          ]
        }
      ]
    })
    const details = result.details as { error?: string; formId?: string }
    expect(details.error).toBe('reserved_label')
    expect(details.formId).toBeUndefined()
  })

  test('label 含 \\r\\n → 归一后通过校验、进入挂起（旁证）', async () => {
    const { tool, store } = makeTool()
    const pending = tool.execute(
      'call-1',
      { questions: [{ id: 'q1', kind: 'text', label: '补充\r\n信息' }] },
      undefined
    )
    // 让 register + await promise 跑起来 → 进入挂起
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 5)
    })
    expect(store.resolveByFormId('form-test-000000', { skip: true })).toBe('ok')
    const result = await pending
    const details = result.details as { status?: string; formId?: string }
    expect(details.status).toBe('skipped')
    expect(details.formId).toBe('form-test-000000')
  })

  test('重复 label 题 → 归一去重后通过校验、进入挂起', async () => {
    const { tool, store } = makeTool()
    const pending = tool.execute(
      'call-1',
      {
        questions: [
          { id: 'q1', kind: 'text', label: '颜色' },
          { id: 'q2', kind: 'text', label: '颜色' }
        ]
      },
      undefined
    )
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 5)
    })
    expect(store.resolveByFormId('form-test-000000', { skip: true })).toBe('ok')
    const result = await pending
    const details = result.details as { status?: string }
    expect(details.status).toBe('skipped')
  })
})

describe('ASK_USER_QUESTION_DESCRIPTION：波2 #14 prompt 指引段', () => {
  test('工具描述尾部追加「何时该问 / 至多 2 轮 / 不该问什么」指引', () => {
    const tool = createAskUserQuestionTool({
      makeId: () => 'form-test-000000',
      store: createAskPendingStore(),
      sessionId: 'test-session'
    })
    const desc = tool.description
    expect(desc).toContain('BLOCKS until the user answers')
    expect(desc).toContain('Guidelines for when to ask')
    expect(desc.toLowerCase()).toContain('canvas')
    expect(desc).toContain('TWO forms per session')
    expect(desc.toLowerCase()).toContain('batch')
  })
})
