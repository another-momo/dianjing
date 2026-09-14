/**
 * T43/T87/S3 §4/S3 §5 pi 后端路径解析单点化层。
 *
 * C3 目标：把状态根 / .openpencil 子目录名 / studio 资产目录对的解析收口成
 * 纯函数 resolver。原位散点拼接（rootDir + '.openpencil' + 'pi-agent'、host.ts
 * 的隐式 cwd 契约等）逐字搬迁过来，行为/字符串零变化。
 *
 * 行为纪律（搬迁 = 纯重构）：
 *  - 子目录名（`pi-agent` / `pi-sessions` / `key-env` / `skills` / `studio` /
 *    `pi-backend-token` / `pi-sessions-archive`）单源——搬家时只动本文件
 *  - `OPENPENCIL_ROOT_DIR || process.cwd()` 语义保留（host.ts 隐式 cwd 契约）
 *  - studio 双源（builtinDir / userDir）解析语义保留，env override 语义保留
 *  - 资产两层语义（内置只读 + 用户可写、_ 前缀跳过、seed 失败仅 warn）一行不动
 *
 * 与 env.ts 的关系：本文件不直接读 env——env 由调用方解析后传入。env.ts 的
 * readRootDir / readStudioBuiltinDir 是推荐入口，但 paths.ts 函数签名只
 * 接受字符串，便于测试注入 fixture。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

// ── 状态根目录 ──

/**
 * 状态根目录解析（rootDir）——单源。
 *
 * 原位散点：
 *  - pi-backend/main.ts:39：`process.env.OPENPENCIL_ROOT_DIR || process.cwd()`
 *  - pi-backend/host.ts:43：`const rootDir = process.cwd()`（隐式约定，serve
 *    从仓根跑，cwd 即仓库根）
 *  - desktop-electron/main/main.ts:692：`process.env.OPENPENCIL_ROOT_DIR || app.getPath('userData')`
 *  - bridge/server/root.ts:9：`(runtimePlatform === 'win32' ? homedir() : process.cwd())`
 *
 * 本函数仅承担「env override + cwd 兜底」段（pi-backend 语义）；host.ts 的
 * 隐式 cwd 契约与 Electron 的 userData 兜底各自保留在原位——本函数不覆盖
 * 它们（注入模型差异即规格）。
 *
 * env override 缺省走 process.cwd()——原位 main.ts:39 同款。
 */
export function resolveRootDir(envRoot: string | null): string {
  return envRoot ?? process.cwd()
}

/**
 * 状态根目录（host.ts 形态）——隐式 cwd 契约，env 不读。
 * 与 resolveRootDir 分两个函数保留两套语义，避免顺手统一。
 */
export function resolveHostRootDir(): string {
  return process.cwd()
}

/**
 * 状态根目录（Electron 形态）——env 优先，回退 app.getPath('userData')。
 * 此处接受 caller-resolved fallback；Electron main 内联 `'userData'` 字符串
 * 不暴露给本模块（path-resolver 与 electron API 解耦）。
 */
export function resolveElectronRootDir(envRoot: string | null, userData: string): string {
  return envRoot ?? userData
}

// ── .openpencil 子目录名常量（单源）──

/** 顶层状态目录名——14 处 `.openpencil` 字面量汇总。 */
export const STATE_DIR_NAME = '.openpencil'

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

/** studio 用户扩展目录子路径（与 BUILTIN_STUDIO_SUBPATH 对偶） */
export const USER_STUDIO_SUBPATH = join(STATE_DIR_NAME, 'studio')

/** studio 内置资产目录相对仓库根的子路径（dev/wt 形态；打包形态由 env 覆盖） */
export const BUILTIN_STUDIO_SUBPATH = join('src', 'app', 'ai', 'pi-backend', 'studio')

// ── stateDir 拼接 helper ──

/**
 * 拼接 rootDir + `.openpencil` 顶层状态目录。
 * 原位 `join(rootDir, '.openpencil')` 字面量 14 处统一收口。
 */
export function resolveStateDir(rootDir: string): string {
  return join(rootDir, STATE_DIR_NAME)
}

/** `.openpencil/pi-agent/` */
export function resolveAgentDir(rootDir: string): string {
  return join(rootDir, STATE_DIR_NAME, PI_AGENT_SUBDIR)
}

/** `.openpencil/pi-sessions/` */
export function resolveSessionsDir(rootDir: string): string {
  return join(rootDir, STATE_DIR_NAME, PI_SESSIONS_SUBDIR)
}

/** `.openpencil/pi-sessions-archive/` */
export function resolveArchiveDir(rootDir: string): string {
  return join(rootDir, STATE_DIR_NAME, PI_SESSIONS_ARCHIVE_SUBDIR)
}

/** `rootDir/.openpencil/key-env` */
export function resolveKeyEnvPath(rootDir: string): string {
  return join(rootDir, STATE_DIR_NAME, KEY_ENV_FILENAME)
}

/** `.openpencil/skills/` */
export function resolveSkillsDir(rootDir: string): string {
  return join(rootDir, STATE_DIR_NAME, SKILLS_SUBDIR)
}

/** `rootDir/.openpencil/pi-backend-token` */
export function resolvePiBackendTokenPath(rootDir: string): string {
  return join(rootDir, STATE_DIR_NAME, PI_BACKEND_TOKEN_FILENAME)
}

// ── studio 双源 resolver ──

/**
 * studio 双源解析（builtin + user）——单源。
 *
 * 原位两处（pi-backend/service.ts:173-175 / studio/registry.ts:399-401）：
 *  - builtinDir：`OPENPENCIL_STUDIO_BUILTIN_DIR || join(rootDir, 内置子路径)`
 *  - userDir：`join(homedir(), '.openpencil', 'studio')`
 *
 * 两处拼接语义一致——registry.ts 注释明示「路径与 service.ts defaultDirs
 * 同源——保持两者对齐」。本函数把同源契约机器化，调用方各自调一次即可。
 *
 * 资产两层语义（内置只读 + 用户可写、同 id 覆盖、_ 前缀跳过、seed 失败
 * 仅 warn）由 registry / seed / service 各层承担，本函数不掺行为。
 */
export interface StudioDirs {
  builtinDir: string
  userDir: string
}

export function resolveStudioDirs(rootDir: string, envBuiltinOverride: string | null): StudioDirs {
  return {
    builtinDir: envBuiltinOverride ?? join(rootDir, BUILTIN_STUDIO_SUBPATH),
    userDir: join(homedir(), USER_STUDIO_SUBPATH)
  }
}
