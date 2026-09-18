/**
 * T54（Phase 3 W2/T-B3）：AI 可见 generate_image 的后端编排（双段执行）。
 *
 * 拓扑（S3 §4 / 01 B.3 裁决 2）：
 *   AI 工具调用 → 本模块 execute（pi-backend 进程）
 *     1. 凭证读取（credentials store，缺 key → 结构化错误引导设置页配置）
 *     2. parseImageGenRequests（core 纯函数层，尺寸/枚举语义校验）
 *     3. begin 段串行经桥（image_gen_begin：误传保护/参考图提取/目标解析；
 *        串行 = 00 #10 并发放置竞态修复——每次 begin 重读页面 bounds，
 *        后一帧看到前一帧）
 *     4. provider HTTP 并行直发（不经桥；key 不出本进程）
 *     5. commit 段串行经桥（image_gen_commit：覆盖前快照 + 写 IMAGE fill）
 *
 * T66（P4/P5）：工具参数从单 JSON 字符串拆为 schema 化数组（九字段，
 * additionalProperties: false——字段拼错/类型/嵌套/枚举四类错误由 pi
 * 运行时 schema 校验在 execute 前拒绝并回执模型自纠，pi-ai
 * validateToolArguments 实证）；description 瘦身至 2000 字符内。
 * parseImageGenRequests 保留字符串宽容解析为兼容降级（见 core requests.ts）。
 *
 * T77 P7：legacy `background` 字段从 schema 移除——provider 侧固定，Agent 无感
 * （owner 2026-09-02 决策；详见 docs/202609010000-image-gen-provider-review.md
 * P7 与 provider.ts 头注）。parseImageGenRequests 的 ImageGenBackground
 * 类型与解析保留不动（类型层向后兼容）。
 *
 * transparent_background 参数（owner 2026-09-10 裁决，详见
 * docs/202609101102-transparent-bg-research.md）：agent 侧开关——api provider
 * 透传 `background='transparent'`；local provider 走 prompt 键色注入 + 后处理。
 * schema 字段 hint 不承载 prompt 规则（T82 钉扎），具体键色规则活在
 * transparent.ts 常量里。
 *
 * 装配形态：createImageGenTool(deps) 工厂返回 pi AgentTool——由主 agent
 * 集成期在 service.ts 装配进 customTools（本任务不改 service.ts/tools.ts）。
 *
 * pi-ai generateImages 扩展槽（路线乙登记）：deps.createProvider 即槽位——
 * 未来以 pi-ai generateImages 实现 ImageGenProvider（契约钉扎见
 * spikes/probes/sp/a1-images-contract.mjs）后经同一 deps 注入；本任务不实现。
 *
 * key 卫生：桥 payload 只含 prompt/尺寸/节点 id/图像 base64；provider 结果
 * 只回画布元数据（无图像字节回 AI，无 key）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { decodeBase64, encodeBase64 } from '@open-pencil/core/bytes'
import {
  parseImageGenRequests,
  type ImageGenProvider,
  type ImageGenRequest,
  type ImageGenResult
} from '@open-pencil/core/tools/fork/image-gen/requests'

import { formatImageGenDateBucket } from '../paths'
import { createBridgeCaller, type BridgeCaller, type BridgeCallTarget } from './bridge-call'
import type { ImageGenCredentials, ImageGenCredentialStore } from './credentials'
import { createProviderFor } from './factory'
import { KEY_COLOR_PROMPT_SUFFIX, removeKeyedBackgroundFromPNG } from './transparent'

/** 与 fork/image-gen/tools.ts 的桥端点对齐 */
const BEGIN_TOOL = 'image_gen_begin'
const COMMIT_TOOL = 'image_gen_commit'

/**
 * AI 面向契约文案（双段执行对模型透明）。T66 P5：瘦身至 2000 字符内
 * （测试断言钉扎上限）——参数细节由 schema 自带 description 承担，
 * 本文只保留行为语义（replace/references/批量/验收/缺 key 引导）。
 * 备份机制为内部设施——不向模型暴露页名/容器等落点细节，仅声明
 * 「旧版本自动保留、可作 reference 复用」的功能语义（owner 2026-09-01 裁定）。
 */
