# 优质 skill 迁移改造原则（principles.md）

> 来源：参考项目/00-migrated-skill/PRINCIPLES.md（2026-09-18 定稿）。
> 本文件 = skill-installer 内置 reference 副本——元 skill 不可读仓内参考项目，按 SDK 面
> runtime 知识必须烘焙进随 skill 发布的 references/。
> 修改同步：源文件修订时同批改本 reference。

## 核心原则：尽可能原文原味保留，只做局部必要的 runtime 适应性修改

**默认动作 = 原文搬运。** 正文措辞、结构、知识密度、默认值、触发词一概不动——skill
的价值就在这些被原作者反复打磨过的文字里，任何「顺手优化」都是走样风险。

## 允许修改的正面清单（仅限 runtime 适配）

只改「不改就跑不起来 / 必然出错」的地方，逐项列：

1. **文件读取方式**：源 runtime 的文件访问假设（本地路径、grep 等）→ 换成我方 agent
   实际有的工具（`read` 工具按 skill 目录相对路径读取，参照 layer-splitting 惯例）。
2. **产物落点**：源 runtime 的存盘指令（如写到 `~/Desktop/...`）→ 删掉或改写为我方真实
   通路（如 generate_image 自动上画布；本地留存由产品统一管理，skill 不写死用户路径）。
3. **引用输入形态**：源 runtime 的「本地文件路径」引用 → 我方真实输入形态（如画布节点
   id 作 references）。
4. **描述触发词补位**：description 里补中文触发词，让中文用户能唤出——纯增量，不删原文
   触发词。
5. **版权/license 随行**：源仓库 LICENSE 必须随 skill 一并迁入；LICENSE 不允许的素材
   （示例图、第三方 reference 图）不迁。
6. **交付展示形态**：源 runtime 的「在回复中贴图 / 展示生成图 / 引导查看输出文件」类交付
   引导 → 我方图片直接落在画布、用户看画布即可，回复只做文字说明（节点名、位置、验收结
   果），不在回复中贴图或给图片路径；用户明确要图片文件时才用 `export_image_to_file` 导
   出。收尾全扫时把「展示/贴图/render directly」类措辞一并过一遍。

## agent 面卫生（重点）：不泄露不必要的内部信息

**SKILL.md 与 references/ 是写给执行 agent 的操作指令，不是给人看的迁移报告。** 改编
落笔时逐句自问「agent 需要凭这句话做什么动作」——答不上来的信息一律不写。三类高发泄露：

1. **工具/产品的内部实现机制**：agent 不亲自实现的部分，机制细节一律不写。源 skill 里常
   有大段机制描述（抠图算法、编码纪律、文件桥格式）——那些是源 runtime 里 agent 要亲手
   实现它们才需要写的；我方 runtime 工具已包的（如透明化、留存、权限），只写「调哪个工
   具/参数、得到什么行为」，不写工具内部怎么做。
2. **迁移过程的痕迹**：迁移视角词（「In this runtime」、「本 runtime」、「runtime 内置」）、
   改编时的调和叙述（「工具纪律」「本技能纪律」类括号注、与源方案的对比说明）——这些只
   对迁移者有意义，对执行 agent 是噪声。改编后的句子要读得像原作者本来就为我方 runtime
   写的。
3. **产品内部词**：功能 slug、内部机制名（留存策略、日期桶、broker 等）——agent 施工用
   不到的一律不出现。

**可写**：agent 施工必需的词汇（我方工具名、参数名、画布概念如容器 Frame / TEXT 节点 /
references）与工具描述已公开的行为语义。

**迁移背景、机制对应关系、owner 裁决记录一律只进 MIGRATION.md**（人读档案），不进
SKILL.md / references（agent 读指令）。每个 skill 收尾前做一次泄露扫描再走。

## 明确不做（反面清单）

- **不泄露内部信息**：agent 面文件只留可执行指令，内部机制/迁移痕迹/产品内部词一律不进
  ——见上「agent 面卫生」节（重点）。
- **不翻译**：正文保持源语言（通常英文）——prompt 编译器类 skill 对措辞极度敏感，翻译引
  入漂移。
- **不加产品增强**：不因「我们画布能做得更好」就追加功能段（如原生文字叠层、额外工具链）
  ——那改变 skill 的作品形态，属于二次创作不是迁移。
- **不改默认值 / 阈值 / 配方**：颜色 hex、版式比例、决策树次序等，一律原样。
- **不迁 harness 基建**：源仓库的 CI / evals / 校验脚本（服务源 harness 的工程件）不带过
  来——它们不是运行时资产。
- **不结构性重组**：章节次序、标题层级保持原样。

## 每个 skill 的迁移记录（MIGRATION.md 格式）

每个迁入 skill 目录带一份 `MIGRATION.md`，记四件事：

1. **源**（仓库地址 + 版本/commit + 作者 + license）；
2. **runtime 适配点清单**（对照上面正面清单，逐条写明改了哪一行、为什么）——除这些行
   外，正文与源逐字节一致；
3. **未迁资产清单**（哪些源文件没带过来、各自原因）；
4. **frontmatter 剥除字段清单**（哪些键被剥除了——元 skill 自动剥，见
   `runtime-facts.md` §1 白名单）。

## 落位约定

- 每个 skill 一个目录：本产品内置层 `<builtinStudioDir>/skills/<skill-name>/`，用户层
  `<rootDir>/workspace/.agents/skills/<skill-name>/`（install_skill 写用户层；内置层
  仅随产品发版）。
- skill 本体 = `SKILL.md` + 其引用资产目录原结构（如 `references/`、`design-system/`）。
- 迁入后由 install_skill 工具接入用户层（key-guard deny 面外唯一写口）。
