/**
 * T85（资产 references 按需读取机制，定谳 4）：load_reference 后端本地工具工厂——全新建。
 *
 * 语义：三类 studio 资产 frontmatter 声明 `references: [{path, description}]`（声明即
 * 白名单），assembleTurn 把本回合 active 资产的并集索引进 systemPrompt 尾段（「按需
 * 参考」节，active-design-host.ts）；本工具是唯一读取缝——`noTools: 'builtin'` 禁
 * pi 内建 read 不变。允许集 = 本回合 active 资产声明的 references 并集（宿主持有于
 * turn 缓存袋，finalizeTurn 随 turn=null 复位——同 intentConfirmed 一次性态纪律）。
 *
 * 命中 → 读文件返回全文（50KB 上限，超出按字节截断 + 尾部注明）；未命中/未声明 →
 * 结构化错误并列出本回合可读 path 清单；`..` / 绝对路径在 validate（声明期）与本工具
 * （运行期）双侧拒（纵深防御——白名单键本身是归一化相对路径，遍历串天然不命中，
 * 本侧显式拒止给出清晰错误而非误导性的「未声明」）。
 *
 * 装配形态：createLoadReferenceTool(deps) 工厂返回 pi AgentTool——service.ts 装配进
 * customTools（createAskUserQuestionTool 同缝）。无桥调用、无凭证、无落盘——纯本地
 * 文件读取 + 白名单判定。
 *
 * P2-3（2026-09-07）：`read_reference` → `load_reference` 重命名——与 pi 内建 `read`
 * 工具名前缀拉开距离（语义「加载参考文档」而非「读取文件」），agent 不易混淆。
 *
 * P2-3a（2026-09-07）：path 校验与 validate.ts 同口径放宽为白名单
 * [.md,.txt,.json,.yaml,.csv]；50KB 截断逻辑不变。
 *
 * 2026-09-15（layer-splitting 实跑误用复盘）：pi skill 经 SDK additionalSkillPaths
 * 加载、其 references 不进本机制白名单——agent 见「reference」字样易误拿本工具
 * 读 skill 引用。描述与 not_allowed 错误文案双双点名「skill references 不在覆盖
 * 面、改用 read 工具」；并补「索引节缺席 = 本回合无可读项，勿调」防空调用。
 *
 * 2026-09-21 owner 拍板统一限定形寻址：path 参数恒为索引节行首 key
 * （`base/<path>` / `workflow:<id>/<path>` / `profile:<id>/<path>`）——agent 侧
 * 只剩一条规则 = 照抄行首 key。允许集同步只登记限定 key（详见 types.ts
 * `referenceAddressPrefix` + active-design-host.ts `collectActiveReferences`）。
 * 描述与 not_allowed 错误文案同步坍缩；近失检测（near-miss candidates）覆盖
 * 陈旧裸路径 / `base/...` 误前缀 / `base:base/...` 误抄三类已知误拼——在已拒
 * 分支跑确定性段边界匹配，不在热路径。
 */

import { readFileSync } from 'node:fs'

import { defineTool, type AgentToolResult } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { referencePathProblem } from './studio/reference-path'
import { toToolResult } from './tool-result'

/** 单次读取体积上限（超出按字节截断 + 尾部注明） */
export const LOAD_REFERENCE_MAX_BYTES = 50 * 1024

const LOAD_REFERENCE_DESCRIPTION =
  'Load one on-demand reference file declared by the active studio assets (base/workflow/profile). The readable keys for THIS turn are listed in the system prompt section "按需参考（load_reference 工具按需读取）" — copy `path` verbatim from the row-leading key (e.g. `base/references/render-jsx.md`, `workflow:longform/references/imagery.md`); if that section is absent, nothing is readable this turn — do not call this tool. Reads are whitelisted per turn: any other path is rejected and the error echoes the readable list. Only studio assets are ever whitelisted — agent-skill references (paths inside a <skill> block, relative to the skill baseDir) are never readable here; use the `read` tool for those instead. Returns the file text (truncated past 50KB with a trailing note). Use it to pull detailed design guidance only when the current step actually needs it — do not pre-read everything.'

/** not_allowed 错误文案共用尾句——skill references 永不进白名单，指往 read（2026-09-15 误用复盘） */
const NOT_ALLOWED_SKILL_HINT =
  '；agent skill 的 references 不在本工具覆盖面——请改用 read 工具（绝对路径 = skill 块 baseDir + 相对路径）'

/** not_allowed 错误共用前缀——引导 agent 去找正确 key（2026-09-21 拍板加注） */
const NOT_ALLOWED_HINT = '是不是要读上面的某条？照抄该行行首 key（含桶前缀）即可命中。'

export interface LoadReferenceToolDeps {
  /** 本回合允许集（限定形 key → 加载期解析绝对路径）；宿主每回合装配、finalizeTurn 复位 */
  allowedPaths(): ReadonlyMap<string, string>
  /** 文件读取（缺省 node:fs 同步读 utf8，同 registry 加载口径）；测试注入确定性 */
  readFile?: (absolutePath: string) => string
}