export const GENERATE_IMAGE_DESCRIPTION = `Generate or edit images via the configured OpenAI-compatible image API and place them on the canvas as image nodes.

REPLACE vs CREATE: set \`replace_id\` to fill an existing node, replacing its current fill (on Frames it becomes the frame background with children kept — the standard text-over-image hero/image-swap pattern). Omit it to create a new node (auto-placed right of page content, never overlapping). Replacing never loses an image: the previous version is auto-preserved and stays reusable as a reference.

REFERENCES are the ONLY input-image source: a node contributes its original IMAGE bytes by default (lossless); nodes WITHOUT an IMAGE fill are rendered automatically. Use {"id":"...","composite":true} for the rendered appearance (children, effects, rounded corners). No references = text-to-image; with references = image-to-image. To EDIT an image, set \`replace_id\` to it AND include its id in \`references\`; to REGENERATE unbiased, set \`replace_id\` but omit the target from \`references\`. Name multiple references [image 1], [image 2], ... in the prompt in order. A reference must not point at another batch item's output — split dependent edits into separate calls.

Generation is SLOW: batch ALL needed images in ONE call — never loop single calls. Any width/height is accepted — 16px-aligned and clipped to API constraints preserving aspect ratio; adjustments are reported in note.

TRANSPARENT BACKGROUND: set \`transparent_background: true\` for cutouts needing a transparent canvas; omit when opaque.

Returns node metadata (no image bytes): inspect with \`describe\`, accept visually with \`look\`; on miss, regenerate with an adjusted prompt (max 2 attempts). On missing key or 401, tell the user to add/check the Image Generation API key in AI chat settings (separate from the chat LLM key) — do NOT fall back to eval-drawn gradients.

结果项 \`file_path\` = 留存副本绝对路径（未留存为 null），仅供显式用户需求或字节类 skill 工作流使用；不要默认 \`load_image\` / \`export_image_to_file\` 回读画布——画布节点即工作产物，无谓磁盘往返会增加延迟、干扰画布流。`

export interface ImageGenToolDeps {
  credentials: ImageGenCredentialStore
  /** 桥调用（缺省 createBridgeCaller()）；测试注入 mock */
  callBridge?: BridgeCaller
  /** provider 工厂（缺省 OpenAI 兼容 provider）；pi-ai generateImages 扩展槽/测试 mock */
  createProvider?: (credentials: ImageGenCredentials) => ImageGenProvider
  /** 当次请求的桥目标袋（service 集成期注入，同 tools.ts ToolTargetSource 语义；T98-路由含 windowId） */
  target?: BridgeCallTarget
  /**
   * 图片本地留存开关（owner 拍板，默认 OFF）。service.ts 装配期注入——
   * enabled() 每条 item 实时问 settings store（用户可在 AI 运行期间切换）；
   * dir() 每次返回留存**根目录**绝对路径（resolveImageGenOutputDir(rootDir)），
   * 实际写盘由 maybeRetain 按生图日期分桶 `<根>/<YYYY-MM-DD>/` 并 mkdir
   * recursive 兜底。
   *
   * 失败语义：写盘异常 → 仅 console.warn，不进 toolResult / note / agent
   * 通道，画布 commit 不受影响（owner 拍板：静默失败，避免污染结果契约）。
   */
  retention?: { enabled(): boolean; dir(): string }
}

interface BeginPayload {
  id: string
  width: number
  height: number
  canvasWidth: number
  canvasHeight: number
  replaced: boolean
  images?: string[]
  note?: string
}

interface CommitPayload {
  id?: string
  canvasWidth?: number
  canvasHeight?: number
  snapshot?: { id: string; name: string; version: number }
  error?: string
}

interface ItemResult {
  id: string
  width?: number
  height?: number
  canvasWidth?: number
  canvasHeight?: number
  provider?: string
  snapshot?: { id: string; name: string; version: number }
  note?: string
  error?: string
  /** T33: true=透明背景后处理成功；false=未启用/未执行；'failed'=启用但后处理失败已回退原 bytes */
  transparent?: boolean | 'failed'
  /** 2026-09-18：maybeRetain 命中留存时透出落盘绝对路径；未命中/失败 = null */
  file_path?: string | null
  /** 2026-09-18：最终生效输出格式的 MIME（transparent 强制 png 已反映） */
  mimeType?: string
  /** 2026-09-18：落盘字节数（与画布 IMAGE fill 同一份 bytes） */
  byteLength?: number
}

type PipelineItem = {
  req: ImageGenRequest
  begin?: BeginPayload
  images?: Uint8Array[]
  gen?: ImageGenResult
  error?: string
  /** T33: 后处理失败原因（仅当 transparent === 'failed' 时存在） */
  transparentError?: string
  /** 生成段最终生效 outputFormat（transparent 强制 png 已反映）——本地留存扩展名口径 */
  effectiveFormat?: ImageGenRequest['outputFormat']
}

