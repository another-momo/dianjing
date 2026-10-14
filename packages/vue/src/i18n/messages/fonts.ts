import { params } from '@nanostores/i18n'

import { i18n } from '#vue/i18n/create'

export const fontsMessageDefaults = {
  issueFound: '1 font face is unavailable or substituted',
  issuesFound: params('{count} font faces are unavailable or substituted'),
  selectAffectedLayers: 'Select layers',
  retry: 'Retry fonts',
  retrying: 'Retrying…',
  expandIssues: 'Show font issues',
  collapseIssues: 'Hide font issues',
  noSubstitute: 'no substitute available',
  unsupportedFormatShort: 'unsupported format',
  unsupportedFormat: 'Installed, but in a format OpenPencil can’t draw yet',
  affectedLayer: '1 affected layer',
  affectedLayerCount: params('{count} affected layers'),
  openSettings: 'Open font settings',
  /** 字重梯缺失档提示：静态注册族已由字重梯过滤，本提示兜未枚举到 style 集的族 */
  weightUnavailable: params('{family} has no {weight} weight — pick another weight.')
} as const

export const fontsMessages = i18n('fonts', fontsMessageDefaults)
