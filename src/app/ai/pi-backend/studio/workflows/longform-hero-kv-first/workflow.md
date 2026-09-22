---
id: longform-hero-kv-first
label: 长图设计（hero 主视觉先行）
subtitle: KV 主图 / 电商详情 / 适配 hero 视觉权重的分区物料
step_budget: 70
sizes:
  - label: 电商详情长图
    canvas: 750x
  - label: 社媒长图
    canvas: 1080x
references:
  - path: references/hero-prompt-template-kv-first.md
    description: hero 候选生图 prompt 三段模板 + 变异纪律 + 回图诊断——阶段 2 写候选 prompt 前读；回图异常时再读
  - path: references/fix-playbook-kv-first.md
    description: polish 段诊断表（症状→检测→动作→升级条件）——阶段 3 polish 前读
---

## 执行总纲

五阶段，**hero 先于结构**：

**阶段 0 需求接入 → 阶段 1 方向提案（CP1）→ 阶段 2 hero 物化（CP2）→ 阶段 3 结构与填充（CP3，polish 独立成段）→ 阶段 4 终审（CP4）**。

设计哲学：hero 图（主视觉 / KV）是设计的主导元素——先生成 hero 看视觉权重（高度 / 色彩 / 明度 / 节奏），结构再围绕 hero 适配。与"骨架先行"相反：骨架先行先建框架再生成 hero 填入；hero 先行先生成 hero 再围绕 hero 搭结构。

通用规则：

- **每节 render 必带 parent_id = 根框 id**，JSX 不写 id——所有 render 调用都遵守。
- **CP 载体一律是 ask_user_question 表单**——每个 ══ CP ══ 节点到点必须调 ask_user_question 发结构化表单，一次调用批量提该 CP 的全部问题（方向/确认择取用 single_select，候选 nodeId 择优用 image_select，缺事实追问用 text），禁以纯文本提问替代、禁跳过。CP 表单不受工具描述「每 session 最多两个表单」的约束——本 workflow 的 CP 节点数即表单数。

## 阶段 0 · 需求接入

做：read_brief → 无则 create_brief（initial_content = 用户原话逐字转录）→ 新建意图确认后 setup_design({ modeId, profileId?, briefId, canvas? })。

不做：用户要求修改已有设计时直接编辑，不重新 setup_design；不替用户改 brief 内容区。

歧义：read_brief 返回 ambiguous 时列候选问清，不擅选。

## 阶段 1 · 方向提案（文本轮）

做：在 active profile（如有）的风格约束下产出内容大纲（分区章节序）+ 视觉方向（风格词/构图/色彩氛围）+ 标题与 CTA 文案稿。事实缺失在 CP1 追问，不编造。

不做：CP1 确认前不调生图工具。

══ CP1 · 文本表单 ══ 方向确认 + 标题锁定 + 缺事实追问。标题在此锁定，同时充当阶段 2 生图参照与最终画面文字。锁定结果 append_brief_conclusion。

## 阶段 2 · hero 物化（图像轮）

做：把锁定的标题按 CP1 方向先 render 进 HeroContent 槽（真文案、真字号、最终位置）→ look 自检 hero 槽排版（标题位置/字号/对比度、有无遮挡/溢出，有问题修完再走）→ prepare_hero_scaffold（克隆标题版式为页面级参考帧）→ generate_image 候选 ×2~~3（默认 2~~3，参考用 scaffold）。每候选落独立节点；references 用 scaffold 时 prompt 必须明写参照用法（围绕标题构图 + 标题区平静低细节 + 画面中不画任何文字）。写候选 prompt 前 load_reference 读 `workflow:longform-hero-kv-first/references/hero-prompt-template-kv-first.md`（三段模板 + 变异纪律 + 回图诊断）。

候选纪律：单变量受控变异——一批内只动一个变量轴（构图 / 氛围 / 题材择一）。用户整批拒绝 = 合法请求；整批重生 ×2 仍未选中则停止重生，回 CP1 改方向后重提。

profile 协同（阶段 2）：以下属性 profile 有规定时按 profile，否则用兜底值：

- HeroContent 版式：profile `Hero treatment → hero lockup`，兜底 `lower-third`
- Hero 高度：profile `Hero treatment → hero height`，兜底 `W`
- Hero 槽 fill：profile 有规定按 profile，否则兜底为标题文字对比色（白字用深底、深字用浅底），确保 scaffold 参考图中标题可见
- hero 生图风格词：profile `Hero treatment` 对应风格节，兜底 agent 按 CP1 锁定方向自拟 + 写一行结论区备查

══ CP2 · 主视觉确认 ══ image_select 候选 nodeId 择优 + 图片来源确认（AI 生成 / stock_photo / 用户素材——顺带确认后续节次用图来源）。

不做：不铺超过 3 个候选；不在 CP2 前 compose_backdrop。

## 阶段 3 · 结构与填充

**本阶段是 hero-kv-first 的核心差异**：hero 已选 → 看 hero 的实际视觉权重（高度 / 色彩 / 明度 / 节奏）→ 渲染完整骨架（按结构适配 hero 的比例 + 字阶）→ CP3 确认 → compose_backdrop 合成 → 逐节填图 → polish。

