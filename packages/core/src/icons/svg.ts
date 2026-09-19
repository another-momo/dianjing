import { iconToSVG } from '@iconify/utils'
import {
  DOMImplementation,
  type Document as XMLDocument,
  type Element,
  type Node
} from '@xmldom/xmldom'
import svgpath from 'svgpath'

import { parseSVGPath } from '@open-pencil/scene-graph/parse-path'
import type { Vector } from '@open-pencil/scene-graph/primitives'

import { parseSVGFragment } from '#core/io/formats/svg/document'

import type { IconData, IconifyIconEntry, IconPathInfo, SVGClipPathRegion } from './types'

/**
 * 2026-09-19「添加图片配套」件 1：extractPaths 只管 path 类元素，<text>/<image>
 * 矢量化为空被静默丢弃（实证样本 51 文本 + 2 内嵌 PNG 全丢）。extractRichContent
 * 在同一遍 DOM walk 里额外收集文本/内嵌位图，由 io/formats/svg 导入侧落成
 * TEXT / IMAGE-fill RECTANGLE 节点。
 */
export interface SVGTextElementInfo {
  x: number
  /** SVG 语义 = 基线 y（导入侧负责换算成节点顶边） */
  y: number
  content: string
  fontFamily: string | null
  fontSize: number | null
  fontWeight: number | null
  fill: string | null
  textAnchor: 'start' | 'middle' | 'end' | null
  transform: string | null
}

export interface SVGImageElementInfo {
  x: number
  y: number
  width: number
  height: number
  /** 原始 href——仅 data: URI 可离线解码，外链由消费方跳过 */
  href: string
  transform: string | null
}

export interface SVGRichContent {
  paths: IconPathInfo[]
  texts: SVGTextElementInfo[]
  images: SVGImageElementInfo[]
}

interface SVGElementInput {
  type: string
  props: Readonly<Record<string, unknown>>
  children: readonly (SVGElementInput | string)[]
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const JSX_ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  className: 'class',
  fillRule: 'fill-rule',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeWidth: 'stroke-width',
  xlinkHref: 'xlink:href'
}

interface PresentationAttributes {
  fill: string
  stroke: string
  strokeWidth: string
  strokeCap: string
  strokeJoin: string
  fillRule: string
}

const DEFAULT_PRESENTATION: PresentationAttributes = {
  fill: 'currentColor',
  stroke: 'none',
  strokeWidth: '1',
  strokeCap: 'butt',
  strokeJoin: 'miter',
  fillRule: 'nonzero'
}

const SHAPE_NAMES = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polygon', 'polyline'])
const NON_RENDERED_CONTAINERS = new Set(['defs', 'clipPath', 'mask', 'symbol'])

function isElement(node: Node): node is Element {
  return node.nodeType === node.ELEMENT_NODE
}

function inlineStyles(element: Element): ReadonlyMap<string, string> {
  const styles = new Map<string, string>()
  for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
    const separator = declaration.indexOf(':')
    if (separator <= 0) continue
    const name = declaration.slice(0, separator).trim()
    const value = declaration.slice(separator + 1).trim()
    if (name && value) styles.set(name, value)
  }
  return styles
}

function inheritedAttribute(
  element: Element,
  styles: ReadonlyMap<string, string>,
  name: string,
  inherited: string
): string {
  return (
    styles.get(name) ??
    (element.hasAttribute(name) ? (element.getAttribute(name) ?? inherited) : inherited)
  )
}

function presentationFor(
  element: Element,
  inherited: PresentationAttributes
): PresentationAttributes {
  const styles = inlineStyles(element)
  return {
    fill: inheritedAttribute(element, styles, 'fill', inherited.fill),
    stroke: inheritedAttribute(element, styles, 'stroke', inherited.stroke),
    strokeWidth: inheritedAttribute(element, styles, 'stroke-width', inherited.strokeWidth),
    strokeCap: inheritedAttribute(element, styles, 'stroke-linecap', inherited.strokeCap),
    strokeJoin: inheritedAttribute(element, styles, 'stroke-linejoin', inherited.strokeJoin),
    fillRule: inheritedAttribute(element, styles, 'fill-rule', inherited.fillRule)
  }
}

