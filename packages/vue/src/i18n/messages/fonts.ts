import { params } from '@nanostores/i18n'

import { i18n } from '#vue/i18n/create'

export const fontsMessageDefaults = {
  settingsTitle: 'Font settings',
  issueFound: '1 font face is unavailable or substituted',
  issuesFound: params('{count} font faces are unavailable or substituted'),
  selectAffectedLayers: 'Select layers',
  retry: 'Retry fonts',
  retrying: 'Retrying…',
  expandIssues: 'Show font issues',
  collapseIssues: 'Hide font issues',
  noSubstitute: 'no substitute available',
  affectedLayer: '1 affected layer',
  affectedLayerCount: params('{count} affected layers'),
  localFonts: 'Local fonts',
  onlineFonts: 'Online fonts',
  systemFontAccess: 'System font access',
  systemFontsAvailable: 'System fonts are available.',
  allowBrowserFontAccess: 'Allow browser font access when system fonts are missing.',
  // popover 降级为只读摘要 + 深链「打开字体设置」（详细管理在设置对话框字体页）
  popoverSummaryTitle: 'Font settings',
  popoverSummaryHint: 'Open font settings to manage providers, fallback packs, and the cache.',
  openSettings: 'Open font settings'
} as const

export const fontsMessages = i18n('fonts', fontsMessageDefaults)
