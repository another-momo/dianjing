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
  openSettings: 'Open font settings'
} as const

export const fontsMessages = i18n('fonts', fontsMessageDefaults)
