/**
 * T43/T87/S3 §4/S3 §5 pi 后端路径解析单点化层。
 *
 * 演进：
 *  - C3 单点化：把状态根 / 子目录名 / studio 资产目录对的解析收口成纯函数
 *    resolver，原位散点拼接（rootDir + '.dianjing' + 'pi-agent'、host.ts
 *    隐式 cwd 契约等）逐字搬迁，行为零变化。
 *  - D2 扁平化 + 统一根：删除 `.dianjing` 双层嵌套（D2 后该目录概念消亡），
 *    `STATE_DIR_NAME` 拼接层从 resolver 全部去除——子目录直接挂 rootDir。
 *    userDir 随 rootDir 走（不再独走 homedir）——状态根统一进 OS 标准应用
 *    数据目录（resolveAppDataRoot），三形态（dev/host/Electron）共享同一
 *    真源。DIANJING_ROOT_DIR override 语义改为「直接指向状态根本身」
 *    （不再内含 .dianjing 子层），smoke/spike 同步重写。
 *  - 2026-09-18 userdata 目录重排：用户扩展层 `studio/` → `workspace/.agents/`
 *    （平铺迁移，复数命名对齐 pi SDK 原生 `.agents/skills` 约定），生图留存
 *    `image-gen-output/` → `workspace/image-gen-output/` 且写盘按生图日期
 *    建 `YYYY-MM-DD/` 子桶——agent 读写面收拢进 workspace 单根。存量一次性
 *    迁移由 migrate.ts 承担（启动序列 seed 之前）；配套 key-guard 写侧 deny
 *    扩 `workspace/.agents/**`（新增自植暴露面同批关闭，无空窗）。
 *
 * 行为纪律（搬迁 = 纯重构）：
 *  - 子目录名（`pi-agent` / `pi-sessions` / `key-env` / `skills` /
 *    `workspace/.agents` / `workspace/image-gen-output` / `pi-backend-token` /
 *    `pi-sessions-archive` / `workspace`）单源——搬家时只动本文件
 *  - `DIANJING_ROOT_DIR` override 直指根（smoke/spike 配套重写）
 *  - studio 双源（builtinDir / userDir）解析语义保留；userDir 与 rootDir
 *    一致（D2 起不再独立于 rootDir）
 *  - 资产两层语义（内置只读 + 用户可写、_ 前缀跳过、seed 失败仅 warn）一行不动
 *
 * 与 env.ts 的关系：本文件不直接读 env——env 由调用方解析后传入。env.ts 的
 * readRootDir / readStudioBuiltinDir 是推荐入口，但 paths.ts 函数签名只
 * 接受字符串，便于测试注入 fixture。rootDir 缺省值的「OS 应用数据目录」
 * 解析单源由 orchestration/app-data 的 resolveAppDataRoot 承担。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports
import { resolveAppDataRoot } from '../../orchestration/app-data'

// ── .dianjing 子目录名常量（单源，D2 后 STATE_DIR_NAME 已退）──

/** pi agent 持久化目录（capabilities.json / auth.json / image-gen.json） */
export const PI_AGENT_SUBDIR = 'pi-agent'

/** pi session JSONL 目录 */
export const PI_SESSIONS_SUBDIR = 'pi-sessions'

/** session 归档目录（不建索引） */
export const PI_SESSIONS_ARCHIVE_SUBDIR = 'pi-sessions-archive'

/** key-env 自助注入文件（main.ts T25 D3 读盘） */
export const KEY_ENV_FILENAME = 'key-env'

/** skills 单源目录（capabilities.ts T89 / service.ts T91b 收敛） */
export const SKILLS_SUBDIR = 'skills'

/** standalone 模式鉴权 token 落盘文件名 */
export const PI_BACKEND_TOKEN_FILENAME = 'pi-backend-token'

/**
 * 会话工作目录子目录（agent 文件工具/bash 的相对路径基点）——与凭据文件所在根隔离
 * （2026-09-16 key 守卫 B 案，须配 key-guard A 案）。createAgentSession options.cwd 下沉
 * 此处后，老会话 JSONL header cwd 与 options.cwd 不一致也不再走老 cwd（sdk.js:67
 * `options.cwd ?? options.sessionManager?.getCwd()` 实证，options 优先）。
 */
