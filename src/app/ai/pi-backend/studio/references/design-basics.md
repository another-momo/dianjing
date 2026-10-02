# 通用设计基础

> base.md 的按需参考——搭建类设计任务（海报、长图文、卡片、UI 排版）且未注入 style profile 时，开工前经 `load_reference` 读取本文。
> 本文是通用设计的知识手册（设计令牌 / 版式 pattern / 组合手法），不规定流程程序——工作节奏按任务自定版式、方向与配色，逐节搭建、describe 修尽错误、终审交付。

## 设计令牌（无 profile 兜底）

profile 有规定时按 profile，否则用本节默认值。

### Typography

6–8 个字号档自定一套，跨节一致使用：Display 32–40、H1 24–28、H2 20–22、H3 17–18、Body 14–15、Caption 12–13、Overline 10–11。2–3 个字重上限。Hierarchy 通过 size / weight / color 单一变量分档，不混合。

中文字体默认 `Alibaba PuHuiTi`（bundled，覆盖 简体/繁體/拉丁），纯拉丁段可用 Inter；可用字重 Thin / Light / Regular / Medium / SemiBold / Bold / ExtraBold / Heavy / Black，Heavy / Black 谨慎用于 Display/装饰。同设计内不混字族——选一套贯彻到底。

配色：浅底主文 #111827 / 次文 #6B7280 / 辅文 #9CA3AF；深底白 #FFFFFF / #FFFFFF99 / #FFFFFF66。

### Spacing

4px 网格取：4 / 8 / 12 / 16 / 20 / 24 / 32 / 48。组内 < 组间 < 节间；同容器 padding ≥ gap；垂直 padding > 水平（同等值时补：`py={10} px={20}`）。同元素类型跨节保持一致。

### Radius

内嵌圆角 = 外层圆角 − padding（如卡片 `rounded={20} p={12}` → 子元素 `rounded={8}`）。参考：卡片 16–24、按钮 8–12、Chip 4–8、Pill = 高度/2。

## 版式 pattern

- **卡片网格**：flex="row" wrap 网格里每卡 `grow={1}`，禁用固定 `w={N}`；卡内图与标题 Text 用 `w="fill"` 保证换行。
- **分隔线**：`flex="col"` 用 `<Rectangle w="fill" h={1} bg="#E2E8F0" />`，`flex="row"` 用 `w={1} h="fill"`。禁在容器上用 `stroke`——stroke 画全边框不是单分隔。
- **固定高行**加 `maxLines={1}`；wrap 布局算列数：`columns = floor((available + gap) / (child_w + gap))`。
- **busy 图上压字**：给 `shadow="0 2 8 #00000066"`，或文字块后垫深色 scrim 矩形。