function toToolResult(result: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    details: result
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 本地留存小函数（owner 拍板：writeFileSync 失败静默——只 console.warn，
 * 不进 toolResult / note / agent 通道）。
 *
 * 落盘形态（2026-09-18 userdata 重排）：`<留存根>/<YYYY-MM-DD>/<文件名>`——
 * 按生图日期分桶（ISO 日期，资源管理器字典序 = 时序），mkdir recursive
 * 下沉到日期桶；时区 = 本地（与文件名时间戳同口径，formatImageGenDateBucket
 * 单源）。留存根由 retention.dir() 注入（生产 = resolveImageGenOutputDir，
 * DTO 下发根目录——用户经「打开文件夹」进根自选日期桶）。
 *
 * 文件名口径：`YYYYMMDD-hhmmss-<批次内序号>-<宽>x<高>.<ext>`。
 *   - ext 取生成段最终生效格式（item.effectiveFormat，runGeneratePhase
 *     落袋）——transparent 强制 png 已反映；直接读 item.req 会在
 *     jpeg/webp + transparent 组合下把 png 字节写成 .jpeg/.webp 扩展名。
 *     ImageGenResult 形状无 format 字段（core 抽象），agent 未指定时兜 png。
 *   - 同秒多 item 靠批次内序号后缀区分；跨调用同秒同尺寸撞名覆盖即可——
 *     用户语义是「保留最近一次的本地副本」，无版本控制需求。
 *
 * 2026-09-18 本地图片工具链（§4.1）：命中留存时返回落盘绝对路径，由
 * runCommitPhase 透出到工具返回值 file_path 字段；写盘失败/未留存返回 null
 * （静默语义不变——留存失败永不污染工具结果）。
 *
 * 整个写盘 try/catch 包裹——禁空 catch，必须把 msg 透出到 warn；任何 IO
 * 异常（permission denied / disk full / readonly volume）都不应拖累画布
 * commit。
 */
function maybeRetain(
  retention: { enabled(): boolean; dir(): string } | undefined,
  format: ImageGenRequest['outputFormat'],
  gen: ImageGenResult,
  batchIndex: number
): string | null {
  if (!retention || !retention.enabled()) return null
  try {
    const now = new Date()
    const dir = join(retention.dir(), formatImageGenDateBucket(now))
    mkdirSync(dir, { recursive: true })
    const yyyy = now.getFullYear().toString().padStart(4, '0')
    const mm = (now.getMonth() + 1).toString().padStart(2, '0')
    const dd = now.getDate().toString().padStart(2, '0')
    const HH = now.getHours().toString().padStart(2, '0')
    const MM = now.getMinutes().toString().padStart(2, '0')
    const SS = now.getSeconds().toString().padStart(2, '0')
    const ext = format ?? 'png'
    const filename = `${yyyy}${mm}${dd}-${HH}${MM}${SS}-${batchIndex}-${gen.width}x${gen.height}.${ext}`
    const filePath = join(dir, filename)
    writeFileSync(filePath, gen.bytes)
    return filePath
  } catch (error) {
    console.warn(
      '[pi-backend] image-gen 本地留存失败（忽略）：' +
        (error instanceof Error ? error.message : String(error))
    )
    return null
  }
}

/** begin 段（串行：每次 begin 重读页面 bounds，00 #10 竞态修复） */
async function runBeginPhase(
  requests: ImageGenRequest[],
  callBridge: BridgeCaller,
  target: BridgeCallTarget | undefined
): Promise<PipelineItem[]> {
  const items: PipelineItem[] = []
  for (const req of requests) {
    try {
      const beginArgs: Record<string, unknown> = { prompt: req.prompt }
      if (req.width !== undefined) beginArgs.width = req.width
      if (req.height !== undefined) beginArgs.height = req.height
      if (req.replaceId) beginArgs.replace_id = req.replaceId
      if (req.references) beginArgs.references = JSON.stringify(req.references)
      const begin = (await callBridge(BEGIN_TOOL, beginArgs, target)) as Partial<BeginPayload> & {
        error?: string
      }
      if (begin.error || !begin.id) {
        items.push({ req, error: begin.error ?? 'image_gen_begin returned no target id' })
        continue
      }
      items.push({
        req,
        begin: begin as BeginPayload,
        images: (begin.images ?? []).map((b64) => decodeBase64(b64))
      })
    } catch (error) {
      items.push({ req, error: toErrorMessage(error) })
    }
  }
  return items
}

/** 生成段（并行：provider HTTP 直发，不经桥）。
 * T33 透明背景：local provider（Seedream 等不支持原生透明）走 prompt 注入 +
 * 后处理路径——下发到 provider 的 prompt 追加 KEY_COLOR_PROMPT_SUFFIX；返回
 * bytes 后过 removeKeyedBackgroundFromPNG；抛错回退原 bytes 并记 transparentError。
 * api provider（OpenAI 兼容）原生透传 background='transparent'，本函数不做干预。*/
async function runGeneratePhase(items: PipelineItem[], provider: ImageGenProvider): Promise<void> {
  const localPath = provider.transparentSupport === 'local'
  await Promise.all(
    items.map(async (item) => {
      if (!item.begin) return
      const transparent = item.req.transparent_background === true
      // 输出格式约束（spec C7）：api 路径 jpeg → png；local 路径一律 png（编解码仅 PNG）
      let formatOverride = item.req.outputFormat
      if (transparent && (localPath || item.req.outputFormat === 'jpeg')) {
        formatOverride = 'png'
      }

      const finalReq: ImageGenRequest = {
        ...item.req,
        width: item.begin.width,
        height: item.begin.height,
        outputFormat: formatOverride,
        prompt:
          transparent && localPath
            ? `${item.req.prompt}\n\n${KEY_COLOR_PROMPT_SUFFIX}`
            : item.req.prompt
      }
      item.effectiveFormat = finalReq.outputFormat

      try {
        const generated = await provider.generate(
          finalReq,
          item.images && item.images.length > 0 ? item.images : undefined
        )

        if (transparent && localPath) {
          // 后处理：失败回退原 bytes（spec C6：try/catch 包裹，沿用参考项目失败回退设计）
          try {
            item.gen = {
              ...generated,
              bytes: removeKeyedBackgroundFromPNG(generated.bytes)
            }
          } catch (error) {
            item.gen = generated
            item.transparentError = toErrorMessage(error)
          }
        } else {
          item.gen = generated
        }
      } catch (error) {
        item.error = toErrorMessage(error)
      }
    })
  )
}

/** commit 段（串行经桥：覆盖快照 + 写 fill）→ 逐条结果 */
async function runCommitPhase(
  items: PipelineItem[],
  provider: ImageGenProvider,
  callBridge: BridgeCaller,
  target: BridgeCallTarget | undefined,
  retention?: { enabled(): boolean; dir(): string }
): Promise<ItemResult[]> {
  const results: ItemResult[] = []
  for (const [i, item] of items.entries()) {
    if (!item.begin) {
      results.push({ id: item.req.replaceId ?? '', error: item.error ?? 'begin failed' })
      continue
    }
    if (item.error || !item.gen) {
      results.push({ id: item.begin.id, error: item.error ?? 'image generation failed' })
      continue
    }
    try {
      const commit = (await callBridge(
        COMMIT_TOOL,
        { id: item.begin.id, image_data: encodeBase64(item.gen.bytes) },
        target
      )) as CommitPayload
      if (commit.error || !commit.id) {
        results.push({
          id: item.begin.id,
          error: commit.error ?? 'image_gen_commit returned no id'
        })
        continue
      }
      // 本地留存：commit 成功后立刻落盘——bytes 与画布 IMAGE fill 是同一份
      // （透明背景后处理之后）；序号 = 批次内位置（同秒多 item 区分用）。
      // 2026-09-18：命中透出绝对路径到 file_path（未命中/失败 = null）
      const retainedPath = maybeRetain(retention, item.effectiveFormat, item.gen, i)
      const effectiveFormat = item.effectiveFormat ?? 'png'
      const commitResult: {
        id: string
        width?: number
        height?: number
        canvasWidth?: number
        canvasHeight?: number
        provider?: string
        snapshot?: { id: string; name: string; version: number }
        note?: string
        error?: string
        transparent?: boolean | 'failed'
        file_path?: string | null
        mimeType?: string
        byteLength?: number
      } = {
        id: commit.id,
        width: item.gen.width,
        height: item.gen.height,
        canvasWidth: commit.canvasWidth,
        canvasHeight: commit.canvasHeight,
        provider: provider.name,
        file_path: retainedPath,
        mimeType: `image/${effectiveFormat}`,
        byteLength: item.gen.bytes.byteLength
      }
      if (commit.snapshot) commitResult.snapshot = commit.snapshot
      if (item.begin.note) commitResult.note = item.begin.note
      // T33: 透明背景标注——api 路径只要 agent 显式 true 即视为成功（上游处理）；
      // local 路径成功后处理成功记 true，失败记 'failed'。false/未传不标。
      if (item.req.transparent_background === true) {
        if (provider.transparentSupport === 'local') {
          commitResult.transparent = item.transparentError ? 'failed' : true
          if (item.transparentError) {
            // 失败原因必须可见——只标 'failed' 不给原因，agent 无从判断下一步
            commitResult.note = [
              item.begin.note,
              `transparent post-process failed（已回退原图）: ${item.transparentError}`
            ]
              .filter(Boolean)
              .join('; ')
          }
        } else {
          commitResult.transparent = true
        }
      }
      results.push(commitResult)
    } catch (error) {
      results.push({ id: item.begin.id, error: toErrorMessage(error) })
    }
  }
  return results
}

/**
 * T66 P4：requests 拆为 schema 化数组（九字段，与 core requests.ts 解析层
 * RawRequest 对齐——T77 P7 删 legacy background，2026-09-10 加
 * transparent_background 字段，由 agent 显式传入）。
 * additionalProperties: false 让字段拼错（target_id 等）在 pi 运行时 schema
 * 校验期即拒绝；width/height 的「新图必填」是条件约束，schema 表达不了，
 * 留在 parseImageGenRequests 语义层（错误文案引导补全）。
 */
export const GENERATE_IMAGE_PARAMETERS = Type.Object({
  requests: Type.Array(
    Type.Object(
      {
        prompt: Type.String({
          description: 'Text prompt'
        }),
        width: Type.Optional(
          Type.Number({ description: 'Image width in pixels (required for new images)' })
        ),
        height: Type.Optional(
          Type.Number({ description: 'Image height in pixels (required for new images)' })
        ),
        quality: Type.Optional(
          Type.Union(
            [
              Type.Literal('auto'),
              Type.Literal('low'),
              Type.Literal('medium'),
              Type.Literal('high')
            ],
            { description: 'Image quality (default: auto for speed)' }
          )
        ),
        output_format: Type.Optional(
          Type.Union([Type.Literal('png'), Type.Literal('jpeg'), Type.Literal('webp')], {
            description: 'Output format (default: png)'
          })
        ),
        output_compression: Type.Optional(
          Type.Number({ description: 'JPEG/WebP compression 0-100 (only with jpeg/webp)' })
        ),
        transparent_background: Type.Optional(
          Type.Boolean({
            description:
              'true=透明背景：openai 兼容端点走 API 原生透明；seedream 等不支持的端点自动走键色抠图后处理。未传=auto 由供应商决定'
          })
        ),
        replace_id: Type.Optional(
          Type.String({ description: 'Existing node ID to fill (omit = create new node)' })
        ),
        references: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.String({ description: 'Canvas node ID' }),
                composite: Type.Optional(
                  Type.Boolean({
                    description:
                      'true = rendered appearance (children/effects); default = original image bytes'
                  })
                )
              },
              { additionalProperties: false }
            ),
            { description: 'Input node IDs for image-to-image editing' }
          )
        )
      },
      { additionalProperties: false }
    ),
    { description: 'Generation/edit items — batch ALL needed images in one call' }
  )
})