export const PI_WORKSPACE_SUBDIR = 'workspace'

/**
 * studio 用户扩展目录子路径（2026-09-18 起 = `workspace/.agents`，平铺：
 * base.md / workflows/ / profiles/ / skills/ / references/ 直接放 `.agents/`
 * 根，不做 `.agents/studio` 嵌套）。复数 `.agents` 对齐 pi SDK 原生
 * `.agents/skills` 约定；内置层目录名仍叫 studio（源码树/打包 resources 位，
 * dot-directory 不进源码树防工具链盲区）——不一致点在此消解，勿再对齐。
 */
export const USER_STUDIO_SUBPATH = join(PI_WORKSPACE_SUBDIR, '.agents')

/**
 * studio 内置资产目录相对仓库根的子路径——三形态 spawn 方（vite-plugin /
 * host.ts / Electron main）据此经 DIANJING_STUDIO_BUILTIN_DIR 注入；join
 * (rootDir, …) 兜底仅覆盖「无 env 直跑 main.ts」场景（此时 rootDir 是状态
 * 根，拼出的路径实际不存在，seed 早返为空——已知限制，不走该形态交付）。
 */
export const BUILTIN_STUDIO_SUBPATH = join('src', 'app', 'ai', 'pi-backend', 'studio')

// ── stateDir 拼接 helper（D2 起 rootDir 即状态根本身，无 STATE_DIR_NAME 层）──

/**
 * 状态根本身——D2 起 rootDir 直接是状态根（OS 应用数据目录下的 Dianjing
 * 子目录），无需再拼接顶层子目录。
 *
 * 原位 `join(rootDir, '.dianjing')` 字面量 14 处统一收口后（D2）该函数
 * 退化为 identity——保留为单点契约：调用方拿到的 rootDir 即状态根，可直接
 * 用作 builtinDir / 解析子目录（join(rootDir, PI_AGENT_SUBDIR) 等）。
 *
 * env override 缺省走 caller-resolved rootDir（见 main.ts: resolveAppDataRoot
 * / host.ts: 同上 / Electron: app.getPath('userData')）。
 */
export function resolveStateDir(rootDir: string): string {
  return rootDir
}

/**
 * 状态根解析（main.ts 形态）——env override 优先，缺省走 OS 应用数据目录
 * 下的 Dianjing 子目录。
 *
 * D2 起：override 直指状态根本身（不再内含 .dianjing 子层）；缺省由
 * resolveAppDataRoot 单点解析（Win %APPDATA%/Dianjing、macOS
 * ~/Library/Application Support/Dianjing、Linux $XDG_CONFIG_HOME/Dianjing
 * 或 ~/.config/Dianjing）。
 *
 * env/platform 走参数注入——测试纪律：禁读真实 env；platform 缺省
 * process.platform。
 */
export function resolveRootDir(
  envOverride: string | null,
  envSource?: { readonly [key: string]: string | undefined } | null,
  runtimePlatform?: string
): string {
  if (envOverride !== null) return envOverride
  return resolveAppDataRoot(envSource ?? null, runtimePlatform)
}

/**
 * 状态根解析（Electron 形态）——env override 优先，缺省走 caller-resolved
 * fallback（main.ts 注入 app.getPath('userData')）。D2 起 userData 路径
 * 即状态根，与 app-data 的 resolveAppDataRoot 对齐——Electron 自动把
 * `app.setName(USER_DATA_DIR_NAME)` 后的 userData 解析到 OS 应用数据目录
 * 下的 Dianjing 子目录。
 */
export function resolveElectronRootDir(envOverride: string | null, userData: string): string {
  return envOverride ?? userData
}

// ── 子目录 resolver ──

/** `rootDir/pi-agent/` */
export function resolveAgentDir(rootDir: string): string {
  return join(rootDir, PI_AGENT_SUBDIR)
}

/** `rootDir/pi-sessions/` */
export function resolveSessionsDir(rootDir: string): string {
  return join(rootDir, PI_SESSIONS_SUBDIR)
}

/** `rootDir/pi-sessions-archive/` */
export function resolveArchiveDir(rootDir: string): string {
  return join(rootDir, PI_SESSIONS_ARCHIVE_SUBDIR)
}

/** `rootDir/key-env` */
export function resolveKeyEnvPath(rootDir: string): string {
  return join(rootDir, KEY_ENV_FILENAME)
}

