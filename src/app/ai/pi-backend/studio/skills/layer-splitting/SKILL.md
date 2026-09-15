---
name: layer-splitting
description: 将一张原图按视觉核心拆分成可独立编辑的 canvas 图层——背景 / 主体 / 前景 / Logo / 文字各成独立节点，原位叠放组装，文字层用原生可编辑文本节点（不栅格化）。Use when asked to split an image into layers, layer-split a picture, decompose a design into separate editable layers, or when the user types 图层拆分 / 图片分层 / 拆图层 / 分层拆图。
---

# 图层拆分（layer-splitting）

把一张位图原图按视觉核心拆成多个可独立移动 / 隐藏 / 编辑的 canvas 节点：非文字层用 `generate_image` 生成图层位图，文字层用原生 TEXT 节点重建（不栅格化），全部挂进一个与原图同位同尺寸的容器 Frame 内，原位叠放。

---

## 0. 适用范围与边界

- 输入：canvas 上一个位图原图节点（IMAGE / 带位图 fill 的 FRAME / RECTANGLE 等）。
- 输出：一个容器 Frame（与原图同位置、同尺寸），内含 ≤10 个非文字图层 + 任意数量的文字图层。
- 终点：用户能在编辑器里独立拖动 / 隐藏每一层。原图保留在容器外，不被破坏。

**不适用**：本身已是原生节点组合的设计稿（文字、图形已是独立节点，无需拆分）、纯矢量插画（无清晰视觉边界，硬拆割裂感更强）、像素艺术（透明化处理会破坏硬边）、动图 / 视频帧。

---

## 1. 阶段 0：拆解规划（一次 look 完成）

1. `get_node` 读原图节点：`id`、`x` / `y`（相对其父级）、`width` / `height`（记作 W × H）。
2. `look` 原图节点（节点为单一位图 fill 时拿到的是原始分辨率图；多 fill 节点拿到的是渲染图，同样可用），用这一次截图同时完成两件事：
   - **分层规划**：把画面拆成 ≤10 个非文字视觉核心 + 若干文字行，每层起语义名。规则按重要性排：
     1. 背景永远是独立一层（即使只是纯色或渐变）；
     2. 能被设计师独立拖动 / 替换的部分才独立一层；
     3. 同构 / 对称 / 规律阵列组件作为一个整体（例：6 张产品图算一个"产品阵列"层，不拆 6 层）；
     4. Logo、字标及与其视觉绑定的周围装饰整体保留；
     5. 难以独立拆分的小元素（溅射、星光、噪点）融入背景；
     6. 不增加原图不存在的内容——分层是结构任务，不是创作任务。

     典型分层（自底向上）：背景 → 主体（视觉中心）→ 前景装饰 → Logo / 品牌组 → 边框 / 光效；文字行各成一层。
   - **文字清单**：逐行记录原文（逐字，读不准标"待读"）、相对原图左上角的位置、字号估算（约 N px）、颜色（hex）、对齐、字体（不确定记"待确认"）。记录模板见 [references/text-reconstruction.md](references/text-reconstruction.md)。

注意：`find_nodes` / `describe` 只能读场景树结构，**看不了位图内容**——"哪些是文字、哪些是图形、有无遮挡"只能靠 `look`。

> 阶段 0 交付物：分层规划 + 文字清单（mental note 即可）。后续阶段不再重复 look 原图。

---

## 2. 阶段 1：容器骨架 + 批量生图（非文字层）

**坐标纪律（本流程最容易翻车的一步）**：节点的 `x` / `y` 是**父级相对坐标**。把图层直接建在页面 `(0, 0)` 会落到画布原点——既不对齐原图，还可能压住画布上的其他内容。正确做法：所有图层挂在一个**与原图同位同尺寸的容器 Frame** 内，统一用容器局部坐标 `(0, 0)` 叠放。

### 2.1 一次 `render` 建完整骨架

```jsx
<frame name="<原图名>·拆分" x={原图x} y={原图y} width={W} height={H}>
  <frame name="背景" x={0} y={0} width={W} height={H} />
  <frame name="主体" x={0} y={0} width={W} height={H} />
  <frame name="前景" x={0} y={0} width={W} height={H} />
</frame>
```

- 调用参数：`parent_id` = 原图的父节点 id，`insert_index` = 原图在兄弟中的 index **+ 1**——兄弟顺序即 z 序（越靠后越顶），容器落在原图**正上方**盖住原图（用户默认看到拆分成果；隐藏容器即可对照原图）。父节点与 index 用 `get_page_tree` 查（`get_node` 的返回不含父级信息；`describe` 只适合已知父节点后向下验证其内部顺序）。Frame 默认无 fill，容器自身不遮任何内容。
- 层 Frame 的声明顺序就是 z 序（先底后顶）：背景第一，其余按原图遮挡关系排。
- 返回值含容器 id 与 `children` id 列表（按声明顺序对应各层），记录备用。

### 2.2 一次 `generate_image` batch 生成所有非文字层

`requests` 每项一个层：

