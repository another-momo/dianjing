/**
 * T96：reasoning 折叠卡 i18n 文案钉扎——「思考过程」（结束态）/「思考中」
 * （流式态）键都在 confirmMessageDefaults 里存在且符合预期文案。
 *
 * 验收映射：
 *  - 结束态文案保持 T93 原文不变（回归保护）
 *  - 流式态文案新增 reasoningStreamingTitle（区别于结束态）
 *  - 英文默认走 'Thinking process' / 'Thinking'
 *  - 流式态不带省略号为刻意设计（owner 2026-09-10 拍板），与结束态
 *    'Thinking process' 靠文案本身区分
 *
 * 不覆盖：PiChatMessage.vue 的 markup/动画——组件需要 vue runtime + reka-ui +
 * happy-dom 才能 mount，仓库当前测试栈（bun:test）无 DOM 基础设施，引入
 * @vue/test-utils/happy-dom 会改动全局测试配置（违反「不动基础设施」纪律）。
 * 2026-09-19 P2-a（路线 B）：reasoning 渲染改由 ReasoningBlock 组件承接
 * （reka Collapsible + ChatMarkdown surface=reasoning + 三态偏好接线），
 * 原内联 details/三圆点形态退役；标题文案键不变，本钉扎继续有效。
 */

import { describe, expect, test } from 'bun:test'

import { confirmMessageDefaults } from '@/app/i18n/fork/locales/en'

describe('T96 reasoning i18n keys', () => {
  test('结束态 reasoningTitle 保持 T93 原文（回归保护）', () => {
    expect(confirmMessageDefaults.reasoningTitle).toBe('Thinking process')
  })

  test('流式态 reasoningStreamingTitle 新增且文案与结束态可区分', () => {
    expect(typeof confirmMessageDefaults.reasoningStreamingTitle).toBe('string')
    expect(confirmMessageDefaults.reasoningStreamingTitle).toBe('Thinking')
    // 区别于结束态（流式应传达「进行中」）
    expect(confirmMessageDefaults.reasoningStreamingTitle).not.toBe(
      confirmMessageDefaults.reasoningTitle
    )
  })
})