/** `rootDir/workspace/.agents/skills/` —— skills 与用户扩展资产 workflows/profiles
 *  同根：上层 studio 双源解析（builtin/user）已承载资产覆盖语义；skills 也按 user 覆盖
 *  builtin 加载（service.ts 的 DefaultResourceLoader.additionalSkillPaths 喂同一 userDir
 *  路径，SDK 跑默认扫描仅看 builtin 模板目录）。skills 收进用户扩展目录后三类资产
 *  同一目录根——用户复制内置 `_example` 即可看到完整样例。 */
export function resolveSkillsDir(rootDir: string): string {
  return join(rootDir, USER_STUDIO_SUBPATH, SKILLS_SUBDIR)
}

/** `rootDir/pi-backend-token` */
export function resolvePiBackendTokenPath(rootDir: string): string {
  return join(rootDir, PI_BACKEND_TOKEN_FILENAME)
}

/** `<builtinStudioDir>/skills/` —— 与 resolveSkillsDir 同构：内置 studio
 *  资产下的 skills/ 子路径（内置 skill 落点；目录可空置或不存在——消费面
 *  capabilities existsSync 守卫、SDK 对缺失路径仅记 diagnostic 不抛）。入参
 *  即 readStudioBuiltinDir() 的产物（env.ts:221）；与 resolveSkillsDir(rootDir)
 *  构成 additionalSkillPaths 的双源。 */
export function resolveBuiltinSkillsDir(builtinStudioDir: string): string {
  return join(builtinStudioDir, SKILLS_SUBDIR)
}

/** `rootDir/workspace/image-gen-output/` —— generate_image 「图片本地留存」根目录
 * （2026-09-18 起移入 workspace，与 .agents 同根收拢 agent 读写面）；本地副本
 * 与画布 IMAGE fill 是同一份 bytes（透明背景后处理之后）。实际写盘按生图日期
 * 分桶到 `<根>/YYYY-MM-DD/`（见 resolveImageGenDatedDir）——本常量只是桶的
 * 父根，DTO `dir` 字段与「打开文件夹」端点仍下发/打开根目录（用户进根自选
 * 日期桶）。 */
export const IMAGE_GEN_OUTPUT_SUBDIR = join(PI_WORKSPACE_SUBDIR, 'image-gen-output')

/** `rootDir/workspace/image-gen-output/` —— 留存根目录（UI 展示 / 端点打开用） */
export function resolveImageGenOutputDir(rootDir: string): string {
  return join(rootDir, IMAGE_GEN_OUTPUT_SUBDIR)
}

/**
 * 日期桶名 `YYYY-MM-DD`（本地时区，与 writeLocalCopy 文件名时间戳同口径）；
 * ISO 形态让资源管理器字典序 = 时序。
 */
