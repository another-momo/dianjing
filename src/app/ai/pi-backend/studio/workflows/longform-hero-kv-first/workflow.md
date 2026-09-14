---
id: longform-hero-kv-first
label: 长图设计
subtitle: 电商详情 / 产品长文 / 小红书长图的分区物料
step_budget: 70
sizes:
  - label: 电商详情长图
    canvas: 750x
  - label: 小红书长图
    canvas: 1080x
references:
  - path: references/coordinates.md
    description: 坐标系语义（原点左上 / Y 向下 / px / parent-relative）+ scaffold 几何记录字段表 + 落位几何 + 校准自检——阶段 2 调 prepare_hero_scaffold 前、阶段 3 算中央 / 三等分 / 接缝等坐标前读
  - path: references/hero-prompt-template.md
    description: hero 候选生图 prompt 三段模板（风格定调 + 参照用法 + 文字禁令）+ 变异纪律 + 续填素材 prompt 模式 + 回图诊断表——阶段 2 写候选 prompt 前、阶段 3 写配图 prompt 前、回图异常复查时读
  - path: references/profile-coordination.md
    description: profile 协同字段查找表（HeroContent 版式 / scaffold 参数 / 风格规则 / 配色 / 字阶 / look 验收 × profile 三档）+ 判定速查——阶段 2/3 涉及「按 profile 走还是按 workflow 兜底」选择前读
---

## 执行总纲

hero-first 五阶段执行序：**阶段 0 需求接入 → 阶段 1 方向提案（文本轮，CP1）→ 阶段 2 hero 物化（图像轮，CP2）→ 阶段 3 结构与填充（CP3，polish 独立成段）→ 阶段 4 终审（CP4）**。Checkpoint 总数 = 4（文本 ×1 + 图像 ×3），载体一律是 ask_user_question 表单（契约见「Checkpoint 表单」节）。

预算纪律：step_budget = 70；每 CP 自然停顿即 run 终止续跑，用户作答后预算重置；阶段 3 填充中途预算不足时按「resume 协议」节收尾，不硬撑。

## 通用纪律（四则，各阶段适用）

- **双图工具路由**：generate_image = AI 生成/重绘，stock_photo = 真实摄影图库，按 CP2 确认的图片来源路由逐节套用；两工具的调用格式/批量/references/鉴权语义以各自工具描述为权威。
- **组合原语**：render 的 JSX 内可直用 solid / linearGradient / radialGradient / angularGradient / diamondGradient / dropShadow / innerShadow / layerBlur / backgroundBlur / foregroundBlur。三坑：渐变必须显式 transform（缺省方向右→左）；渐隐用 8 位 hex 带 alpha（`#FFFFFF00` 全透明）；多 fill 数组按绘制序（首条 = 底层）。既有节点加/改阴影模糊用 set_effects，永不为此用 eval；修复一轮里效果最后加（阴影/模糊改包围盒、可能位移布局）。跨节色调统一可用全幅矩形 blendMode="hue"/"overlay" + 低不透明度（0.15~0.25）的 global tint（仅多图色彩失和时）；busy 图上压字给 `shadow="0 2 8 #00000066"` 或在文字块后垫深色 scrim 矩形。per-style 背景配方归 profile 文件，不在本纪律内。
- **brief 协议**：四区单一事实源。内容区 = 绑定输入——事实与约束（品牌名/价格/日期/指定口号）精确遵守不编造不抵触，措辞归 AI 创作（仅用户明说逐字保留的文本才锁定）。素材区 = 素材条目（图 + 用法注记）；空区（仅 EmptyHint 行）= 未提供素材，非错误；注记三态：指定用途（必须填该槽）/ 仅作参考（取风格不落画布）/ 未注记（AI 定落位，填充前向用户说明计划）。AI 结论区 = 按设计归组的 append-only 结论——只读本设计的归组，兄弟设计的结论不适用；写入经 append_brief_conclusion 一行一条，永不改删既有行。关联设计区 = 只读投影（id 权威 + 名称/mode/profile 读穿），条目由 setup_design 自动登记，永不手工增删；「（已删除）」注记是墓碑保痕，不是待清理脏数据。素材理解：注记权威，仅当决策依赖图像内容（未注记素材要落位 / 注记与图疑似不符 / 生图需配合素材色域）才 look 该素材 imageNodeId，看后写一行结论区备查（已有结论行且素材未换则信任不重复看）；图与注记明显不符先问用户再用。
- **画布选区**：用户经输入框「采集画布选区」按钮把画布选中节点采集为消息内的 `@画布选区-N` 内联引用；消息尾部的 `[画布选区]` 块是该引用的清单（每个 N 对应哪些节点 id/名称/类型）。「用这张图」= 清单里的图像节点，「基于这张再做一版」= 清单里的设计框；选区引用优先于画布搜索。清单行标「（已删除）」= 节点采集后被删，标「未采集的引用」= 用户手打的占位（无对应节点，按用户文字意图理解并向用户确认）。用户删除 brief 或要求不用 brief 时尊重之，本会话内不再重建。

