---
id: longform-structure-first
label: 长图设计（骨架先行）
subtitle: 多分区长图 / 内容驱动 / 骨架先行于主视觉合成
step_budget: 75
sizes:
  - label: 电商详情长图
    canvas: 750x
  - label: 社媒长图
    canvas: 1080x
references:
  - path: references/hero-prompt-template-structure-first.md
    description: hero 生图 prompt 三段结构 + 变异纪律 + 回图诊断——阶段 3 写 prompt 前读；回图异常时再读
  - path: references/fix-playbook-structure-first.md
    description: polish 段诊断表（症状→检测→动作→升级条件）——阶段 4 polish 前读
---

## 执行总纲

六阶段：**阶段 0 需求接入 → 阶段 1 方向提案（CP1）→ 阶段 2 骨架渲染（CP2）→ 阶段 3 主视觉合成（CP3）→ 阶段 4 逐节填图 → 阶段 5 终审（CP4）**。

通用规则：

- **每节 render 必带 parent_id = 根框 id**，JSX 不写 id——不只骨架阶段，所有 render 调用都遵守。
- **CP 载体一律是 ask_user_question 表单**——每个 ══ CP ══ 节点到点必须调 ask_user_question 发结构化表单，一次调用批量提该 CP 的全部问题（方向/确认择取用 single_select，候选 nodeId 择优用 image_select，缺事实追问用 text），禁以纯文本提问替代、禁跳过。CP 表单不受工具描述「每 session 最多两个表单」的约束——本 workflow 的 CP 节点数即表单数。

## 阶段 0 · 需求接入

做：read_brief → 无则 create_brief（initial_content = 用户原话逐字转录）→ 新建意图确认后 setup_design({ modeId, profileId?, briefId, canvas? })。

不做：用户要求修改已有设计时直接编辑，不重新 setup_design；不替用户改 brief 内容区。

歧义：read_brief 返回 ambiguous 时列候选问清，不擅选。

## 阶段 1 · 方向提案（文本轮）

做：在 active profile（如有）的风格约束下产出内容大纲（分区章节序）+ 视觉方向（风格词/构图/色彩氛围）+ 标题与 CTA 文案稿。事实缺失在 CP1 追问，不编造。

不做：CP1 确认前不调生图工具。

══ CP1 · 文本表单 ══ 方向确认 + 标题锁定 + 缺事实追问。标题在此锁定，同时充当骨架占位与最终画面文字。锁定结果 append_brief_conclusion。

## 阶段 2 · 骨架渲染

做：按 CP1 大纲 render **完整骨架**——所有非图片内容（标题、正文、价格、日期、CTA、装饰元素）按 CP1 锁定文案全部填入，只有图片用占位框 → describe 修 error（warning 不阻塞）→ look 验结构。

**骨架必须包含完整内容，不能只建空架子**——如果骨架阶段只放占位文字，polish 阶段会被迫重写大量文案，背离 polish 阶段做自由改进的定位。

骨架结构：

- 根框：`flex="col"`（启用 auto-layout，子节点垂直排列）
- hero 槽：必须命名为 `HeroContent`，内含标题真文案/真字号/最终位置。以下属性 profile 有规定时按 profile，否则用兜底值：
  - 高度：兜底 = 画布宽度
  - 标题垂直位置：兜底在 hero 下部
  - 眉题：兜底无
  - fill：兜底为标题文字对比色（白字用深底、深字用浅底），确保 scaffold 参考图中标题可见
- 内容节：每节一个命名 Frame，按 CP1 大纲的分区序排列，**节内所有文字按 CP1 大纲填全**：
  - 节标题（真文案）
  - 正文段落（真文案，按 Section 模式库选定字号档）
  - 价格、日期、CTA 等结构化数据（按 brief 锁定值填）
  - 图片占位：命名 HeroImg / ProductImg 等，浅灰 fill——本阶段不填实图
  - 装饰元素（scrim / 分割线 / 装饰矩形）：按 Section 模式库布局

══ CP2 · 骨架确认 ══ 骨架结构 + 图片来源。骨架未确认不进阶段 3。

## 阶段 3 · 主视觉合成

本阶段生成 hero 图像并合成到背景层，同时自动采样 hero 主题色生成渐变满铺，让整张长图共享连续色彩基调。

执行步骤：