export function formatImageGenDateBucket(date: Date): string {
  const yyyy = date.getFullYear().toString().padStart(4, '0')
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** `rootDir/workspace/image-gen-output/YYYY-MM-DD/` —— 生图留存日期分桶落点 */
export function resolveImageGenDatedDir(rootDir: string, date: Date): string {
  return join(resolveImageGenOutputDir(rootDir), formatImageGenDateBucket(date))
}

/** `rootDir/workspace/mcp-downloads/` —— MCP 工具返回的 image/audio 等二进制块的
 *  本地存盘根目录（蓝本 craft-agents 的 `sessionPath/downloads/` 落点平移）；
 *  实际文件名由调用方按 `safeName_<timestamp><ext>` 模式拼接（MCP server
 *  名 + 时间戳 + 魔数派生的扩展名）。 */
export const MCP_DOWNLOADS_SUBDIR = join(PI_WORKSPACE_SUBDIR, 'mcp-downloads')

/** `rootDir/workspace/mcp-downloads/` —— MCP 二进制存盘根解析 */
export function resolveMCPDownloadsDir(rootDir: string): string {
  return join(rootDir, MCP_DOWNLOADS_SUBDIR)
}

// ── studio 双源 resolver ──

/**
 * studio 双源解析（builtin + user）——单源。
 *
 * 原位两处（pi-backend/service.ts:173-175 / studio/registry.ts:399-401）：
 *  - builtinDir：`DIANJING_STUDIO_BUILTIN_DIR || join(rootDir, 内置子路径)`
 *  - userDir：`join(homedir(), '.dianjing', 'studio')`（D2 前）
 *
 * D2 起：userDir 不再独立走 homedir——状态根已统一进 OS 应用数据目录，
 * userDir 随 rootDir 走；2026-09-18 起 = `<状态根>/workspace/.agents`
 * （USER_STUDIO_SUBPATH 单源）。内置只读 + 用户可写同 id
 * 覆盖 + _ 前缀跳过 + seed warn-only 等两层资产语义由 registry / seed /
 * service 各层承担，本函数不掺行为。
 */
export interface StudioDirs {
  builtinDir: string
  userDir: string
}

export function resolveStudioDirs(rootDir: string, envBuiltinOverride: string | null): StudioDirs {
  return {
    builtinDir: envBuiltinOverride ?? join(rootDir, BUILTIN_STUDIO_SUBPATH),
    userDir: join(rootDir, USER_STUDIO_SUBPATH)
  }
}

/** `rootDir/workspace/` —— 凭据守卫 B 案的会话 cwd 下沉落点（与凭据四件所在根隔离） */
export function resolveWorkspaceDir(rootDir: string): string {
  return join(rootDir, PI_WORKSPACE_SUBDIR)
}

// ── UI 展示形态（缩写/绝对路径回退）──

/**
 * `toDisplayPath` 注入形参——平台与前缀目录可被覆盖，便于 posix CI
 * 覆盖 win32 分支、单测注入 fixture 而非读真实 process.env。
 * 三态语义：`undefined`（键缺席）= 取进程真实缺省；`null` = 显式禁用
 * 前缀缩写（原样回绝对路径）；字符串 = 用它做前缀匹配。
 *
 *  - `platform`：缺省 `process.platform`（win32 走 `%APPDATA%` 缩写，
 *    非 win32 走 `~` 缩写）
 *  - `appDataDir`：win32 下用于前缀匹配——缺省 `process.env.APPDATA`
 *  - `homeDir`：非 win32 用于前缀匹配——缺省 `os.homedir()`
 */
export interface DisplayPathEnv {
  platform?: NodeJS.Platform
  appDataDir?: string | null
  homeDir?: string | null
}

/**
 * 把绝对路径转成 UI 展示形态——便于直接粘贴进资源管理器 / shell：
 *  - win32 + `appDataDir` 前缀匹配 → `%APPDATA%` + 余段
 *  - 非 win32 + `homeDir` 前缀匹配 → `~` + 余段
 *  - 前缀不匹配（DIANJING_ROOT_DIR 隔离、临时目录等场景）→ 原样返回绝对路径
 *
 * 跨平台守卫：双方 `replaceAll('\\', '/')` 归一化 + 剥尾随 `/`，
 * `p === prefix || p.startsWith(prefix + '/')` 才算命中；返回值保留
 * absPath 原分隔符（slice 在原串上做，不重写分隔符）。
 *
 * 测试纪律：禁走 `path.isAbsolute` / `path.relative` 等平台语义 API
 * （不同 OS 下语义分裂）；自实现前缀规则保证注入 fixture 的可读性。
 */
export function toDisplayPath(absPath: string, env: DisplayPathEnv = {}): string {
  const platform: NodeJS.Platform = env.platform ?? process.platform
  // undefined = 取进程真实缺省；null = 显式禁用（前缀判空即原样回）
  let prefix: string | null | undefined
  if (platform === 'win32') {
    prefix = env.appDataDir === undefined ? process.env.APPDATA : env.appDataDir
  } else {
    prefix = env.homeDir === undefined ? homedir() : env.homeDir
  }
  if (typeof prefix !== 'string' || prefix === '') return absPath
  const p = absPath.replaceAll('\\', '/')
  const pre = prefix.replaceAll('\\', '/').replace(/\/+$/, '')
  if (!pre) return absPath
  if (p !== pre && !p.startsWith(pre + '/')) return absPath
  // slice 在原串上做：pre 是归一化后的 prefix（剥尾随 /），与 absPath 起点对齐
  const sliceFrom = prefix.replace(/[\\/]+$/, '').length
  if (platform === 'win32') return '%APPDATA%' + absPath.slice(sliceFrom)
  return '~' + absPath.slice(sliceFrom)
}