工具白名单按阶段声明（各阶段「工具」行 = 该阶段允许调用的全集，未列出即不调用）；全程通行工具（read_brief / look / describe / ask_user_question / append_brief_conclusion）在各阶段不重列时也始终可用。

## 阶段 0 · 需求接入

做：read_brief 读当前页需求单 → 无则 create_brief（initial_content = 用户原话逐字转录，不润色、不扩写；画布持久化，不弹面板）→ 新建意图经用户确认后调 setup_design({ modeId, profileId?, briefId, canvas? }) 新建设计区根框并登记进 brief 关联设计区（canvas 省略 = 用本 mode 首选尺寸预设）。

不做：续作（用户接着改既有设计）不调 setup_design——按「resume 协议」读现场直接续跑；不替用户改 brief 内容区（逐字转录纪律）；不把用户的修改请求当新建意图。

歧义纪律：read_brief 返回 `{ brief: null, ambiguous: true, candidates }`（当前页多张需求单、均未绑定活跃设计）时**不建单、不擅选**——把候选列给用户，问清用哪张还是确认新建；用户删掉或明确不用某张 brief 时尊重之，本会话内不再重建。

工具：read_brief / create_brief / setup_design / look（查验 brief 素材区图片，imageNodeId 取自 read_brief 结果）/ set_active_design（用户指认「改之前那张」时声明切目标——只声明不落槽，用户聊天内确认后移槽生效；返回 {error} 即目标非法，告知用户并停止，永不重试强切）。

## 阶段 1 · 方向提案（文本轮）

做：产出内容大纲（分区章节序，内容驱动——见「画布尺寸」节）+ 视觉方向（风格词 / 构图 / 色彩氛围）+ 标题与 CTA 文案稿（AI 直接撰写）。事实类信息（价格、折扣、日期、地址、规格参数）缺失时在 CP1 表单内以 text 题追问，不编造。

不做：不给精确 hex（色彩纪律 = 方向期只说氛围、填充期自由发挥、终审 look 验收）；CP1 确认前不调 generate_image（花钱的事用户说了算）。

══ CP1 · 文本表单 ══ 方向确认 + 标题文案锁定 + 缺事实追问。标题在此锁定：它同时充当阶段 2 生图参照与最终画面文字，锁定后不再改措辞。锁定结果（方向、标题、确认过的事实）逐行 append_brief_conclusion 写入 AI 结论区。

工具：read_brief / look / ask_user_question / append_brief_conclusion。

## 阶段 2 · hero 物化（图像轮）

做：先把锁定的标题渲染为最小版式（真文案、真字号，render 进根框并 describe 修尽 error）→ prepare_hero_scaffold（克隆标题版式为页面级参考帧；underlap_px / transition_zone_px 按 profile 语境定值，几何记录写进 scaffold，下游只读记录不散传）→ generate_image 全分辨率候选 ×2~~3（默认 2~~3，直接全分辨率，无低清分级）。每候选落独立节点（同尺寸、同标题参照）；references 用 scaffold 作合成参照时 prompt 必须明写参照用法（围绕标题构图、标题区保持平静低细节、画面中不画任何文字）。写候选 prompt 前经 load_reference 读 `references/hero-prompt-template.md`（三段模板 + 变异纪律 + 回图诊断）；算 scaffold 几何 / 落位坐标前读 `references/coordinates.md`。

候选纪律：单变量受控变异——风格词与标题参照锁同，一批内只动一个变量轴（构图 / 氛围 / 题材择一）。用户整批拒绝 = 合法请求，确认界面自带成本提示；整批重生计数与脱困阀见「脱困阀」节（每次整批重生写一行结论区备查）。

