import { toJsonSchema as toJSONSchema } from '@valibot/to-json-schema'

import { ALL_TOOLS, FigmaAPI, SceneGraph } from '@open-pencil/core'
import type { ToolDef } from '@open-pencil/core/tools'

export { ALL_TOOLS }

import { expectDefined } from './assert'

export interface ToolResult {
  id?: string
  name?: string
  type?: string
  error?: string
  count?: number
  nodes?: Array<{ id?: string; name: string; type: string }>
  [key: string]: unknown
}

export function setupToolTest() {
  const graph = new SceneGraph()
  const figma = new FigmaAPI(graph)
  return { graph, figma }
}

export function getTool(name: string): (typeof ALL_TOOLS)[number] {
  return expectDefined(
    ALL_TOOLS.find((tool) => tool.name === name),
    `tool ${name}`
  )
}

/**
 * PR697 后工具 input 的 wire contract 投影（LLM 可见 JSON Schema）——
 * 参数面钉扎测试统一走这里，不触内部 Valibot 结构。
 */
export function toolInputSchema(def: ToolDef): {
  properties: Record<string, Record<string, unknown>>
  required?: string[]
} {
  const schema = toJSONSchema(def.input, { typeMode: 'input' }) as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }
  return { properties: schema.properties ?? {}, required: schema.required }
}