function num(element: Element, attr: string, fallback = 0): number {
  const value = element.getAttribute(attr)
  if (value === null) return fallback
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function circleToD(element: Element): string | null {
  const cx = num(element, 'cx')
  const cy = num(element, 'cy')
  const r = num(element, 'r')
  return r > 0
    ? `M${cx - r},${cy}A${r},${r},0,1,0,${cx + r},${cy}A${r},${r},0,1,0,${cx - r},${cy}Z`
    : null
}

function ellipseToD(element: Element): string | null {
  const cx = num(element, 'cx')
  const cy = num(element, 'cy')
  const rx = num(element, 'rx')
  const ry = num(element, 'ry')
  return rx > 0 && ry > 0
    ? `M${cx - rx},${cy}A${rx},${ry},0,1,0,${cx + rx},${cy}A${rx},${ry},0,1,0,${cx - rx},${cy}Z`
    : null
}

function rectToD(element: Element): string | null {
  const x = num(element, 'x')
  const y = num(element, 'y')
  const width = num(element, 'width')
  const height = num(element, 'height')
  if (width <= 0 || height <= 0) return null
  const rx = Math.min(num(element, 'rx'), width / 2)
  const ry = Math.min(num(element, 'ry', rx), height / 2)
  if (rx > 0 || ry > 0) {
    const arcX = rx || ry
    const arcY = ry || rx
    return `M${x + arcX},${y}H${x + width - arcX}A${arcX},${arcY},0,0,1,${x + width},${y + arcY}V${y + height - arcY}A${arcX},${arcY},0,0,1,${x + width - arcX},${y + height}H${x + arcX}A${arcX},${arcY},0,0,1,${x},${y + height - arcY}V${y + arcY}A${arcX},${arcY},0,0,1,${x + arcX},${y}Z`
  }
  return `M${x},${y}H${x + width}V${y + height}H${x}Z`
}

function pointsToD(element: Element, close: boolean): string | null {
  const points = element.getAttribute('points')
  if (!points) return null
  const values = points
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (values.length < 4 || values.length % 2 !== 0) return null
  let path = `M${values[0]},${values[1]}`
  for (let index = 2; index < values.length; index += 2) {
    path += `L${values[index]},${values[index + 1]}`
  }
  return close ? `${path}Z` : path
}

function shapeToD(tagName: string, element: Element): string | null {
  switch (tagName) {
    case 'circle':
      return circleToD(element)
    case 'ellipse':
      return ellipseToD(element)
    case 'rect':
      return rectToD(element)
    case 'line':
      return `M${num(element, 'x1')},${num(element, 'y1')}L${num(element, 'x2')},${num(element, 'y2')}`
    case 'polygon':
      return pointsToD(element, true)
    case 'polyline':
      return pointsToD(element, false)
    default:
      return null
  }
}

function combinedTransform(parent: string | null, element: Element): string | null {
  const current = element.getAttribute('transform')
  if (parent && current) return `${parent} ${current}`
  return current ?? parent
}

/**
 * 文本样式沿 DOM 祖先链向上取（就近优先）：字体属性在 SVG 里可继承，
 * 而 collectPaths 的 presentation 继承不带字体字段——文本元素少见，
 * 逐个向上走比给主 walk 加继承面更省。
 */
function inheritedTextAttribute(
  element: Element,
  name: 'font-family' | 'font-size' | 'font-weight' | 'text-anchor'
): string | null {
  let current: Element | null = element
  while (current) {
    const inline = inlineStyles(current).get(name)
    if (inline) return inline
    const attribute = current.getAttribute(name)
    if (attribute) return attribute
    const parent: Node | null = current.parentNode
    current = parent && isElement(parent) ? parent : null
  }
  return null
}

function normalizeTextAnchor(anchor: string | null): 'start' | 'middle' | 'end' | null {
  if (anchor === 'middle' || anchor === 'end') return anchor
  if (anchor === 'start') return 'start'
  return null
}

function collectTextElement(
  element: Element,
  presentation: PresentationAttributes,
  transform: string | null,
  rich: SVGRichContent
): void {
  const content = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (!content) return
  const fontSizeRaw = inheritedTextAttribute(element, 'font-size')
  const fontSize = fontSizeRaw ? Number.parseFloat(fontSizeRaw) : Number.NaN
  const fontWeightRaw = inheritedTextAttribute(element, 'font-weight')
  let fontWeight = Number.NaN
  if (fontWeightRaw === 'bold') fontWeight = 700
  else if (fontWeightRaw === 'normal') fontWeight = 400
  else if (fontWeightRaw) fontWeight = Number.parseInt(fontWeightRaw, 10)
  const anchor = inheritedTextAttribute(element, 'text-anchor')
  rich.texts.push({
    x: num(element, 'x'),
    y: num(element, 'y'),
    content,
    fontFamily: inheritedTextAttribute(element, 'font-family'),
    fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : null,
    fontWeight: Number.isFinite(fontWeight) ? fontWeight : null,
    fill: normalizeSVGPaint(presentation.fill),
    textAnchor: normalizeTextAnchor(anchor),
    transform
  })
}

function collectImageElement(
  element: Element,
  transform: string | null,
  rich: SVGRichContent
): void {
  const href = element.getAttribute('href') ?? element.getAttribute('xlink:href')
  const width = num(element, 'width')
  const height = num(element, 'height')
  if (!href || width <= 0 || height <= 0) return
  rich.images.push({ x: num(element, 'x'), y: num(element, 'y'), width, height, href, transform })
}

function normalizeSVGPaint(value: string | null): string | null {
  return value?.trim().toLowerCase() === 'none' ? null : value
}

function appendShapePath(
  tagName: string,
  element: Element,
  presentation: PresentationAttributes,
  transform: string | null,
  clipPaths: SVGClipPathRegion[],
  result: IconPathInfo[]
): void {
  if (!SHAPE_NAMES.has(tagName)) return
  const pathData = tagName === 'path' ? element.getAttribute('d') : shapeToD(tagName, element)
  if (!pathData) return
  const strokeWidth = Number.parseFloat(presentation.strokeWidth)
  result.push({
    d: pathData,
    fill: normalizeSVGPaint(presentation.fill),
    stroke: normalizeSVGPaint(presentation.stroke),
    strokeWidth: Number.isFinite(strokeWidth) ? strokeWidth : 1,
    strokeCap: presentation.strokeCap,
    strokeJoin: presentation.strokeJoin,
    fillRule: presentation.fillRule === 'evenodd' ? 'EVENODD' : 'NONZERO',
    transform,
    clipPaths: clipPaths.length > 0 ? clipPaths : undefined
  })
}

function collectUsePaths(
  element: Element,
  presentation: PresentationAttributes,
  transform: string | null,
  result: IconPathInfo[],
  elementsById: ReadonlyMap<string, Element>,
  useStack: ReadonlySet<Element>,
  clipPaths: SVGClipPathRegion[],
  rich?: SVGRichContent
): boolean {
  const tagName = element.localName || element.tagName
  if (tagName !== 'use') return false
  const x = num(element, 'x')
  const y = num(element, 'y')
  const useTransform =
    x !== 0 || y !== 0 ? `${transform ?? ''} translate(${x} ${y})`.trim() : transform
  const href = element.getAttribute('href') ?? element.getAttribute('xlink:href')
  const target = href?.startsWith('#') ? elementsById.get(href.slice(1)) : null
  if (target && !useStack.has(target)) {
    collectPaths(
      target,
      presentation,
      useTransform,
      result,
      elementsById,
      new Set([...useStack, target]),
      true,
      clipPaths,
      rich
    )
  }
  return true
}

function collectClipPath(
  value: string | null,
  parentTransform: string | null,
  elementsById: ReadonlyMap<string, Element>
): SVGClipPathRegion | null {
  const match = value?.trim().match(/^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/)
  const target = match ? elementsById.get(match[1]) : null
  if (!target || (target.localName || target.tagName) !== 'clipPath') return null

  const units =
    target.getAttribute('clipPathUnits') === 'objectBoundingBox'
      ? 'objectBoundingBox'
      : 'userSpaceOnUse'
  const paths: IconPathInfo[] = []
  collectPaths(
    target,
    { ...DEFAULT_PRESENTATION, fill: '#000000' },
    units === 'objectBoundingBox' ? null : parentTransform,
    paths,
    elementsById,
    new Set([target]),
    true
  )
  return {
    paths: paths.map(({ d, fillRule, transform }) => ({ d, fillRule, transform })),
    units
  }
}

function collectPaths(
  element: Element,
  inherited: PresentationAttributes,
  parentTransform: string | null,
  result: IconPathInfo[],
  elementsById: ReadonlyMap<string, Element>,
  useStack: ReadonlySet<Element> = new Set(),
  referenced = false,
  inheritedClipPaths: SVGClipPathRegion[] = [],
  rich?: SVGRichContent
): void {
  const tagName = element.localName || element.tagName
  if (NON_RENDERED_CONTAINERS.has(tagName) && !referenced) return

  const presentation = presentationFor(element, inherited)
  const transform = combinedTransform(parentTransform, element)
  const ownClipPath = collectClipPath(element.getAttribute('clip-path'), transform, elementsById)
  const clipPaths = ownClipPath ? [...inheritedClipPaths, ownClipPath] : inheritedClipPaths
  if (
    collectUsePaths(
      element,
      presentation,
      transform,
      result,
      elementsById,
      useStack,
      clipPaths,
      rich
    )
  )
    return
  appendShapePath(tagName, element, presentation, transform, clipPaths, result)
  if (rich && tagName === 'text') collectTextElement(element, presentation, transform, rich)
  if (rich && tagName === 'image') collectImageElement(element, transform, rich)

  for (const child of Array.from(element.childNodes)) {
    if (isElement(child)) {
      collectPaths(
        child,
        presentation,
        transform,
        result,
        elementsById,
        useStack,
        referenced,
        clipPaths,
        rich
      )
    }
  }
}

function appendSVGElement(svgDocument: XMLDocument, parent: Element, input: SVGElementInput): void {
  if (!/^[A-Za-z][\w:.-]*$/.test(input.type)) return
  const element = svgDocument.createElementNS(SVG_NAMESPACE, input.type)
  for (const [propName, value] of Object.entries(input.props)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const attributeName = JSX_ATTRIBUTE_NAMES[propName] ?? propName
    element.setAttribute(attributeName, String(value))
  }
  if (input.type === 'path' && !element.hasAttribute('d') && typeof input.props.body === 'string') {
    element.setAttribute('d', input.props.body)
  }
  for (const child of input.children) {
    if (typeof child !== 'string') appendSVGElement(svgDocument, element, child)
  }
  parent.appendChild(element)
}

function collectDocumentPaths(root: Element, rich?: SVGRichContent): IconPathInfo[] {
  const elementsById = new Map<string, Element>()
  for (const element of Array.from(root.getElementsByTagName('*'))) {
    const id = element.getAttribute('id')
    if (id) elementsById.set(id, element)
  }
  const result: IconPathInfo[] = []
  collectPaths(root, DEFAULT_PRESENTATION, null, result, elementsById, new Set(), false, [], rich)
  return result
}

export function extractPathsFromElements(
  elements: readonly SVGElementInput[],
  rootProps: Readonly<Record<string, unknown>> = {}
): IconPathInfo[] {
  const svgDocument = new DOMImplementation().createDocument(SVG_NAMESPACE, 'svg')
  const root = svgDocument.documentElement
  if (!root) return []
  appendSVGElement(svgDocument, root, { type: 'svg', props: rootProps, children: elements })
  return collectDocumentPaths(root)
}

// 剥 XML prolog/DOCTYPE：本函数把入参再包一层 <svg> 喂 XML 解析器，
// 文件头的 <?xml?> 声明与 <!DOCTYPE> 在内嵌位置被判非法 → 静默 0 路径
// （2026-09-18 定性：产品长图.svg 导入误报「支持 SVG」根因）。注释无害保留。
function stripXMLProlog(svgBody: string): string {
  return svgBody
    .trimStart()
    .replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
    .replace(/^<!DOCTYPE[\s\S]*?>\s*/i, '')
}

export function extractPaths(svgBody: string): IconPathInfo[] {
  const root = parseSVGFragment(stripXMLProlog(svgBody))?.documentElement
  return root ? collectDocumentPaths(root) : []
}

/** 与 extractPaths 同一路径解析，但同遍 walk 额外收集 <text>/<image>（导入侧用，图标管线仍走 extractPaths） */
export function extractRichContent(svgBody: string): SVGRichContent {
  const rich: SVGRichContent = { paths: [], texts: [], images: [] }
  const root = parseSVGFragment(stripXMLProlog(svgBody))?.documentElement
  if (root) rich.paths = collectDocumentPaths(root, rich)
  return rich
}

export function buildIconData(
  iconEntry: IconifyIconEntry,
  prefix: string,
  iconName: string,
  defaultW: number,
  defaultH: number,
  size: number
): IconData {
  const rendered = iconToSVG({
    body: iconEntry.body,
    width: iconEntry.width ?? defaultW,
    height: iconEntry.height ?? defaultH
  })
  const [, , viewBoxWidth, viewBoxHeight] = rendered.viewBox
  const scaleX = size / viewBoxWidth
  const scaleY = size / viewBoxHeight

  const pathInfos = extractPaths(rendered.body)

  return {
    prefix,
    name: iconName,
    width: size,
    height: size,
    paths: scalePathInfos(pathInfos, scaleX, scaleY)
  }
}

/** Conservative uniform scale of an SVG transform string (min of axis scales); exported for text sizing in the import pipeline. */
export function transformStrokeScale(transform: string | null | undefined): number {
  if (!transform || transform === 'none') return 1

  const points: Vector[] = []
  svgpath('M0 0 L1 0 M0 0 L0 1')
    .transform(transform)
    .abs()
    .iterate((segment) => {
      if (segment[0] === 'M' || segment[0] === 'L') {
        points.push({ x: segment[1], y: segment[2] })
      }
    })
  if (points.length < 4) return 1

  const xScale = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
  const yScale = Math.hypot(points[3].x - points[2].x, points[3].y - points[2].y)
  return Math.min(xScale, yScale)
}

/** Scale extracted SVG path info into IconData paths (shared by buildIconData and design-jsx <svg>). */
export function scalePathInfos(
  pathInfos: IconPathInfo[],
  scaleX: number,
  scaleY: number
): IconData['paths'] {
  return pathInfos.map((path) => {
    let transformedPath = svgpath(path.d)
    if (path.transform && path.transform !== 'none') {
      transformedPath = transformedPath.transform(path.transform)
    }
    if (scaleX !== 1 || scaleY !== 1) transformedPath = transformedPath.scale(scaleX, scaleY)
    const scaledD = transformedPath.round(2).toString()
    return {
      vectorNetwork: parseSVGPath(scaledD, path.fillRule),
      fill: normalizeSVGPaint(path.fill),
      stroke: normalizeSVGPaint(path.stroke),
      strokeWidth:
        path.strokeWidth * transformStrokeScale(path.transform) * Math.min(scaleX, scaleY),
      strokeCap: path.strokeCap,
      strokeJoin: path.strokeJoin
    }
  })
}