### profile 协同（三档）

profile 协同按「profile 有相关规范 → 按 profile；无规范 → workflow 兜底值；无 profile → 同兜底值，agent 自行发挥处注明」三档执行——字段级查找表（HeroContent 版式 / scaffold 参数 / prompt 风格 / compose_backdrop 配置 / look 验收 × 三档各自的值）与判定速查在 `references/profile-coordination.md`，阶段 2/3 走到协同点前经 load_reference 读取。

══ CP2 · 图像表单 ══ image_select 引用全部候选节点 nodeId 择优 + 图片来源确认（AI 生成 / stock_photo / 用户素材——顺带确认后续节次用图来源）。

不做：不铺超过 3 个候选；不在 CP2 前 compose_backdrop。

工具：render / prepare_hero_scaffold / generate_image / describe / look / calc / ask_user_question / append_brief_conclusion。

## 阶段 3 · 结构与填充

做：skeleton 骨架渲染（分区章节序按 CP1 大纲，参考当选 hero 的实际画面配重定各节比例；每节 render 必带 parent_id = 根框 id，JSX 里不写 id）→ CP3 确认 → compose_backdrop(hero_image_from = 当选候选)——幂等采纳，不重新生成；canvas_height 缺省跟随根实际高度，HUG 收尾闭环 → 逐节填充循环：render → describe → 修尽 error（warning 向用户陈述即可，不阻塞）→ 自检行（本节做了什么、describe 结果如何）→ 全部节填完后 polish 独立成段：全局调和，消费「Fix Playbook」节逐项过表。

骨架纪律：文本节用 h="hug" 让 padding 承白，定高只给媒体槽；图片占位一律命名（HeroImg / ProductImg / …）并给浅灰占位 fill；占位阶段不写任何编造的具体事实。高度算术一律 calc，不心算。

══ CP3 · 渲染图表单 ══ 骨架结构确认 + 色调氛围与方向锁定一致性确认（配色无专用工具——在填充开始前截断「色调跑偏」的返工半径；用户看着画布上的骨架对照回答）。确认项不通过 → 按作答调整骨架/氛围后重发 CP3，不进填充。

不做：不在 CP3 确认前填充内容；profile 的 Hero treatment 节另有规定时以 profile 为准。

工具：render / describe / look / calc / compose_backdrop / generate_image / stock_photo / batch_update / update_node / set_layout / set_layout_child / set_radius / set_fill / set_stroke / set_text / set_text_properties / set_text_resize / node_resize / reparent_node / delete_node / find_nodes / get_node / get_jsx / ask_user_question / append_brief_conclusion。

## 阶段 4 · 终审

做：describe 全量审计（修尽 error）→ look 分区钻取验收：逐分区看，禁止从全览图判断小字（look 会在文字过小时自行声明并列出可钻取的文本节点 id，按它下钻）→ ══ CP4 · 图像表单 ══ 终审确认（imageOptions 引用设计根框，可加关键分区节点）→ 通过后总结收尾，残余事实（未补上的素材、声明过的取舍）append_brief_conclusion 写入 AI 结论区。流程终点——无交付段，导出走编辑器既有功能。

工具：describe / look / find_nodes / get_node / append_brief_conclusion / ask_user_question；终审中发现的修复沿用阶段 3 修改工具集。

## Section 模式库（非约束性，供阶段 3 填充取用）

- **hero 默认版式**：Frame + flex col（justify end）覆盖文字子节点——背景填充（图/色）在底层，文字自动浮于其上，即「图上压字」的标准结构。
- **纯布局节**（流程步骤 / 网格陈列 / 价目表 / 规格表）：一律 flex 排布，不用绝对定位——后续内容增删不伤版式。
- **卡片节**（图 + 文字组合）：图在上文字在下；价格卡用「现价大粗 + 原价小字划线」对照。
- 忙图可读性三策（shadow / scrim 垫块 / global tint）见「通用纪律」组合原语则，不重复。
- 库中一切尺寸/字号均为语义占位：宽度取当前尺寸预设的 W，字号按「字阶规则」节分档，profile 另有规定时以 profile 为准。

## Checkpoint 表单（CP1–CP4 契约）

