import { IS_TAURI } from '@open-pencil/core/constants'

import { missingSupportSentinels } from './baseline'
import { describeEnvironment, type DesktopFacts, type SupportEnvironment } from './detect'
import { bootFailureNotice, unsupportedNotice } from './guidance'
import { renderSupportNotice } from './render'

async function desktopFacts(): Promise<DesktopFacts> {
  // Electron fork: the Tauri OS plugin is not bundled, so native desktop facts
  // stay unavailable and the notice describes the engine from the user agent.
  return { platform: 'unknown' }
}

async function detectEnvironment(): Promise<SupportEnvironment> {
  const facts = { userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }
  return describeEnvironment(facts, IS_TAURI ? await desktopFacts() : undefined)
}

/**
 * Check the engine against the support baseline before the app bundle loads.
 * Returns `true` when the app may boot; otherwise the app root now shows
 * platform-specific update guidance and the caller must stop.
 */
export async function runSupportGate(): Promise<boolean> {
  const missing = missingSupportSentinels()
  if (missing.length === 0) return true
  renderSupportNotice(unsupportedNotice(await detectEnvironment(), missing))
  return false
}

/** Replace a blank window with an explanation after the app failed to load. */
export async function reportBootFailure(error: unknown): Promise<void> {
  console.error('[support] boot failed', error)
  renderSupportNotice(bootFailureNotice(await detectEnvironment(), error))
}