1. 先 look 自检骨架排版（hero 槽标题位置/字号/对比度、各节文字有无遮挡/溢出），发现问题先修再继续；确认无误后调用 prepare_hero_scaffold——在根框旁生成参考画框，把 HeroContent 槽内的标题按最终位置克隆进去，让生图 API 看到标题的位置标记（prompt 据此锚定标题区方位、保持该区平静、画面中不画字，模板见 reference）
2. 调用 generate_image——`replace_id` = scaffold_id，`references` 传 scaffold 节点作合成参照。prompt 按 `workflow:longform-structure-first/references/hero-prompt-template-structure-first.md` 三段结构编写（写前读）
3. 调用 compose_backdrop——hero 图移入背景层，同时自动从 hero 底部采样主题色，生成一条与之相符的渐变色满铺整个画布背景。hero 与下方内容节之间不再有硬边界，整张长图共享连续色彩基调
4. look 验收：hero 底部无可见接缝、标题区可读。不通过则重生 hero（重跑步骤 1→3）；重生 2 次仍不通过则换素材路线（stock_photo / 用户素材）；无素材可换时结论区声明待补

══ CP3 · 主视觉确认 ══ 用户确认 hero 方向后才进入阶段 4 填充——hero 不对，后面全白做。

## 阶段 4 · 逐节填图

做：按 CP2 确认的图片来源路由（AI 生成 / stock_photo / 用户素材），逐节填图 → describe 修 error → 下一节。**文字已在阶段 2 全部填好，本阶段不改文案**——只做图片替换 + 因图片调整后的容器尺寸/字位置遮挡修正。如发现文字本身有问题（与图片不协调 / 措辞待优化），记到 polish 段处理。

跨节一致性检查：每 3 节做一次 look 逐节对比——颜色是否统一、字号是否分档、间距节奏是否一致，不一致处批量修正。

图像 prompt 纪律：所有 AI 生图 prompt 附 hero 的风格词尾缀（从 CP3 锁定的方向词取），保证整张长图视觉统一。

══ polish 段 ══ 全节填完后：describe 全量审计 → look 分区钻取验收 → 按 `workflow:longform-structure-first/references/fix-playbook-structure-first.md` 逐项排查修复。polish 阶段允许调整所有内容（文案重写、布局重排、图片替换、字号/颜色/间距微调），不重发 CP——CP 是与用户确认的节点，polish 在已确认方向内做自由改进。

## 阶段 5 · 终审

══ CP4 · 终审确认 ══ 用户最终验收。通过后给用户 2-3 行 summary（画布尺寸、主色调、剩余问题）。

> Phase 5 不重复审计——polish 段已做完 describe 全量审计 + look 验收 + 修复。Phase 5 仅做终审确认 + summary 输出。

## Section 模式库

阶段 2 渲染骨架 + 阶段 4 填图时参考以下模式：

- **hero 默认版式**：Frame + flex col（justify end）覆盖文字子节点——背景填充在底层，文字自动浮于其上。槽节点命名为 `HeroContent`。
- **纯布局节**：一律 flex 排布，不用绝对定位。
- **卡片节**：图在上文字在下；价格卡用「现价大粗 + 原价小字划线」。
- 文字压在繁杂画面上（高密度细节、多焦点、色彩斑斓）的可读性三策（按强度递增）：
  1. **文字投影**：text 加 `shadow="0 2 8 #00000066"`——0/2/8 是 X/Y 偏移和模糊半径，`#00000066` 是 40% 不透明黑；让文字从画面浮起
  2. **scrim 暗垫**：文字块下放一个 `bg="#00000066"` 的全宽矩形，把该区域画面整体压暗——局部救场用
  3. **全图色调统一**：多张图色调冲突时，全幅盖一个 `blendMode="overlay"`（或 `"hue"`）的矩形，opacity 15–25%，把多图色相拉一致——大尺度救场用
- 字号：按 profile Typography 分档；无 profile 时按画布宽度分档（宽 ≥900 正文≥22/节标题≥40/hero≥64；宽 <900 正文≥20/节标题≥36/hero≥72；caption 均≥16）。

## 续作

**续作**：画布上已有内容时，先 read_brief + describe/look 看现状，然后询问用户是从已有内容继续还是重新开始。

其余修改（recolor / resize / 换图）→ 直接编辑既有节点，跳阶段，改完 describe 修尽 error 即可。