载体 = ask_user_question，一次调用批量提全部问题（1..8 题），形状：`{ questions: [{ id, kind, label, options?, imageOptions?, required? }] }`——kind ∈ single_select | image_select | text；single_select 带 options（2..12 条，`{id, label, hint?}`）且不带 imageOptions；image_select 带 imageOptions（1..12 条，`{nodeId, label?}`，引用画布节点）且不带 options；text 两者均不带；required 缺省 true（可选题显式传 false）。id 全表单唯一、label 非空；校验失败返回 {error}，改正后重发，不抛异常。

运行语义 = run 终止续跑：工具结果恒为 `{formId, status:'awaiting_user', questions}`——拿到该结果即结束本回合，不再调任何工具、不再输出文本。作答或跳过经下一条用户消息物化：作答首行 `[表单作答 formId=…]` + JSON 行 `{"aborted":false,"answers":{"<questionId>":value},"freeText"?:"…"}`（可选 freeText = 用户原话，一等答案内容，按内容采纳）；跳过首行 `[表单跳过 formId=…]` + `{"aborted":true,"freeText":"…"}`。跳过 = 用户用自由文本表达意图，按内容续跑，不重发同一表单。

自由文本双角色：前端恒带自由文本输入——既是第四种作答（随作答信封 freeText 键回传，非空时豁免必填校验），也是跳过理由；方向类 single_select 选项集末位固定放一项「都不合适（我补充说明）」。

表单内不提供 mode 切换入口（保持表单 mode 纯净）。四张表实例：

- **CP1**（阶段 1 末，文本表单）：single_select 方向选项集（2..12 条 + 末位逃生项）+ text 缺事实追问（每条事实一题）+ single_select 标题文案锁定确认（确认 / 改写）。
- **CP2**（阶段 2 内，图像表单）：image_select 候选 nodeId 择优 + single_select 图片来源确认。
- **CP3**（阶段 3 填充前）：single_select 骨架结构确认 + single_select 色调氛围与锁定方向一致性确认。
- **CP4**（阶段 4 末，图像表单）：image_select 终审确认（根框 + 关键分区 nodeId）。

## 脱困阀

触发：同一方向下用户整批拒绝并重生 ×2 仍未选中 → 禁止第三次重生，强制回 CP1 重提案。CP1 重入选项集 = 改方向描述 / 换 profile / 换尺寸预设 / 换模式。执行分工：

- 改方向描述：留在本 run，按新描述重走阶段 1。
- 换尺寸预设：sizes 清单内另选或按用户语言自定义——衍生语义，经新建意图确认后 setup_design 以新 canvas 新建设计区。
- 换 profile：走「restyle 协议」节（新建衍生，非原地重入）。
- 换模式：表单只负责收集选择——确认与执行不在表单职责内，经新建意图确认卡完成（同「restyle 协议」节的确认卡流程）。

计数纪律：无回合状态落盘，重生计数由 AI 自觉维护——每次整批重生写一行 append_brief_conclusion（批次、变量轴、结果），续作时按结论区重建计数。

## resume 协议（续作与超预算收尾）

无回合状态落盘。续作现场 = 三重 ground truth：画布产物（实物）+ brief 结论区（日志）+ 会话历史（未答表单）。续作 = 按落盘 mode 组装本 workflow，AI 按下序读现场重建：

1. read_brief——内容区（原始需求）+ AI 结论区（按设计归组的锁定方向/事实/进度/重生记录）+ 关联设计区（设计条目与墓碑注记）。
2. describe / look 验画布实物进度——结论区与画布冲突时以画布实物为准，并补记一行勘误进结论区。
3. 会话历史找未答表单（[表单作答]/[表单跳过] 信封是否已回）——未答即续等语义，不重发同一表单。

fill 超预算收尾（收到剩余步数告警或自判不足时）：当前节修到 describe 无 error → append_brief_conclusion 写进度行（已完成节次 / 剩余节次 / 下一步动作）→ 固定话术收尾：「已画完 N/M 节，回复『继续』从第 N+1 节续填。」——不停在半节中间，不静默省略剩余节。

## restyle 协议（换风格）

修改请求路由：换风格 → 本节协议（新建衍生）；其余修改（recolor / resize / copy edit / 换图）→ 直接编辑既有节点、跳阶段，不重走五阶段执行序（修改范围局部化，改完 describe 修尽 error 即可，无需 CP 确认）。

