import * as v from 'valibot'

import { hasWindowGlobal } from '@open-pencil/core/constants'

const EDITOR_LAYOUT_KEY = 'open-pencil:editor-layout'
const DEFAULT_EDITOR_LAYOUT = [18, 64, 18]
const EditorLayoutJSON = v.pipe(
  v.string(),
  v.parseJson(),
  v.strictTuple([v.number(), v.number(), v.number()])
)

export function loadEditorLayout(): number[] {
  if (!hasWindowGlobal()) return DEFAULT_EDITOR_LAYOUT
  try {
    const parsed = v.safeParse(EditorLayoutJSON, window.localStorage.getItem(EDITOR_LAYOUT_KEY))
    return parsed.success ? parsed.output : DEFAULT_EDITOR_LAYOUT
  } catch {
    return DEFAULT_EDITOR_LAYOUT
  }
}

export function saveEditorLayout(layout: number[]): void {
  if (!hasWindowGlobal()) return
  window.localStorage.setItem(EDITOR_LAYOUT_KEY, JSON.stringify(layout))
}
