/**
 * P2-a（2026-09-19，路线 B）：chat.reasoningDisplay 三态偏好接线钉扎。
 *
 * 验收映射：
 *  - 默认值恒 collapsed（T96 owner 拍板「恒默认折叠」兼容锚——三态只开放
 *    opt-in，默认不动）；
 *  - 消费方写入形态（PiChatMessage 读 / ChatSettingsSection 写的同款 spread
 *    写路径）三态往返；
 *  - i18n 键 en 源（aiMessageDefaults）与 zh-cn 语言包双写齐备（i18n 门只扫
 *    packages/vue locales——缺键 CI 红，本测试本地先挡）。
 *
 * 不覆盖（仓内测试栈无 DOM 基础设施，见 reasoning-i18n.test.ts 头注先例）：
 *  ReasoningBlock 组件挂载行为（折叠态机/1s 自动收起）、PiChatMessage 模板接线、
 *  ChatSettingsSection 渲染——UI 层由收口门禁 typecheck + L3 浏览器实测兜底。
 */

import { describe, expect, test } from 'bun:test'

import {
  appPreferences,
  DEFAULT_APP_PREFERENCES,
  type ReasoningDisplay
} from '@/app/settings/preferences/store'

import zhCN from '#vue/i18n/locales/zh-cn/ai.json'
import { aiMessageDefaults } from '#vue/i18n/messages/ai'

describe('P2-a reasoningDisplay 三态偏好', () => {
  test('默认值恒 collapsed（T96 兼容锚，opt-in 不改默认）', () => {
    expect(DEFAULT_APP_PREFERENCES.chat.reasoningDisplay).toBe('collapsed')
  })

  test('消费方写入形态（spread 写路径）三态往返', () => {
    const original = appPreferences.value
    try {
      for (const value of ['collapsed', 'while-thinking', 'expanded'] as ReasoningDisplay[]) {
        // 与 ChatSettingsSection setter 同款写入形态
        appPreferences.value = { ...appPreferences.value, chat: { reasoningDisplay: value } }
        // 与 PiChatMessage 同款读取形态
        expect(appPreferences.value.chat.reasoningDisplay).toBe(value)
      }
    } finally {
      appPreferences.value = original
    }
  })

  test('i18n 键中英双写齐备（en 源 + zh-cn 语言包）', () => {
    expect(aiMessageDefaults.reasoningDisplay).toBe('Reasoning display')
    expect(aiMessageDefaults.reasoningCollapsed).toBe('Collapsed by default')
    expect(aiMessageDefaults.reasoningWhileThinking).toBe('Expand while thinking')
    expect(aiMessageDefaults.reasoningExpanded).toBe('Expanded by default')
    expect(aiMessageDefaults.chatSettings).toBe('Chat')

    const zh = zhCN as Record<string, string>
    for (const key of [
      'chatSettings',
      'reasoningDisplay',
      'reasoningCollapsed',
      'reasoningWhileThinking',
      'reasoningExpanded'
    ]) {
      expect(typeof zh[key]).toBe('string')
      expect(zh[key].length).toBeGreaterThan(0)
    }
  })
})