- `replace_id`: 该层预建 Frame 的 id——生成结果是**原地换 fill**，节点 id / 位置 / 尺寸 / 父子关系都不变，无需重记；
- `references: [原图id]`——原图作视觉参考；
- `width: W, height: H`、`quality: 'high'`、`output_format: 'png'`；
- `transparent_background`：**背景层 `false`，其余层 `true`**——背景层要的是补全被主体 / 文字遮挡区域的**完整不透明底图**（开透明会把遮挡区留成空洞）；其余层要的是目标之外全透明；
- `prompt`: 结构化模板见 [references/separation-techniques.md](references/separation-techniques.md)（背景层有专用变体，别套用通用模板）。

**硬纪律**：
- 禁止逐层单独调用——`generate_image` 的工具描述要求一次 batch 提交全部需求，逐层循环调用耗时与 token 都膨胀数倍；
- 禁止 `replace_id` 指向原图节点——覆盖不可逆。

### 2.3 单项门控

每层生成后 `look` 该层节点单查：只含本层目标 / 目标外区域无实心底色（背景层：完整无洞）/ 边缘完整 / 位置与原图一致（容差 ~10%）。不通过的项带相同 `replace_id` 单独重试 1 次；仍败保留现状、记入阶段 4 汇报，由用户决定。判据与重试细则见 [references/quality-checklist.md](references/quality-checklist.md)。

---

## 3. 阶段 2：文字层（原生 TEXT 节点）

文字绝对不用 `generate_image` 出图——必须原生可编辑。按阶段 0 的文字清单逐行施工：

1. 一次 `render` 把所有文字行建进容器（`parent_id` = 容器 id；`x` / `y` = 清单里相对原图左上角的位置——容器与原图同位，局部坐标即原图内坐标）；
2. 逐节点设属性（一个属性一个工具，没有批量入口）：
   - `set_text` 写原文（逐字，含 JSX 里已写的也再设一遍确保一致）；
   - `update_node` 设 `font_size`（清单估算值）/ `font_weight`（100-900）；
   - `set_text_properties` 设 `align_horizontal`（LEFT / CENTER / RIGHT）+ `auto_resize: 'WIDTH_AND_HEIGHT'`（节点随内容自动定宽高，不用猜文字框尺寸）；
   - `set_fill` 设颜色（hex——6 位不透明如 `"#FFFFFF"`；原图文字半透明时用 8 位 RRGGBBAA 如 `"#FFFFFFCC"`，透明度随 fill 保留）；
   - `set_font` 设字体族（改字体的唯一入口；清单记"待确认"就省略，让引擎 fallback）。

完整代码示例见 [references/text-reconstruction.md](references/text-reconstruction.md)。读不准的字不硬猜：标出来问用户（识别不确定比瞎猜安全）。

---

## 4. 阶段 3：组装

- z 序 = 容器内子节点顺序：背景最底 → 非文字层按原图遮挡关系 → 文字层最顶（原图明确有元素遮挡文字的个别情况，按原图关系用 `reparent_node` 调整）。骨架声明顺序按阶段 2.1 排好则无需调整。
- 各层位置在创建时已就位，无需再调坐标。
- 原图在容器外保留不动作为对照基准——完成后告诉用户可隐藏原图或容器做前后对比。

---

## 5. 阶段 4：强制验收（不可省略）

漂移是端到端最大不确定项——生图模型对"原位重绘"的遵从度非 100%，必须用 `look` 逐层对照原图验收：

1. **逐层 look 对照**：位置漂移 <5% 通过；5–10% 通过但在汇报中标注；>10% 带相同 `replace_id` 重试 1 次，仍败告知用户并保留现状。文字层漂移直接 `update_node` 校正（坐标是 agent 自己设的）。
2. **逐层显隐**：`update_node` 切 `visible`，确认每层独立隐藏后剩余画面仍自洽（不暴露不该出现的元素）。
3. **`describe` 容器**：节点数 / 命名 / 层级顺序与阶段 0 规划一致，原图节点未动。

验收汇报模板与失败上报纪律见 [references/quality-checklist.md](references/quality-checklist.md)。不做验收就交付 = 反模式——漂移是确定会发生的事。

---

## 6. 缺 image-gen key 的引导

`generate_image` 报缺 key 类错误时（错误串含 `not configured` 或 `No image-gen provider` 特征），不要硬试——直接告诉用户：

> 图片生成功能尚未配置。请到 **设置 → AI 和代理 → 图像生成** 填入 API key 后再试。当前图层拆分无法继续（生图是核心环节）。

不要替用户猜 provider、不要降级到非透明背景（分层会丢失透明通道）、不要静默跳过。

---

## 7. 相关 references

- [references/separation-techniques.md](references/separation-techniques.md) — 非文字层结构化 prompt 模板（含背景层专用变体）与填充示例
- [references/text-reconstruction.md](references/text-reconstruction.md) — 文字清单模板与 TEXT 节点施工序列
- [references/quality-checklist.md](references/quality-checklist.md) — 单层 / 组装 / 漂移三层验收判据、重试策略与汇报模板