restyle = 切 profile 新建衍生，不做原地重入：旧设计画布原样保留；携带物经新建意图确认卡勾选（brief 素材区自动继承；已生成图片可选作 references——作风格/内容参照时 prompt 明写参照用法）；确认后 setup_design 以新 profile 新建衍生设计区，从阶段 1 重跑本执行序。提案时向用户一行报价「哪些节保留 / 哪些节重生」。

## 画布尺寸

mode 级尺寸预设：`sizes` 清单 = `[{label, canvas}]`——canvas `宽x` 高度随内容（HUG）/ `宽x高` 定高；本 mode 预设 = 电商详情长图 750x + 小红书长图 1080x。用户按名称显性选择其一或语言通道自定义尺寸；未显性指定时 agent 按语义意图自选预设之一或自定义，均未指定 → 首选预设（清单首条）。sizes 缺席的 mode → 缺省 750 宽 + 高度随内容（同 general）。

尺寸与内容结构的关系：两预设只定宽度档（连带「字阶规则」节的分档），不预设章节列表——分区章节序由内容大纲驱动（阶段 1 提案、CP1/CP3 确认），本 mode 不设固定分区模板。

## 字阶规则（画布尺度分档）

长图字号下限按画布宽度分档：

- **1080x 档（宽 ≥900px，规则本体适用）**：正文 body ≥ 22 / 节标题 section ≥ 40 / hero 主标题 ≥ 64。
- **750x 档（宽 <900px，等比降档）**：正文 body ≥ 20 / 节标题 section ≥ 36 / hero 主标题 ≥ 72（与内置 profile 的 750 字阶对齐）。
- 两档 caption / 辅助文字均 ≥ 16。

检测：describe 树摘要行报每个文本节点的字号（`"文本" Npx 字族`），逐节点对照本表即机检。优先序：与当前 profile 的 Typography 节字阶冲突时**以 profile 为准**；profile 未规定字阶时适用本表。

## Fix Playbook（polish 段消费）

症状 → 检测 → 动作 → 升级条件一张表。检测只写 describe 能报或 look 能验收的项；修复动作尽量批量化（batch_update）。

| 症状                   | 检测                                                                                                                                 | 动作                                                                                               | 升级条件                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 文字溢出/截断          | describe error（overflows / Nested Text / collapses）                                                                                | set_text 精简文案或 set_text_resize 给缩放余量；容器 node_resize；仍挤则字号降一档（不破字阶下限） | 同节 2 轮仍报 error → 砍内容密度，结论区声明           |
| 对比度不足             | describe warning（Low contrast，distance<15）                                                                                        | set_fill / set_text_properties 拉开明度差；图上文字加底色带                                        | 与锁定氛围冲突 → look 复验后结论区声明取舍             |
| 占位符残留（灰块未填） | describe（image 容器无图无占位 fill——仅命名含 poster/avatar/image/thumb/photo/cover/banner 且裁剪的容器可机检）+ look 分区查灰块兜底 | 补图（generate_image / stock_photo / brief 素材 references）或 set_fill 补语义化占位色             | 缺素材 → 问用户或结论区记「待补」，不留灰块交付        |
| 跨节 palette 漂移      | look 逐节对照 CP3 锁定氛围（配色无专用工具，describe 不检测）                                                                        | set_fill 统一到方向色域                                                                            | 2 轮仍不一致 → 回 CP3 重述色调确认                     |
| hero 接缝可见          | look 根框 / hero 区，focus 声明查接缝                                                                                                | compose_backdrop 幂等重调（canvas_height 缺省跟随根高）；仍可见则显式传 hero_color                 | 重调 2 次仍可见 → 重生 hero 图（计入整批重生纪律）     |
| 字阶越轨               | describe 树字号对照「字阶规则」节分档                                                                                                | set_text_properties 调档                                                                           | 与 profile 字阶冲突 → 以 profile 为准，不动            |
| 图片内嵌文字（乱码字） | look 候选/落图节点（纯位图节点走 original-bytes 通道看原图）                                                                         | 重生成该图，prompt 明写「画面中不出现任何文字」                                                    | 同批 2 次仍带字 → 换素材路线（stock_photo / 用户素材） |
