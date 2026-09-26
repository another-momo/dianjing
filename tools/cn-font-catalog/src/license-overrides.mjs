/**
 * 目录 license 一手核覆盖表（2026-09-26 owner 拍板逐包核实）。
 *
 * 为什么存在：cn-catalog.ts 的 license 字段缺省取 npm 包内 license 原文——中文网字
 * 计划的包装层大量统一标 `MIT © KonghaYao`（打包作者的再分发声明），不替换上游字体
 * 授权。本表登记上游仓 LICENSE 文件本体一手核查后的真值，构建（build.mjs）与现役文件
 * 纠正（apply-license-overrides.mjs）共用同一份真源。
 *
 * 条目格式：'@chinese-fonts/<包>' → '<license 标签>'，注释带证据（上游仓 + 核查日期）。
 * 晋升精选的包由 REGISTRY_PACKAGES 过滤离目录，其覆盖条目须同批删除（防死键）。
 */
export const LICENSE_OVERRIDES = new Map([
  // 2026-09-26 授权审计批回填（证据：上游仓 LICENSE 一手核，见条目注释）
  // 上游 GuiWonder/XiaoheSimplifyFonts 仓 LICENSE.txt 原文即 SIL OFL-1.1（2026-09-26 一手核）；
  // npm 包装层 package.json 标 MIT 系打包作者再分发声明，不替换上游授权
  ['@chinese-fonts/xiaohe-simplify', 'OFL-1.1']
])