**骨架必须包含完整内容**——所有非图片内容（标题、正文、价格、日期、CTA、装饰元素）按 CP1 锁定文案全部填入，只有图片用占位框。这才是 hero 先行的价值：骨架阶段已经知道 hero 的实际视觉，可以精准适配。如果骨架只放占位文字，polish 阶段会被迫重写大量文案，背离 polish 阶段做自由改进的定位。

骨架结构：

- 根框：`flex="col"`（启用 auto-layout，子节点垂直排列）
- hero 槽：命名为 `HeroContent`；hero 已从 CP2 候选落入槽内，本阶段只做位置微调
- 内容节：每节一个命名 Frame，比例按 hero 实际权重定，**节内所有文字按 CP1 大纲填全**：
  - 节标题（真文案）
  - 正文段落（真文案，按 Section 模式库选定字号档）
  - 价格、日期、CTA 等结构化数据（按 brief 锁定值填）
  - 图片占位：命名 HeroImg / ProductImg 等，浅灰 fill——本阶段不填实图
  - 装饰元素（scrim / 分割线 / 装饰矩形）：按 Section 模式库布局

profile 协同（阶段 3）：以下属性 profile 有规定时按 profile，否则用兜底值：

- 眉题：profile `Typography → eyebrow`，兜底无
- 字阶：profile `Typography` 节，兜底见 Section 模式库字号分档

══ CP3 · 骨架确认 ══ 骨架结构确认。骨架未确认不进填充。

骨架确认 → compose_backdrop(hero_image_from = 当选候选)——幂等采纳。

逐节填图循环：按 CP2 确认的图片来源路由（AI 生成 / stock_photo / 用户素材），逐节填图 → describe 修 error → 下一节。**文字已在骨架阶段全部填好，本阶段不改文案**——只做图片替换 + 因图片调整后的容器尺寸/字位置遮挡修正。如发现文字本身有问题（与图片不协调 / 措辞待优化），记到 polish 段处理。

跨节一致性检查：每 3 节做一次 look 逐节对比——颜色是否统一、字号是否分档、间距节奏是否一致，不一致处批量修正。

图像 prompt 纪律：所有 AI 生图 prompt 附 hero 的风格词尾缀（从 CP2 锁定的方向词取），保证整张长图视觉统一。

══ polish 段 ══ 全节填完后：describe 全量审计 → look 分区钻取验收 → 按 `workflow:longform-hero-kv-first/references/fix-playbook-kv-first.md` 逐项排查修复。polish 阶段允许调整所有内容（文案重写、布局重排、图片替换、字号/颜色/间距微调），不重发 CP——CP 是与用户确认的节点，polish 在已确认方向内做自由改进。

不做：不在 CP3 确认前填充内容；profile 的 Hero treatment 节另有规定时以 profile 为准。

## 阶段 4 · 终审

══ CP4 · 终审确认 ══ 用户最终验收。通过后给用户 2-3 行 summary（画布尺寸、主色调、剩余问题）。

> Phase 4 不重复审计——polish 段已做完 describe 全量审计 + look 验收 + 修复。Phase 4 仅做终审确认 + summary 输出。

## Section 模式库

阶段 2 渲染 hero 槽 + 阶段 3 渲染骨架时参考以下模式：

- **hero 默认版式**：Frame + flex col（justify end）覆盖文字子节点——背景填充（图/色）在底层，文字自动浮于其上，即「图上压字」的标准结构。槽节点命名为 `HeroContent`。
- **纯布局节**：一律 flex 排布，不用绝对定位——后续内容增删不伤版式。
- **卡片节**：图在上文字在下；价格卡用「现价大粗 + 原价小字划线」对照。
- 文字压在繁杂画面上（高密度细节、多焦点、色彩斑斓）的可读性三策（按强度递增）：
  1. **文字投影**：text 加 `shadow="0 2 8 #00000066"`——0/2/8 是 X/Y 偏移和模糊半径，`#00000066` 是 40% 不透明黑；让文字从画面浮起
  2. **scrim 暗垫**：文字块下放一个 `bg="#00000066"` 的全宽矩形，把该区域画面整体压暗——局部救场用
  3. **全图色调统一**：多张图色调冲突时，全幅盖一个 `blendMode="overlay"`（或 `"hue"`）的矩形，opacity 15–25%，把多图色相拉一致——大尺度救场用
- 字号：按 profile Typography 分档；无 profile 时按画布宽度分档（宽 ≥900 正文≥22 / 节标题≥40 / hero 主标题≥64；宽 <900 正文≥20 / 节标题≥36 / hero 主标题≥72；caption 均≥16）。

## 续作

**续作**：画布上已有内容时，先 read_brief + describe/look 看现状，然后询问用户是从已有内容继续还是重新开始。

其余修改（recolor / resize / 换图）→ 直接编辑既有节点，跳阶段，改完 describe 修尽 error 即可。
