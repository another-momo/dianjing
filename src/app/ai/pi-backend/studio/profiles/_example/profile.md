---
# 内置示例 profile 模板——以 `_` 前缀命名，registry 扫描时跳过不注册。
# 用途：用户首次启动时由 seed.ts 复制到 `~/.openpencil/studio/profiles/_example/`
# 作为可改写的教学示例。
#
# frontmatter 字段说明（必填/可选+语义）：
#   id        (必填) 机读 id，必须与所在目录名一致（文件名恒为 profile.md）。
#                    合法字符：小写字母 / 数字 / 连字符 / 下划线（首字符须为
#                    字母或数字）。
#   label     (必填) 下拉/UI 显示名（中文/英文均可）。
#   modes     (可选) 该 profile 适用的 mode 列表。缺省 / 空数组 = 适用所有
#                    mode（无限制）。显式填写时，UI 下拉与 prompt 注入按此
#                    筛选。
#   version   (可选) 正整数。版本号，UI 可用以标记弃用/历史。
#   references(可选) 非空按需参考清单：[{path, description}]。
#                    path 为相对路径（相对该资产所在目录），扩展名限
#                    .md/.txt/.json/.yaml/.csv，禁 `..` / 绝对路径 / 盘符。
#
#                    注：声明层 path 是相对路径；AI 调 load_reference 时传的
#                    path 则是「按需参考」索引节行首 key（恒带桶前缀，如
#                    `profile:<id>/references/xxx.md`）。两层区分，不混写。
id: _example
label: 示例 profile
version: 1
# modes 与 references 示例（默认注释掉：modes 限定的 mode 必须真实存在；
# references 指向的文件必须真实创建，否则加载会因校验/解析失败报错）：
# modes:
#   - longform-hero-kv-first
# references:
#   - path: references/notes.md
#     description: 示例参考——写清内容是什么、何时该读
---

## 这是什么

`profile.md` 描述一个**风格画像**——一组按设计要素组织的视觉/语气纪律。
workflow 决定「做什么、按什么顺序」，profile 决定「长什么样、语气如何」。

profile 全文注入 systemPrompt（每回合组装），对 AI 行为有持续影响力。

## 设计要素六节骨架

按这六个节组织你的纪律即可——节标题是给 AI 阅读的语义锚点，不必与 UI
强对应（节结构不锁定）：

### Typography

一句引导语：本节约束字阶（与 workflow canvas 宽度联动）、字重、标题节奏、
阴影规则等。本模板留空让你按需补全。

### Color

一句引导语：本节约束调色板来源（如 hero 物化后采样）、和声规则
（analogous / complementary / split-complementary / triadic / monochromatic）、
明度纪律。

### Layout

一句引导语：本节约束分区间距节奏、共享背景层规则、文本密集段的辅助手法。

### Hero treatment

一句引导语：本节约束 hero 锁位（lower-third / center-left / upper-float）、
hero 高度范围、scaffold 参数（underlap_px / transition_zone_px）、标题落位纪律。

### Forbidden

一句引导语：本节显式列出禁项（如不允许的 scrim / 不允许的色块切法 /
不允许的标题版式 / 不允许的硬卖措辞 / 不允许的透明度调整救场）。

### Tone

一句引导语：本节约束整体语气（如「克制、氛围优先」「名词短语 + 意象」）
与文案长度纪律。

## 何时被加载

- 每次 AI 回合开始：当前 active design 关联的 profile 全文注入 systemPrompt；
- manifest 投影到前端，下拉选择器（按 modes 过滤，缺省不过滤）与
  failures 数据面从这里取；
- `id = _` 前缀的模板永不被注册（registry 跳过），仅作复制源。

## 修改建议

1. 复制此文件到 `~/.openpencil/studio/profiles/<你的 id>/profile.md`；
2. 改 `id` 与 `label`（且 `id` 必须等于所在目录名）；
3. 按你的设计纪律补全六节正文（节标题可改可删——只要语义让 AI 能读懂）；
4. 需要按需参考文档就加 `references`；
5. 需要限定适用 mode 就把 `modes` 改成具体 id 列表；想做全 mode 通用的
   profile 就把整个 `modes` 字段删除（或写成空数组 `[]`）。
