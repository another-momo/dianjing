#!/usr/bin/env bun
/**
 * check.ts —— render-jsx.md 与 design-jsx schema.ts 三清单双向门禁。
 *
 * 真源：packages/core/src/design-jsx/schema.ts（DESIGN_JSX_ELEMENTS /
 *       DESIGN_JSX_SUPPORTED_PROPERTY_NAMES / DESIGN_JSX_HELPERS）。
 * 教学源：src/app/ai/pi-backend/studio/references/render-jsx.md
 *       （agent load_reference 按需读取，三清单须与 schema 零漂移）。
 *
 * 双向校验：
 *   a. schema → md：每个 element / helper / property 名（EXCLUDE 项除外）
 *      必须出现在 md 全文中（backtick / name=... / 斜杠分组任一形态即算）。
 *   b. md → schema：「## Elements」节 Content 行 + Aliases 段 + 政策句
 *      与「Paint/effect helpers」行的反引号 token 必须都在 schema 常量内
 *      （或 EXCLUDE 豁免）。Props reference 节反向只做 a 向，不做反向全量
 *      （散文形态噪声大）。
 *
 * 失败时打印可操作清单并 process.exit(1)。
 *
 * 测试入口：check.ts 把 analyze 暴露为具名 export 供 tests/ 调；
 * main() 负责 CLI（读盘、打印、exit code）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  DESIGN_JSX_ELEMENTS,
  DESIGN_JSX_SUPPORTED_PROPERTY_NAMES,
  DESIGN_JSX_HELPERS
} from '#core/design-jsx/schema'

const MD_PATH = resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  'src/app/ai/pi-backend/studio/references/render-jsx.md'
)

/**
 * EXCLUDE 豁免两类：
 * ① md 第 19 行政策句明列「渲染器存在但刻意不教」项——
 *    元素：Component / ComponentSet / Instance
 *    helper：designVar / defineVars
 *    属性：of / component / componentId / properties / propertyRefs / bind
 *    （注释引自 render-jsx.md 第 19 行原文，编辑政策句时同步更新。）
 * ② key——schema 接受但渲染器不消费（JSX 习惯容忍位），教义不教。
 */
export const EXCLUDE: ReadonlySet<string> = new Set([
  'Component',
  'ComponentSet',
  'Instance',
  'designVar',
  'defineVars',
  'of',
  'component',
  'componentId',
  'properties',
  'propertyRefs',
  'bind',
  'key'
])

export type DriftKind = 'element' | 'helper' | 'property'
export type DriftDirection = 'schema->md' | 'md->schema'

export interface Drift {
  readonly kind: DriftKind
  readonly name: string
  readonly direction: DriftDirection
}

export interface Schema {
  readonly elements: ReadonlyArray<{ name: string }>
  readonly helpers: ReadonlyArray<{ name: string }>
  readonly properties: ReadonlyArray<string>
}

export const SCHEMA: Schema = {
  elements: DESIGN_JSX_ELEMENTS,
  helpers: DESIGN_JSX_HELPERS,
  properties: DESIGN_JSX_SUPPORTED_PROPERTY_NAMES
}

