# skill 运行时事实快照（skill-installer 内置 reference）

> 基线：open-pencil-mode `rebuild/mode-arch` @ 504abf1a1（2026-09-21）+ pi SDK
> `@earendil-works/pi-coding-agent`（node_modules 现版）。
> 来源：docs/202609212224-skill-runtime-facts-snapshot.md（一次性源码核查产物）。
> 本文件 = 元 skill 加载机制面的全部依据，烘焙进随 skill 发布的
> reference。**复核钩**：产品加载机制变动时同批复核本快照（挂机制复盘钩/发版检查清单）；
> 复核时重跑同样五条核查，Diff 即漂移。
> 注意：skill-installer 是元 skill，**无源码视角**——本文件是判断 frontmatter / 加载 /
> 生效 / 撞名 / 剥除白名单的机械依据，不可现场核查，只能照单执行。

## 1. SKILL.md frontmatter 解释全集（白名单的真源）

pi SDK `skills.js loadSkillFromFile`（skills.js:208-248）**只读 3 个键**：

| 键                         | 语义                                               | 校验                                                                                 | 缺省                                             |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `name`                     | skill 标识                                         | ≤64 字符、`/^[a-z0-9-]+$/`、禁首尾连字符与连续 `--`；**违例仅 warning 诊断，仍加载** | 回落父目录名                                     |
| `description`              | 触发信号                                           | **唯一硬闸：缺失/全空白 → 不加载**；>1024 字符仅 warning                             | 无                                               |
| `disable-model-invocation` | 严格 `=== true` → 不进 `<available_skills>` prompt | 仅布尔 true 生效                                                                     | false = 进 prompt，仍可 `/skill:<name>` 显式调用 |

- **其余一切键被忽略**：`allowedTools` / `license` / `metadata` / `version` 等在 SDK 零消
  费点；Skill 对象仅 `name / description / filePath / baseDir / sourceInfo /
disableModelInvocation` 六字段。
- **我方装配面零额外解释键**；manifest 投影二次白名单只取 `name / description`
  （manifest.ts:91-95）；`/skill:` 展开时 `stripSkillFrontmatter` 整块剥掉 frontmatter
  ——**模型永远看不到 frontmatter**（capabilities.ts:230-233）。
- → **install_skill 的 frontmatter 白名单 = `{ name, description, disable-model-invocation }`**；
  skill-installer 剥除多余字段后写 MIGRATION.md，不告警用户。

## 2. 软/硬校验边界（install_skill 须自己硬化的点）

- name 非法 SDK 只 warning 不拒载 → **name 硬闸只在 install_skill**
- description 缺失 SDK 才拒载 → install_skill 同规则硬拒即可对齐
- 目录扫描：跳过 `.` 开头目录与 `node_modules`，其余子目录递归找 SKILL.md
  （skills.js:161-190）——**任何非点开头含 SKILL.md 的目录都会被加载**（`.bak` 撞名坑的
  真源）

## 3. 加载与生效语义

- **双源**：`additionalSkillPaths` = 用户层 `<rootDir>/workspace/.agents/skills/` + 内置层
  `<builtinStudioDir>/skills/`（目录可不存在；rootDir 运行时 =
  `%APPDATA%/Dianjing` 形态）
- **每新会话** assembly 新建 loader 现场 `readdirSync` 扫目录，无跨会话缓存；存活会话
  entry 缓存复用不重载 → **生效语义 = 下一会话**（agent 面）
- **撞名**：SDK 先载者胜（collision 仅诊断）+ 我方 manifest 合并**用户层赢同名** → 用户
  层同名静默遮蔽内置层 → **install_skill 撞内置名拒装**的依据
- **`agentSkills: false`** → 装配 `noSkills` + `listSkills()` 返 `[]`（装进的 skill 同样
  不加载）
- **UI**：chips 清单 combobox 打开 / 新会话铸新即重拉

## 4. install_skill 闸门落地形

- 确认通道现状 = **单动作确认卡**：拒绝 / 断连 / 显式取消 = 拒装。另有一种 ask 表单卡
  （1–8 问，逐问硬阻断）；同 session 同时刻两类合计最多 1 条待确认——弹确认卡期间不要再
  发 ask。
- **「skill 声明面 + 按清单一次批」形态未落地**——现确认通道无任何批量/清单字段。
- → v1 闸门落地形：**单动作确认卡**，卡上渲染将安装的文件清单 + 适配点摘
  要；清单式确认形态落地后再升级。
- **无人值守**：**无超时机制**；abort / 断连 / 显式取消 = 拒装，与 bash 授权同待遇。

## 5. 输出契约对齐

- `listSkills(): { name, description }[]`，filePath / baseDir 等不出后端
- install_skill 返回建议对齐：`{ path, files[], name, 生效语义（下一会话）, 调用方式
/skill:<name> }`

## 6. studio 资产 frontmatter（另一套格式，勿混）

- `studio/` 的 base / workflows / profiles 走自有格式：`id`（=目录名，必填）/ `label`（必
  填）/ `subtitle` / `step_budget` / `sizes` / `modes` / `version` / `deprecated` /
  `references`（validate.ts 容忍未知键；references 限 `.md/.txt/.json/.yaml/.csv`、禁
  `..` / 绝对路径；`_` 前缀目录跳过注册）
- 与 SKILL.md 面**平行不交叉**。`studio/skills/` 即本 skill 所在层——走 SDK 面
  （§1-§3），**不套** studio 资产键（id / label 等）

## 7. skill-installer 元 skill 自身的加载预期

- 内置层落点：`<builtinStudioDir>/skills/skill-installer/SKILL.md`
- frontmatter：`name: skill-installer` + description（中英文触发词饱满）
- references 烘焙：principles.md + runtime-facts.md（本文件）
- 加载面 = SDK SKILL.md 三键解释；description 即触发信号（agent / 用户都看）
- 生效：下一会话即被自家 description 触发（用于后续用户调用本元 skill 迁别的 skill）