export function createImageGenTool(deps: ImageGenToolDeps) {
  return defineTool({
    name: 'generate_image',
    label: 'Generate Image',
    description: GENERATE_IMAGE_DESCRIPTION,
    parameters: GENERATE_IMAGE_PARAMETERS,
    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const credentials = deps.credentials.get()
      if (!credentials) {
        return toToolResult({
          error:
            'No image-gen provider configured. Add an image-gen API key in settings (separate from the chat LLM key).'
        })
      }
      const providerFactory =
        deps.createProvider ?? ((creds: ImageGenCredentials) => createProviderFor(creds))
      const provider = providerFactory(credentials)
      const callBridge = deps.callBridge ?? createBridgeCaller()

      const parsed = parseImageGenRequests(params.requests)
      if ('error' in parsed) return toToolResult({ error: parsed.error })

      const items = await runBeginPhase(parsed.requests, callBridge, deps.target)
      await runGeneratePhase(items, provider)
      const results = await runCommitPhase(items, provider, callBridge, deps.target, deps.retention)

      const ok = results.filter((result) => result.id && !result.error).length
      const toolResult: {
        generated: number
        failed: number
        provider: string
        note?: string
        warning?: string
        results: typeof results
      } = {
        generated: ok,
        failed: results.length - ok,
        provider: provider.name,
        results
      }
      if (parsed.sizeNote) toolResult.note = parsed.sizeNote
      if (parsed.warning) toolResult.warning = parsed.warning
      return toToolResult(toolResult)
    }
  })
}