export function collectObservedTokens(md: string): Set<string> {
  const observed = new Set<string>()
  // 1) 反引号 token
  for (const m of md.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) observed.add(m[1])
  // 2) JSX prop 赋值：name= 紧跟 { / " / [ / ( / 数字 / 字母。
  //    覆盖 w={N}、flex="row"、fills=[...]、effects=(...) 等形态。
  const singlePropRe = /\b([A-Za-z][A-Za-z0-9_]*)=(?=\{|"|\[|-?\d|[A-Za-z])/g
  for (const m of md.matchAll(singlePropRe)) observed.add(m[1])
  // 3) 斜杠分组：pt/pr/pb/pl={N} → pt/pr/pb/pl 全部记入。
  const propGroupRe = /\b([A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)+)=/g
  for (const m of md.matchAll(propGroupRe)) {
    for (const piece of m[1].split('/')) observed.add(piece)
  }
  return observed
}

/**
 * schema → md：每个 canonical 名（EXCLUDE 除外）必须在 observed 集里。
 */
export function checkSchemaToMd(schema: Schema, observed: Set<string>, drifts: Drift[]): void {
  for (const e of schema.elements) {
    if (EXCLUDE.has(e.name)) continue
    if (!observed.has(e.name))
      drifts.push({ kind: 'element', name: e.name, direction: 'schema->md' })
  }
  for (const h of schema.helpers) {
    if (EXCLUDE.has(h.name)) continue
    if (!observed.has(h.name))
      drifts.push({ kind: 'helper', name: h.name, direction: 'schema->md' })
  }
  for (const p of schema.properties) {
    if (EXCLUDE.has(p)) continue
    if (!observed.has(p)) drifts.push({ kind: 'property', name: p, direction: 'schema->md' })
  }
}

/**
 * md → schema：解析两处枚举节——
 *   1) ## Elements 节（Content 行 + Aliases 段 + 政策句）—— 反引号 token
 *      必须在 schema.elements 或 EXCLUDE 集合里。
 *   2) Paint/effect helpers 行 —— 反引号 token 必须在 schema.helpers
 *      或 EXCLUDE 集合里。
 * Props reference 节散文形态噪声大，本方向只审上述两处。
 */
export function checkMdToSchema(schema: Schema, md: string, drifts: Drift[]): void {
  // ## Elements 节到下一节标题或裸段之前的范围。
  const elementsSection = md.match(/## Elements\n([\s\S]*?)(?=\n## |\n\n[A-Z#])/u)
  if (!elementsSection) {
    drifts.push({
      kind: 'element',
      name: '<missing ## Elements section>',
      direction: 'md->schema'
    })
    return
  }
  const elementNames = new Set(schema.elements.map((e) => e.name))
  for (const m of elementsSection[1].matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) {
    const token = m[1]
    if (EXCLUDE.has(token)) continue
    if (!elementNames.has(token)) {
      drifts.push({ kind: 'element', name: token, direction: 'md->schema' })
    }
  }

  // Paint/effect helpers 行：以该短语开头直到行尾。
  const helpersLineMatch = md.match(/^Paint\/effect helpers[^\n]*$/mu)
  if (!helpersLineMatch) {
    drifts.push({
      kind: 'helper',
      name: '<missing Paint/effect helpers line>',
      direction: 'md->schema'
    })
    return
  }
  const helperNames = new Set(schema.helpers.map((h) => h.name))
  for (const m of helpersLineMatch[0].matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) {
    const token = m[1]
    if (EXCLUDE.has(token)) continue
    if (!helperNames.has(token)) {
      drifts.push({ kind: 'helper', name: token, direction: 'md->schema' })
    }
  }
}

/**
 * 主分析入口：双向校验，返回排序后的 drift 列表。无副作用。
 */
export function analyze(schema: Schema, md: string): Drift[] {
  const observed = collectObservedTokens(md)
  const drifts: Drift[] = []
  checkSchemaToMd(schema, observed, drifts)
  checkMdToSchema(schema, md, drifts)
  drifts.sort((a, b) => {
    const k = a.kind.localeCompare(b.kind)
    if (k !== 0) return k
    const d = a.direction.localeCompare(b.direction)
    if (d !== 0) return d
    return a.name.localeCompare(b.name)
  })
  return drifts
}

function main(): void {
  const md = readFileSync(MD_PATH, 'utf8')
  const drifts = analyze(SCHEMA, md)

  if (drifts.length === 0) {
    console.log(
      `render-jsx.md and design-jsx schema are in sync (${DESIGN_JSX_ELEMENTS.length} elements, ${DESIGN_JSX_HELPERS.length} helpers, ${DESIGN_JSX_SUPPORTED_PROPERTY_NAMES.length} properties; EXCLUDE ${EXCLUDE.size}).`
    )
    return
  }

  console.error(`render-jsx.md drift vs design-jsx schema (${drifts.length} issue(s)):`)
  for (const d of drifts) console.error(`  [${d.kind} ${d.direction}] ${d.name}`)
  console.error('')
  console.error('修复指南：')
  console.error(
    '  schema->md：md 缺 schema 中已声明的 canonical 名——在 Props reference / Elements 节补回引号 token。'
  )
  console.error('  md->schema：md 列出的 token 不在 schema 常量——从 md 移除，或先在 schema 加名。')
  console.error(
    `  EXCLUDE 项（${EXCLUDE.size}）含 md 第 19 行政策句「刻意不教」项与 key（接受但渲染器不消费）。`
  )
  process.exit(1)
}

// 仅当作为 CLI 入口执行时跑 main()——避免 tests/ import 时副作用触发。
if (import.meta.main) main()
