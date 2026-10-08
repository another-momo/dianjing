import { uniq } from 'es-toolkit/array'
import { transform } from 'sucrase'

import type { SceneGraph } from '@open-pencil/scene-graph'

import { designJSXHelpers } from './helpers'
import * as React from './mini-react'
import { renderRoots, renderTree, type RenderResult } from './renderer'
import { DESIGN_JSX_SUPPORTED_PROPERTIES } from './schema'
import type { DesignJSXServices } from './services'
import { isTreeNode, resolveToTree, type TreeNode } from './tree'
import type { RenderOptions as RenderJSXOptions } from './types'

/**
 * Build a component function from a JSX string using sucrase.
 * Works in both Node/Bun and the browser (no native bindings).
 */
const SUPPORTED_PROPS = DESIGN_JSX_SUPPORTED_PROPERTIES

function stripHTMLComments(jsxString: string): string {
  return jsxString.replace(/<!--[\s\S]*?-->/g, '')
}

function unsupportedPropWarnings(tree: TreeNode): string[] {
  const warnings: string[] = []
  collectUnsupportedPropWarnings(tree, warnings)
  return warnings
}

const SVG_ROOT_PROPS = new Set([...SUPPORTED_PROPS, 'viewBox', 'body'])

function collectUnsupportedPropWarnings(tree: TreeNode, warnings: string[]): void {
  const supportedProps = tree.type === 'svg' ? SVG_ROOT_PROPS : SUPPORTED_PROPS
  for (const key of Object.keys(tree.props)) {
    if (!supportedProps.has(key)) {
      warnings.push(`Unsupported prop "${key}" on <${tree.type}> is ignored.`)
    }
  }

  // SVG descendants are parsed as markup by renderSvgNode, not as Design JSX nodes.
  if (tree.type === 'svg') return

  for (const child of tree.children) {
    if (isTreeNode(child)) collectUnsupportedPropWarnings(child, warnings)
  }
}

/**
 * T98：sucrase 语法错误 → 模型可操作的 JSX 报错。
 * sucrase message 形如 "Unexpected token (29:103)"，坐标基于包装后源码
 * （prelude = 别名块 + return 语句前缀）——映射回 jsx 入参的 1-based 行/列；
 * 映射不上（非该格式或落进 prelude）时省略坐标、保留原文。指引文案对齐
 * studio/base.md 的 render 规则（valid JSX only，不带字面 </jsx>）。
 * 列是近似值：sucrase 报的是解析器止步位置，未必是肇事 token 本身。
 */
function jsxSyntaxErrorMessage(error: unknown, prelude: string, firstLineOffset: number): string {
  const raw = error instanceof Error ? error.message : String(error)
  const guidance =
    'Output valid JSX only — pass JSX content directly, without markdown fences or a literal closing tag such as </jsx>.'
  const match = /^(.*?)\s*\((\d+):(\d+)\)\s*$/.exec(raw)
  if (!match) return `Invalid JSX: ${raw}. ${guidance}`
  const [, what, lineText, columnText] = match
  const preludeLineCount = prelude.split('\n').length // jsx 首行在包装源码中的 1-based 行号
  const preludeLastLineLength = prelude.length - prelude.lastIndexOf('\n') - 1
  const line = Number(lineText) - preludeLineCount + 1
  if (line < 1) return `Invalid JSX: ${what}. ${guidance}`
  const column =
    line === 1
      ? Math.max(1, Number(columnText) - preludeLastLineLength - firstLineOffset)
      : Number(columnText)
  return `Invalid JSX: ${what} at line ${line}, column ${column} of the jsx input. ${guidance}`
}

