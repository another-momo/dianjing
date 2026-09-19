/**
 * 2026-09-18 本地图片工具链（仓外 docs/202609151700-load-image-tool-research.md
 * §4，Phase 3）：export_image_to_file——画布节点写盘的唯一 agent 入口。
 *
 * 形态 = customTools 包装层（不新做 core 工具）：
 *   桥调 core 既有 export_image（vector/export.ts：bounds 计算/scale/maxEdge/
 *   多格式/节点查找全复用）拿 base64 → decodeBase64 → 路径判定（写侧，
 *   与 load_image 同判定服务 decidePath——broker P0-1 收编在
 *   ./path-decision.ts，本工具调 write facet）→ fs.writeFile → 返回 file_path。
 *
 * 死代码警告（方案 §4.1）：core export_image schema 的 `path` 字段与
 * OPENPENCIL_MCP_ROOT 是从未实现的死代码——不复用不引用，本工具独立设计
 * output_path 参数。
 *
 * output_path 省略时默认落 `workspace/image-gen-output/<YYYY-MM-DD>/`
 * （resolveImageGenDatedDir，与 maybeRetain 留存同根同桶），文件命名对齐
 * maybeRetain 约定 `YYYYMMDD-hhmmss-<序号>-<宽>x<高>.<ext>`（单次调用单文件，
 * 序号恒 0）。
 *
 * 与 MEDIA_OUTPUT_TOOLS 不耦合（media-output.ts）：本工具返回值不含 base64，
 * 字节只落盘不进模型上下文。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { decodeBase64 } from '@open-pencil/core/bytes'

import { createBridgeCaller } from './image-gen/bridge-call'
import { type LoadImageToolDeps } from './load-image'
import { decidePath } from './path-decision'
import { resolveImageGenDatedDir } from './paths'
import { toToolResult } from './tool-result'

const EXPORT_IMAGE_TO_FILE_DESCRIPTION = `Export canvas nodes as a raster image (PNG/JPG/WEBP) and write it to a local file, returning the file path. Defaults to the workspace image-gen-output directory (date-bucketed) when \`output_path\` is omitted; an explicit \`output_path\` must stay inside the workspace.

仅在确实需要节点 bytes 时调用——两种正当情形：skill 处理；或用户显式要求导出/保存为文件（用户给了路径就按其 \`output_path\` 写，直接调用，不要拒绝也不要改指菜单操作）。**不要**在无人要求时为「完整记录」或「安全备份」主动调用——正常工作流以画布节点为准，不主动做磁盘往返。`

/** maybeRetain 命名约定同款时间戳（YYYYMMDD-hhmmss，本地时区） */
function filenameTimestamp(now: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return (
    `${now.getFullYear().toString().padStart(4, '0')}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

const FORMAT_TO_EXT: Record<string, string> = { PNG: 'png', JPG: 'jpg', WEBP: 'webp' }

/**
 * 与 LoadImageToolDeps 完全同形（rootDir/callBridge?/target?/homeDir?/cwd?）——
 * 仓规同形对象类型别名复用（type-shapes 门禁），字段语义注释见 load-image.ts。
 */
export type ExportImageToFileToolDeps = LoadImageToolDeps

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createExportImageToFileTool(deps: ExportImageToFileToolDeps) {
  return defineTool({
    name: 'export_image_to_file',
    label: 'Export Image To File',
    description: EXPORT_IMAGE_TO_FILE_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Node IDs to export. Omit to export all top-level nodes on the current page.'
        })
      ),
      format: Type.Optional(
        Type.Union([Type.Literal('PNG'), Type.Literal('JPG'), Type.Literal('WEBP')], {
          description: 'Image format (default: PNG)'
        })
      ),
      scale: Type.Optional(
        Type.Number({
          description: 'Export scale multiplier before the max-edge limit (default: 1)'
        })
      ),
      maxEdge: Type.Optional(
        Type.Number({
          description: 'Maximum output width or height in pixels (default: 1280; max 4096)'
        })
      ),
      output_path: Type.Optional(
        Type.String({
          description:
            'Absolute output file path (must be inside the workspace). Omit to write into workspace/image-gen-output/<YYYY-MM-DD>/ with an auto-generated name.'
        })
      )
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      // 1. 桥调 core export_image 拿 base64（bounds/scale/maxEdge 逻辑全复用）
      const callBridge = deps.callBridge ?? createBridgeCaller()
      const bridgeArgs: Record<string, unknown> = {}
      if (params.ids && params.ids.length > 0) bridgeArgs.ids = params.ids
      if (params.format) bridgeArgs.format = params.format
      if (params.scale !== undefined) bridgeArgs.scale = params.scale
      if (params.maxEdge !== undefined) bridgeArgs.maxEdge = params.maxEdge

      let exported: Record<string, unknown>
      try {
        exported = await callBridge('export_image', bridgeArgs, deps.target)
      } catch (error) {
        // 桥调用层抛错已是分类/清洗后的模型可见文案（bridge-errors.ts）
        return toToolResult({ error: toErrorMessage(error) })
      }
      if (typeof exported.error === 'string' && exported.error) {
        return toToolResult({ error: exported.error })
      }
      const base64 = exported.base64
      if (typeof base64 !== 'string' || base64.length === 0) {
        return toToolResult({ error: 'Export failed: bridge returned no image data.' })
      }
      const bytes = decodeBase64(base64)
      const format = params.format ?? 'PNG'
      const ext = FORMAT_TO_EXT[format] ?? 'png'
      const width = typeof exported.width === 'number' ? exported.width : 0
      const height = typeof exported.height === 'number' ? exported.height : 0
      const mimeType = typeof exported.mimeType === 'string' ? exported.mimeType : `image/${ext}`

      // 2. 落点解析：显式 output_path 走判定服务（write facet）；省略默认留存日期桶
      let filePath: string
      if (params.output_path) {
        const decision = decidePath(params.output_path, {
          facet: 'write',
          rootDir: deps.rootDir,
          cwd: deps.cwd,
          homeDir: deps.homeDir
        })
        if (!decision.ok) return toToolResult({ error: decision.error, reason: decision.reason })
        filePath = decision.absolutePath
      } else {
        const dir = resolveImageGenDatedDir(deps.rootDir, new Date())
        filePath = join(dir, `${filenameTimestamp(new Date())}-0-${width}x${height}.${ext}`)
      }

      // 3. 写盘
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, bytes)
      } catch (error) {
        return toToolResult({ error: `Failed to write file: ${toErrorMessage(error)}` })
      }
      return toToolResult({
        file_path: filePath,
        mimeType,
        width,
        height,
        byteLength: bytes.byteLength
      })
    }
  })
}
