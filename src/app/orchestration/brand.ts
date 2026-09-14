/**
 * 品牌常量单一真源（改名期 ①建源 + ②翻转）。
 *
 * 改名期工作流：①建立本文件作为品牌常量唯一真源并把既有字面量接线过来——所有
 * 值保持现名（openpencil 系）逐字不变；②改本文件完成 TS 面 rebrand（值已
 * 全部改写为「点睛/Dianjing」对应字面量）。后续非 TS 镜像触点见下。
 *
 * 行为纪律（①搬迁 = 纯重构）：
 *  - 零 import、纯字符串字面量、`as const` 保字面量类型
 *  - 浏览器安全：runtime-globals 等下游可放心 import，不污染打包链
 *
 * 非 TS 镜像触点清单（=②翻转时需同步处理的非 .ts 文件）：
 *  - electron-builder.yml（appId / productName / copyright）
 *  - package.json#name
 *  - index.html `<title>`
 *  - desktop-electron/nsis/include.nsh（.dianjing 路径）
 *  - desktop-electron/smoke/*.ts
 */

// ── 产品面常量 ──

/** 产品面显示名（启动横幅、窗口标题、帮助文案等）。 */
export const PRODUCT_NAME_DISPLAY = '点睛设计'

/** 平台 app 标识（macOS Bundle ID / Windows AppUserModelID 等）。 */
export const APP_ID = 'com.dianjing.app'

// ── 文件系统常量 ──

/** 顶层状态目录名（`.dianjing`）——14 处字面量汇总，原位 src/app/ai/pi-backend/paths.ts:65。 */
export const STATE_DIR_NAME = '.dianjing'

/** Unix 平台 socket/discovery 目录短名（不带 `.` 前缀），原位 src/app/bridge/server/paths.ts:33。 */
export const BRIDGE_DIR_NAME_UNIX = 'dianjing'

/** macOS/Windows 平台桥目录显示名（首字母大写形态，两平台共享），原位 src/app/bridge/server/paths.ts:37。 */
export const BRIDGE_DIR_NAME_DESKTOP = 'Dianjing'

/**
 * Electron userData 目录名（app.setName 参数）——Windows %APPDATA%/Dianjing、
 * macOS ~/Library/Application Support/Dianjing；与 electron-builder productName
 * 对齐（打包形态缺省即取 productName，setName 把 dev 形态钉到同一名）。
 */
export const USER_DATA_DIR_NAME = 'Dianjing'

// ── 进程内 / tmpdir 常量 ──

/** dev MCP discovery tmpdir 子目录前缀，原位 src/app/orchestration/discovery.ts:21。 */
export const DEV_MCP_TMP_PREFIX = 'dianjing-mcp'

/**
 * 子进程 ready marker 前缀——父进程按此前缀 + UUID 判定子进程就绪。
 * 原位 src/app/orchestration/lifecycle.ts:87 + src/app/bridge/server/index.ts:72 正则。
 */
export const READY_MARKER_PREFIX = 'dianjing-ready:'

// ── 环境变量名常量 ──

/** 编排层 env reader 的 env 名前缀——所有 `DIANJING_*` 共享。 */
export const ENV_PREFIX = 'DIANJING_'

/**
 * 浏览器侧运行时全局名（window.__DIANJING_*）前缀。
 * 派生方式：`${RUNTIME_GLOBAL_PREFIX}<NAME>__`（保字面量类型 + 翻转期只改本前缀）。
 */
export const RUNTIME_GLOBAL_PREFIX = '__DIANJING_'