/** 运行期遍历/绝对路径拒止（null = 通过）；validate 侧拒声明期，本侧拒运行期（纵深防御，
 *  规则本体 = studio/reference-path.ts 单一真源） */
const rejectedPathReason = referencePathProblem

/**
 * 近失候选匹配（2026-09-21 拍板同批）——确定性段边界匹配，识别「requested 是某合法 key
 * 的尾部」这一类确定关系；不跑相似度评分/模糊匹配。
 *
 * 例：`base/references/render-jsx.md` → 命中 `base/references/render-jsx.md`
 *   `references/render-jsx.md` → 剥首段再试 → 命中
 *   `render-jsx.md` → 再剥 → 命中（asset-architecture.md 等非命中，因段边界）
 *   `base:base/references/render-jsx.md`（base 桶误抄结巴形）→ 全等匹配
 *
 * 复杂度 O(key 数 × 段数)；key 个位数、段 ≤4；只跑在已拒分支（非热路径）。
 * `'/' + form` 段边界锚保证 `jsx.md` 不会误中 `render-jsx.md`。
 */
function nearMissCandidates(requested: string, allowed: ReadonlyMap<string, string>): string[] {
  const found = new Set<string>()
  let form = requested
  for (;;) {
    for (const key of allowed.keys()) {
      if (key === form || key.endsWith('/' + form)) found.add(key)
    }
    const slash = form.indexOf('/')
    if (slash === -1) break
    form = form.slice(slash + 1)
  }
  return [...found]
}

export function createLoadReferenceTool(deps: LoadReferenceToolDeps) {
  const readFile = deps.readFile ?? ((absolutePath: string) => readFileSync(absolutePath, 'utf8'))
  return defineTool({
    name: 'load_reference',
    label: 'Load Reference',
    description: LOAD_REFERENCE_DESCRIPTION,
    parameters: Type.Object({
      path: Type.String({
        description:
          'Copy verbatim from the row-leading key in the 按需参考 section (e.g. `base/references/render-jsx.md`)'
      })
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const requested = typeof params.path === 'string' ? params.path.trim() : ''
      // 请求侧同口径归一（validate 存储形态 = 正斜杠相对路径；限定形 key 内置 `/`）
      const normalized = requested.replaceAll('\\', '/')
      const allowed = deps.allowedPaths()
      const available = [...allowed.keys()]

      const rejected = requested === '' ? 'path 为空' : rejectedPathReason(normalized)
      if (rejected) {
        return toToolResult({
          error: 'reference_path_rejected',
          message: `path「${requested}」${rejected}——只接受本回合「按需参考」节列出的白名单扩展名限定 key`,
          available
        })
      }

      const abs = allowed.get(normalized)
      if (!abs) {
        const baseMessage =
          available.length === 0
            ? `path「${normalized}」不在本回合可读清单——本回合 active 资产未声明任何 references（无可读项）${NOT_ALLOWED_SKILL_HINT}`
            : `path「${normalized}」不在本回合可读清单——仅可读：${available.join('、')}${NOT_ALLOWED_SKILL_HINT}`
        const candidates = nearMissCandidates(normalized, allowed)
        let hint = ''
        if (candidates.length === 1) {
          hint = `（你是不是要读「${candidates[0]}」？${NOT_ALLOWED_HINT}）`
        } else if (candidates.length > 1) {
          hint = `（看起来像是要读以下之一：「${candidates.join('、')}」——同名跨桶各条都列在索引里；${NOT_ALLOWED_HINT}）`
        }
        return toToolResult({
          error: 'reference_not_allowed',
          message: `${baseMessage}${hint}`,
          available
        })
      }

      let text: string
      try {
        text = readFile(abs)
      } catch (e) {
        return toToolResult({
          error: 'reference_read_failed',
          message: `读取失败：${e instanceof Error ? e.message : String(e)}——文件在加载期存在性已检，运行期缺失通常是加载后被移动/删除；重载 studio 注册表后再试`,
          available
        })
      }

      const bytes = Buffer.byteLength(text, 'utf8')
      let truncated = false
      if (bytes > LOAD_REFERENCE_MAX_BYTES) {
        truncated = true
        // 字节截断可能切开多字节字符——剥掉边界替代符（U+FFFD），保持输出为干净 utf8
        text = Buffer.from(text, 'utf8')
          .subarray(0, LOAD_REFERENCE_MAX_BYTES)
          .toString('utf8')
          .replace(/�+$/, '')
        text += `\n\n[已截断：原文约 ${Math.round(bytes / 1024)}KB，超出 ${LOAD_REFERENCE_MAX_BYTES / 1024}KB 上限——以上为前 50KB]`
      }
      return {
        content: [{ type: 'text', text }],
        details: { path: normalized, bytes, truncated }
      }
    }
  })
}
