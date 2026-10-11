import { kebabCase, pascalCase } from 'es-toolkit/string'

import type { StateElement, StateStyles } from './types'

/**
 * Claim `base`, or the first free `base<separator><n>` from 2 on. `key` decides which
 * names collide, e.g. ignoring case for file names on case-insensitive file systems.
 * （随 export/storybook 出清从该域 names.ts 内联迁入——消费方 = layerClassNames + export/components 五件）
 */
export function claimName(
  base: string,
  taken: Set<string>,
  { separator = '', key = (name: string) => name } = {}
): string {
  let name = base
  for (let n = 2; taken.has(key(name)); n++) name = `${base}${separator}${n}`
  taken.add(key(name))
  return name
}

const NOT_IDENTIFIER_PART = /[^\p{ID_Continue}]/gu
const IDENTIFIER_START = /^\p{ID_Start}/u

/** A PascalCase JavaScript identifier for `text`, prefixed with `fallback` when it cannot start one. */
export function identifierName(text: string, fallback: string): string {
  const name = pascalCase(text).replace(NOT_IDENTIFIER_PART, '')
  return IDENTIFIER_START.test(name) ? name : `${fallback}${name}`
}

const NOT_NAME_PART = /[^a-z0-9-]/g

/** A CSS identifier made from a layer or set name, `fallback` when nothing of it is usable. */
export function cssName(text: string, fallback: string): string {
  const name = kebabCase(text).replace(NOT_NAME_PART, '')
  return /^[a-z]/.test(name) ? name : `${fallback}${name ? `-${name}` : ''}`
}

/**
 * A readable class per layer: the set's name for the root, `<root>__<layer>` below it,
 * numbered where two layers share a name.
 */
export function layerClassNames(styles: StateStyles): Map<StateElement, string> {
  const root = cssName(styles.name, 'component')
  const names = new Map<StateElement, string>([[styles.root, root]])
  const taken = new Set([root])
  const visit = (element: StateElement) => {
    for (const child of element.children) {
      if (child.type !== 'element') continue
      names.set(
        child,
        claimName(`${root}__${cssName(child.name, 'layer')}`, taken, { separator: '-' })
      )
      visit(child)
    }
  }
  visit(styles.root)
  return names
}

/** The attribute a generated component sets for a variant property it takes as a prop. */
export function propAttribute(name: string): string {
  return `data-${cssName(name, 'prop')}`
}
