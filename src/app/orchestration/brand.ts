/**
 * 品牌常量单一真源（改名期 ①）。
 *
 * 改名期工作流：本期（①）建立本文件作为品牌常量唯一真源并把既有字面量接线
 * 过来——所有值保持现名（openpencil 系）逐字不变。翻转期（②）改本文件即
 * 完成 TS 面 rebrand（值全部改写为「点睛/Dianjing」对应字面量即可）。
 *
 * 行为纪律（①搬迁 = 纯重构）：
 *  - 零 import、纯字符串字面量、`as const` 保字面量类型
 *  - 所有值与原位字面量逐字一致（rename 不在此层发生）
 *  - 浏览器安全：runtime-globals 等下游可放心 import，不污染打包链
 *
 * 非 TS 镜像触点清单（=②翻转时需同步处理的非 .ts 文件，本期不动）：
 *  - electron-builder.yml（appId / productName / copyright）
 *  - package.json#name
 *  - index.html `<title>`
 *  - desktop-electron/nsis/include.nsh（.openpencil 路径）
 *  - desktop-electron/smoke/*.ts
 */

// ── 产品面常量 ──

/** 产品面显示名（启动横幅、窗口标题、帮助文案等）。 */
export const PRODUCT_NAME_DISPLAY = 'OpenPencil'

/** 平台 app 标识（macOS Bundle ID / Windows AppUserModelID 等）。 */
export const APP_ID = 'com.openpencil.app'

// ── 文件系统常量 ──

/** 顶层状态目录名（`.openpencil`）——14 处字面量汇总，原位 src/app/ai/pi-backend/paths.ts:65。 */
export const STATE_DIR_NAME = '.openpencil'

/** Unix 平台 socket/discovery 目录短名（不带 `.` 前缀），原位 src/app/bridge/server/paths.ts:33。 */
export const BRIDGE_DIR_NAME_UNIX = 'openpencil'

/** macOS/Windows 平台桥目录显示名（首字母大写形态，两平台共享），原位 src/app/bridge/server/paths.ts:37。 */
export const BRIDGE_DIR_NAME_DESKTOP = 'OpenPencil'

// ── 进程内 / tmpdir 常量 ──

/** dev MCP discovery tmpdir 子目录前缀，原位 src/app/orchestration/discovery.ts:21。 */
export const DEV_MCP_TMP_PREFIX = 'open-pencil-mcp'

/**
 * 子进程 ready marker 前缀——父进程按此前缀 + UUID 判定子进程就绪。
 * 原位 src/app/orchestration/lifecycle.ts:87 + src/app/bridge/server/index.ts:72 正则。
 */
export const READY_MARKER_PREFIX = 'open-pencil-ready:'

// ── 环境变量名常量 ──

/** 编排层 env reader 的 env 名前缀——所有 `OPENPENCIL_*` 共享。 */
export const ENV_PREFIX = 'OPENPENCIL_'

/**
 * 浏览器侧运行时全局名（window.__OPENPENCIL_*）前缀。
 * 派生方式：`${RUNTIME_GLOBAL_PREFIX}<NAME>__`（保字面量类型 + 翻转期只改本前缀）。
 */
export const RUNTIME_GLOBAL_PREFIX = '__OPENPENCIL_'
