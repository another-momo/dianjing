---
# 内置示例 workflow 模板——以 `_` 前缀命名，registry 扫描时跳过不注册。
# 用途：用户首次启动时由 seed.ts 复制到 `~/.openpencil/studio/workflows/_example/`
# 作为可改写的教学示例。
#
# frontmatter 字段说明（必填/可选+语义）：
#   id        (必填) 机读 id，必须与所在目录名一致（文件名恒为 workflow.md）。
#                    合法字符：小写字母 / 数字 / 连字符 / 下划线（首字符须为
#                    字母或数字）。
#   label     (必填) 下拉/UI 显示名（中文/英文均可）。
#   subtitle  (可选) 模式一句话说明，UI 副标题位。
#   step_budget
#             (可选) 正整数。该模式一轮 AI 推理内允许的最大工具调用步数；超限
#                    触发「resume 协议」收尾。不写则不强制上限。
#   sizes     (可选) 非空预设清单：[{label, canvas}]，label = 中文名，
#                    canvas = `宽x`（高度随内容）或 `宽x高`（定高）。
#   references(可选) 非空按需参考清单：[{path, description}]——AI 仅在显式调用
#                    load_reference 时按需加载（不进入 prompt 正文）。
#                    path 为相对路径（相对该资产所在目录），扩展名限
#                    .md/.txt/.json/.yaml/.csv，禁 `..` / 绝对路径 / 盘符。
#
#                    注：声明层 path 是相对路径；AI 调 load_reference 时传的
#                    path 则是「按需参考」索引节行首 key（恒带桶前缀，如
#                    `workflow:<id>/references/xxx.md`）。两层区分，不混写。
id: _example
label: 示例 workflow
subtitle: 教学示例——复制此文件改写即可获得自定义 mode
step_budget: 30
sizes:
  - label: 通用画布
    canvas: 800x
# references 示例（默认注释掉：本模板不附带 references/ 目录，启用前请先创建
# 对应文件，否则加载会因解析失败报错）：
# references:
#   - path: references/notes.md
#     description: 示例参考——写清内容是什么、何时该读
---

## 这是什么

`workflow.md` 描述一个**设计 mode**（如「长图设计」「KV 主视觉优先」），是 AI
每回合推理必须遵循的执行总纲。它约束：

- 阶段序列（如 hero-first 五阶段：需求接入 → 方向提案 → hero 物化 → 结构与填充 → 终审）
- 每个阶段的「做 / 不做」边界
- 阶段间的 Checkpoint 表单纪律
- step_budget 与 resume 协议

正文用 markdown 节即可，节标题是给 AI 阅读的语义锚点，不必与 UI 强对应。

## 何时被加载

- 每次 AI 回合开始（before_agent_start）：当前 active design 的 mode 对应
  workflow 文件全文注入 systemPrompt；
- manifest 投影到前端，下拉选择器与 failures 数据面从这里取；
- `id = _` 前缀的模板永不被注册（registry 跳过），仅作复制源。

## 修改建议

1. 复制此文件到 `~/.openpencil/studio/workflows/<你的 id>/workflow.md`；
2. 改 `id` 与 `label`（且 `id` 必须等于所在目录名）；
3. 按你的执行流改写正文节——节标题、阶段序、Checkpoint 节奏都由你定；
4. 需要尺寸预设就改 `sizes`；需要按需参考文档就加 `references`。