export function buildComponent(jsxString: string, warnings: string[] = []): React.ComponentType {
  const trimmed = stripHTMLComments(jsxString).trim()

  const aliases = `
    const __h = React.createElement
    const __frag = ''
    const Frame = 'frame', Text = 'text', Rectangle = 'rectangle', Ellipse = 'ellipse'
    const Line = 'line', Star = 'star', Polygon = 'polygon', Vector = 'vector'
    const Group = 'group', Section = 'section', View = 'frame', Rect = 'rectangle'
    const Component = 'component', ComponentSet = 'component-set', Instance = 'instance'
    const Icon = 'icon'
    const svg = 'svg'
    const dropShadow = __helpers.dropShadow
    const innerShadow = __helpers.innerShadow
    const layerBlur = __helpers.layerBlur
    const backgroundBlur = __helpers.backgroundBlur
    const foregroundBlur = __helpers.foregroundBlur
    const solid = __helpers.solid
    const gradient = __helpers.gradient
    const linearGradient = __helpers.linearGradient
    const radialGradient = __helpers.radialGradient
    const angularGradient = __helpers.angularGradient
    const diamondGradient = __helpers.diamondGradient
    const __varSymbol = Symbol.for('open-pencil.variable')
    const designVar = (def, value) => typeof def === 'string'
      ? ({ [__varSymbol]: true, id: def, name: def, value })
      : ({ [__varSymbol]: true, id: def.id, name: def.name ?? def.id ?? '', value: def.value })
    const defineVars = (vars) => Object.fromEntries(
      Object.entries(vars).map(([key, def]) => [key, designVar(def)])
    )
  `
  const opts = {
    transforms: ['typescript', 'jsx'] as Array<'typescript' | 'jsx'>,
    jsxPragma: '__h',
    jsxFragmentPragma: '__frag',
    production: true
  }

  const prelude = `${aliases}\nreturn function __render() { return `
  let code: string
  try {
    code = transform(`${prelude}${trimmed} }`, opts).code
  } catch {
    try {
      code = transform(`${prelude}<>${trimmed}</> }`, opts).code
    } catch (error) {
      // T98：sucrase 报错坐标基于包装后源码（别名前缀约 28 行 + return 前缀），
      // 对用户输入误导性强（单行输入实证报 "(29:103)"）——映射回 jsx 入参
      // 坐标并附可操作指引（对齐 studio/base.md「Output valid JSX only —
      // never emit a literal </jsx> tag」规则）
      throw new Error(jsxSyntaxErrorMessage(error, prelude, '<>'.length))
    }
  }

  // eslint-disable-next-line typescript-eslint/no-implied-eval -- sucrase output must be evaluated at runtime
  return new Function('React', '__helpers', code)(
    React,
    designJSXHelpers(warnings)
  ) as React.ComponentType
}

/**
 * Render a JSX string into the scene graph.
 * Works in both Node/Bun and the browser.
 */
async function renderJSX<Artwork>(
  services: DesignJSXServices<Artwork>,
  graph: SceneGraph,
  jsxString: string,
  options?: RenderJSXOptions
): Promise<RenderResult[]> {
  const helperWarnings: string[] = []
  const Component = buildComponent(jsxString, helperWarnings)
  const element = React.createElement(Component, null)
  const tree = resolveToTree(element)

  if (!tree) {
    throw new Error('JSX must return a Figma element (Frame, Text, etc)')
  }

  // A helper called in a loop reports each ignored option once.
  const warnings = uniq([...unsupportedPropWarnings(tree), ...helperWarnings])

  const results = await renderRoots(services, graph, tree, options)
  if (warnings.length > 0) results[0].warnings = warnings
  return results
}

/**
 * A Design JSX renderer bound to an engine. Rendering needs `services` for icons, inline
 * SVG, and layout; OpenPencil's engine provides them through `@open-pencil/core/design-jsx`.
 */
export function createDesignJSXRenderer<Artwork>(services: DesignJSXServices<Artwork>) {
  return {
    /** Render a Design JSX string into the graph, one result per top-level element. */
    renderJSX: (graph: SceneGraph, jsxString: string, options?: RenderJSXOptions) =>
      renderJSX(services, graph, jsxString, options),
    /** Render a tree built with the element functions into the graph. */
    renderTree: (graph: SceneGraph, tree: TreeNode, options?: RenderJSXOptions) =>
      renderTree(services, graph, tree, options)
  }
}

export type DesignJSXRenderer = ReturnType<typeof createDesignJSXRenderer>
