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
 *
 * 行为纪律（搬迁 = 纯重构）：
 *  - 子目录名（`pi-agent` / `pi-sessions` / `key-env` / `skills` / `studio` /
 *    `pi-backend-token` / `pi-sessions-archive` / `workspace`）单源——搬家时只动本文件
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

/** studio 用户扩展目录子路径（D2 起相对 rootDir，无双层嵌套） */
export const USER_STUDIO_SUBPATH = 'studio'

/**
 * 会话工作目录子目录（agent 文件工具/bash 的相对路径基点）——与凭据文件所在根隔离
 * （2026-09-16 key 守卫 B 案，须配 key-guard A 案）。createAgentSession options.cwd 下沉
 * 此处后，老会话 JSONL header cwd 与 options.cwd 不一致也不再走老 cwd（sdk.js:67
 * `options.cwd ?? options.sessionManager?.getCwd()` 实证，options 优先）。
 */
export const PI_WORKSPACE_SUBDIR = 'workspace'

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

/** `rootDir/studio/skills/` —— skills 与 studio workflows/profiles 同根：
 *  上层 studio 双源解析（builtin/user）已承载资产覆盖语义；skills 也按 user 覆盖
 *  builtin 加载（service.ts 的 DefaultResourceLoader.additionalSkillPaths 喂同一 userDir
 *  路径，SDK 跑默认扫描仅看 builtin 模板目录）。把 skills 收进 studio/ 后三类资产
 *  同一目录根——用户复制内置 `_example` 即可看到完整样例。 */
export function resolveSkillsDir(rootDir: string): string {
  return join(rootDir, USER_STUDIO_SUBPATH, SKILLS_SUBDIR)
}

/** `rootDir/pi-backend-token` */
export function resolvePiBackendTokenPath(rootDir: string): string {
  return join(rootDir, PI_BACKEND_TOKEN_FILENAME)
}

/** `<builtinStudioDir>/skills/` —— 与 resolveSkillsDir 同构：内置 studio
 *  资产下的 skills/ 子路径（layer-splitting 等内置 skill 落点）。入参即
 *  readStudioBuiltinDir() 的产物（env.ts:221）；与 resolveSkillsDir(rootDir)
 *  构成 additionalSkillPaths 的双源。 */
export function resolveBuiltinSkillsDir(builtinStudioDir: string): string {
  return join(builtinStudioDir, SKILLS_SUBDIR)
}

/** `rootDir/image-gen-output/` —— generate_image 「图片本地留存」目录（owner 拍板）；
 *  本地副本与画布 IMAGE fill 是同一份 bytes（透明背景后处理之后）。 */
export const IMAGE_GEN_OUTPUT_SUBDIR = 'image-gen-output'

/** `rootDir/image-gen-output/` */
export function resolveImageGenOutputDir(rootDir: string): string {
  return join(rootDir, IMAGE_GEN_OUTPUT_SUBDIR)
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
 * userDir 随 rootDir 走（= `<状态根>/studio`）；内置只读 + 用户可写同 id
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
