/**
 * 品牌常量单一真源（改名期 ①建源 + ②翻转 + ③D2 收口）。
 *
 * 改名期工作流：①建立本文件作为品牌常量唯一真源并把既有字面量接线过来——所有
 * 值保持现名（openpencil 系）逐字不变；②改本文件完成 TS 面 rebrand（值已
 * 全部改写为「点睛/Dianjing」对应字面量）；③D2 收口：删除 STATE_DIR_NAME /
 * BRIDGE_DIR_NAME_DESKTOP（双层嵌套 + 三处根不统一已消亡，状态根统一进 OS
 * 标准应用数据目录由 orchestration/app-data 的 resolveAppDataRoot 单源承担）。
 *
 * 行为纪律（①搬迁 = 纯重构）：
 *  - 零 import、纯字符串字面量、`as const` 保字面量类型
 *  - 浏览器安全：runtime-globals 等下游可放心 import，不污染打包链
 *
 * 非 TS 镜像触点清单（=②翻转时需同步处理的非 .ts 文件）：
 *  - electron-builder.yml（appId / productName / copyright）
 *  - package.json#name
 *  - index.html `<title>`
 *  - desktop-electron/smoke/*.ts
 */

// ── 产品面常量 ──

/** 产品面显示名（启动横幅、窗口标题、帮助文案等）。 */
export const PRODUCT_NAME_DISPLAY = '点睛设计'

/** 平台 app 标识（macOS Bundle ID / Windows AppUserModelID 等）。 */
export const APP_ID = 'com.dianjing.app'

// ── 文件系统常量 ──

/** Unix 平台 socket 短名（不带 `.` 前缀，仅用于 $XDG_RUNTIME_DIR/dianjing/mcp.sock 临时目录段）。 */
export const BRIDGE_DIR_NAME_UNIX = 'dianjing'

/**
 * Electron userData 目录名（app.setName 参数）——Windows %APPDATA%/Dianjing、
 * macOS ~/Library/Application Support/Dianjing；与 electron-builder productName
 * 对齐（打包形态缺省即取 productName，setName 把 dev 形态钉到同一名）。
 *
 * D2 起：作为「OS 标准应用数据目录下的产品子目录」唯一真源，被
 * orchestration/app-data 的 resolveAppDataRoot 单源消费，桥 discovery 与
 * pi-backend 状态根都走它（不再散点拼字面量）。
 */
export const USER_DATA_DIR_NAME = 'Dianjing'

// ── 进程内 / tmpdir 常量 ──

/** dev bridge discovery tmpdir 子目录前缀，原位 src/app/orchestration/discovery.ts:21。 */
export const DEV_BRIDGE_TMP_PREFIX = 'dianjing-bridge'

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
