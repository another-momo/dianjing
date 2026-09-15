---
id: general
label: 通用设计
subtitle: 无专项 workflow 时的默认设计流程——完整项目最小闭环
step_budget: 50
sizes:
  - label: 通用画布
    canvas: 750x
  - label: 方形画布
    canvas: 1080x1080
---

## 适用范围

无专项 workflow 时走本节：自定版式、方向与配色，逐节物化、describe 修尽错误、终审交付。画布尺寸按上列预设自选或按用户语言自定义；未指定时走首选预设（清单首条）。

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

## Text wrapping（CRITICAL）

多行文本必须 `w="fill"`（非 `w={N}`）。flex="col" 卡片内的 Text 用 `w="fill"`——文本撑满卡片宽并自动换行，绕开字体度量差异。固定高行加 `maxLines={1}`。wrap 布局算列数：`columns = floor((available + gap) / (child_w + gap))`。

## 通用版式

- **装饰层**：背景特效（渐变、光晕、色块）用绝对 x/y 定位；仅内容进 flex。
- **`w={N}` 与 `grow={N}` 不混用**——grow 覆盖 width。
- **卡片网格**：flex="row" wrap 网格里每卡 `grow={1}`，禁用固定 `w={N}`；卡内图与标题 Text 用 `w="fill"` 保证换行。
- **分隔线**：flex="col" 用 `<Rectangle w="fill" h={1} bg="#E2E8F0" />`，flex="row"`用`w={1} h="fill"`。禁在容器上用 `stroke`——stroke 画全边框不是单分隔。

## 组合原语

render 的 JSX 内可直用 solid / linearGradient / radialGradient / angularGradient / diamondGradient / dropShadow / innerShadow / layerBlur / backgroundBlur / foregroundBlur。三坑：渐变必须显式 transform（缺省方向右→左）；渐隐用 8 位 hex 带 alpha（`#FFFFFF00` 全透明）；多 fill 数组按绘制序（首条 = 底层）。既有节点加/改阴影模糊用 set_effects，永不为此用 eval；修复一轮里效果最后加（阴影/模糊改包围盒、可能位移布局）。busy 图上压字给 `shadow="0 2 8 #00000066"` 或文字块后垫深色 scrim 矩形。

## 双图工具路由

`generate_image` = AI 生成/重绘；`stock_photo` = 真实摄影图库——按设计意图路由：抽象氛围/插画/产品渲染走 generate_image，真实摄影场景/人物/实物走 stock_photo；两工具的调用格式/批量/references/鉴权语义以各自工具描述为权威。

## 修改请求路由

修改请求（recolor / resize / copy edit / 换图）→ 直接编辑既有节点，按需调 set_fill / set_text / set_image_fill / node_resize 等局部工具，不重走流程——修改范围局部化，改完 describe 修尽 error 即可，无需重新确认方向。

## resume 协议

无回合状态落盘。续作现场 = 画布实物（最权威）。从画布现状继续：describe / look 看有什么 → 跟用户确认要续作哪部分 → 继续。中间可调 read_brief 取上下文（若有），不与画布争论。
