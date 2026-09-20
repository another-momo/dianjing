# OpenPencil（mode 分支）· 代码向导

> 本文件只装仓库普适事实（任何机器、任何 clone 位置都为真）。
> 协作机制（角色权限矩阵 / 资源治理 / 环境硬约束）不在本文件范围内，由本机工作台层承载。
> 条目写法：只留规则与最小机制说明——禁日期、事故经过、"实证"锚点（档案在 git log）。

## 1. 项目与分支拓扑

- AI 设计编辑器：Vue 3 + CanvasKit(Skia) 渲染 + pi-backend AI 后端 + 自动化桥（browser-rpc）。
- 集成分支 `rebuild/mode-arch`；与上游保持定期合并，文件所有权由 zone 登记制机器化管理（§3）。
- monorepo：bun workspaces；`packages/*` 为库，`src/` 为应用。

## 2. 协作摘要（最低限度规则）

- 主 agent 唯一允许：git 写（commit / merge-back）、browser 实测、gh 操作；**未经允许禁安装/卸载软件、禁清理 worktree 以外文件**（owner 明令，仓外 §6 同款——打包版装卸交 owner 人工）。
- worker（subagent）：限定范围实现 + 目标测试文件；**禁**全量 test / dev / build、commit / push、`gh run rerun`；browser 默认禁——Playwright MCP 与主 agent 共享浏览器单例，派单显式授权时方可自验证且须互斥。commit / push 可经 owner 专项派单授权解禁（授权范围以派单文本为准）。
- push：主 agent 每次收口 commit 后顺势推；失败允许重试 3 次、每次间隔 30s，仍败走 Data API 兜底脚本（`tools/git-rescue/src/data-api-push.ts`，api.github.com 通路独立于 git 传输层），再败积压归 owner。worker 禁 push。
- gh 命令一律带 `-R another-momo/dianjing`。

## 3. zone 纪律（改代码前必读）

- `tools/zone-registry/zones.json` 是唯一所有权真相：`ownedRoots` / `ownedFiles` 内自由改；改动其他（上游供血）文件必须登记 `patches`；删除走 `deletedPaths`；搬移登记 `relocations`。台账登记与代码改动同批提交——漏登 = 交付不完整。
- pre-commit 强制 `check:zones`；`bun run check:zones:drift` 查看对上游漂移明细。
- `disposition: "revoked"` 的 patch **不提供覆盖**——改动曾 revoked 退役的文件（回 follow-pure）须新登 P-id，往 revoked 条目上追加备注不算登记。
- 上游合并 SOP：合并前 check:zones 绿 → 按 zone 裁定冲突 → 合并窗口内每次 check:zones 输出的 RELOCATION_WATCH advisory 必读（上游残迹落进 ownedRoot 的最早信号），逐条裁定后再 commit → 合并后 ownedFiles 字节审计 + relocations / tarball 台账更新。裁撤目录必须以目录条目登记 deletedPaths——逐文件条目挡不住上游新增，目录条目才有 checkDeletedAbsent 复活硬拦截。判上游版式/内容演进方向时以最新 release tag 为准，不锚本地 origin 分支 ref——release tag 会超前于分支头。
- 复活带 `deletedPaths` 墓碑的路径 = ①摘墓碑 ②**git add 暂存新文件**（未暂存时 git diff vs merge-base 不覆盖 untracked，该路径呈 D 撞 checkDeletedRegistered；暂存后翻 M 走豁免）③check:zones 实跑验收——只验 JSON 可解析不等于过语义闸。
- `tools/zone-registry/` 自身与 `.github/workflows/` 均为 ownedRoot，fork 治理设施自由改。
- 设置类工作流归各业务域自己的 `settings/` 目录（`use.ts` 编排 + 兄弟模块分工、持久化留在 domain services），不建全局 composables 桶——采上游 2026-09 family 重组语义。

## 4. 提交与门禁

- commit 前必跑 `bun run format:check`（CI 红灯首要嫌疑）。format 门禁覆盖含 .md——本地逐文件 gate 按本批全部改动文件跑，不按扩展名挑。
- oxfmt 只格式化门禁覆盖内或本批新建的文件——覆盖外的既有文件（desktop-electron 等不在 format 门禁内的目录）顺手格式化制造纯噪音 diff；误格式化用 `git show HEAD:file` 回滚。
- commit 前 `git status` 核对无残留未暂存改动——pre-commit 门禁跑的是工作区，绿 ≠ 已入库。
- 日常收口门禁：`bun run check:quick`（format + lint + typecheck + zones 四步串行）。
- 变更集含 `.vue` 时收口补跑 `bun run check:vue`（约 72s，不进 check:quick 是刻意的——主 agent 收口职责，worker 无责）。
- 注意：本机 oxlint 目录参数静默 0-file 假绿——本地 lint 结果不可信，以 CI 为准。本地复现 CI lint 用逐文件钉版：`bunx oxlint -c oxlint.json --type-aware --type-check <单文件>`（单文件参数不受 0-file 影响）。CI lint 分两段规则集——lint:structure 311 条 / type-aware（src+packages）345 条，互有独有规则；逐文件复现先对照 CI 失败日志属哪段，且 `&&` 串行使首段失败屏蔽次段——修绿一段须预期下一段浮新错。
- 大改动（≥10 文件或 ≥200 行）收口跑全量 `bun run check`，跑前停 dev server。全量 check 链在 check:audit 404（npmmirror 镜像环境性、基线同挂）处 `&&` 短路——其后 secrets/monorepo/arch/type-shapes/tools/dupes 六项须逐个补跑。
- studio 资产增删改名的耦合断言不止 tests/engine——`spikes/s-pi/backend-smoke/`（CI smoke:pi 契约层）直拷真资产目录并断言具体 id/数量/顺序；改资产同步扫 spikes/。
- 状态根/目录布局/路径契约类改动同样必扫 spikes：`spikes/s-pi/backend-smoke/` 钉死 token/状态文件相对布局，且冒烟 spawn 后端不带 env 时后端状态根不再跟 cwd。**sweep 输出禁截断**——`grep | head` 截断会漏钉。
- commit message：中文 conventional（`type(scope): 主题`）+ 正文写清 why——背景、方案取舍、验证证据。
- pre-commit = check:zones；post-commit = 机制复盘计数提醒（advisory，永不阻塞）。

## 5. 高发门禁坑（写代码时防一手）

历史 CI 红的高频成因，皆为可机械判定的硬规则——写时避开，别等门禁拦：

- 禁 `as unknown as` 双断言；要精确类型用单断言或 helper（lint 硬规则）。
- 会被 node/测试环境加载的模块，访问 `window`/`document` 等浏览器全局前先 `typeof` 守卫（lint + 引擎测试）。
- 新增生产入口/脚本在 knip.json `entry` 登记（knip 只核入口可达性；测试文件无需登记——knip.json 无 tasklist 一说）。
- 同形对象类型用别名复用，不另立字面量（type-shapes 门禁）。
- ≥10 行级相似块抽 helper，不复制粘贴（jscpd 克隆门禁）。
- 测试不读真实 env/浏览器全局，走注入与桩（引擎测试）。
- 第一方运行时校验用 Valibot；Zod 只留在要求它的 SDK 集成边界，不并行维护双 schema。
- 多行 prompt 组合用 `dedent` 包，不手写转义换行串；成段散文留在属主 Markdown 源，组合不复制（studio 谱系同此原则）。
- Window API 增强归编译边界：app 声明在 `src/global.d.ts`、包级 DOM 缺口在属包 `global.d.ts`；禁在 spec 或实现模块里 `declare global`。
- import 禁 `../` 逃逸 alias 根（`#tests/../vite` 式）；模块归属错位修归属，不修路径。
- vite.config.ts 加载链文件禁 `@/` alias：链 = vite.config → `vite/automation` + pi-backend/bridge 两个 vite-plugin → 其传递 import（如 `src/app/bridge/server/paths.ts`）——Storybook/vite config loader 不注册别名。用相对 import：单个 `../` 直接写，`../../` 逐行注 `// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports`。
- Electron 主进程/sidecar 单文件产物必须显式 `deps.alwaysBundle` 兜底：tsdown 默认把根 package.json dependencies（含 workspace:* 的 `@open-pencil/*`）external 化，而打包形态 resources/app/ 无 node_modules（electron-builder.yml files 显式排除）——产物留裸 import，安装版主进程启动即炸 ERR_MODULE_NOT_FOUND；dev 形态仓根 node_modules 兜底会完美掩盖，只有打包 L3 能兜住。
- type-aware `no-unnecessary-condition` 狙 Record 防御性索引访问：非 noUncheckedIndexedAccess 配置下索引访问类型恒非空，`current?.x` / `if (!x)` 皆报「不必要」；「`| undefined` 注解 + 非空初值」会被 CFA 赋值窄化窄回非空照狙——用 `in` 守卫产真并型。
- `.vue` SFC 不进 type-aware 覆盖——同一段防御写法在 .vue 里全绿、抽纯成 .ts 即被狙；.vue → .ts 抽纯后按 .ts 口径逐文件过 `--type-aware`。
- `check:quick` 的 typecheck 段（tsgo）同样不覆盖 `.vue`——SFC 内消费已退役字段/类型改名在 check:quick 全绿下潜伏，只有 `check:vue`（vue-tsc ×2）能兜；.vue 触面的改动收口前必跑 check:vue 或交 L2/CI。
- no-nested-ternary 的「加括号」修法会被 oxfmt 重新展开回无括号形（格式器归化优先级高于括号保留）——唯一格式器稳定解 = 抽归化助手/显式分支；lint 结构红修完必须 oxfmt 后再复 lint。
- 手跑 oxfmt 必须走 `node_modules/.bin` 钉版 exe 禁 bunx、首参必须带 `.oxfmtrc.json`——bunx 全局缓存副本与钉版同版本号不同构建、括号行为分叉，bunx 过格式的文件 CI format 照红；缺省配置 ≠ 项目配置。
- steiger（check:arch）FSD 同前缀兄弟文件阈值 = 3（非 4）：同目录 ≥3 个同前缀文件即红——归域目录（ask/ 式）或错开前缀。tools/<domain>/ 布局契约：工具文件必须落 `tools/<domain>/src/**`（strict-tools-layout），且域目录必须有 package.json 标记（test:tools 逐域读取，缺即 ENOENT）。
- ai SDK 就地改 tool part 对象（引用不变）——卡片状态门禁 computed 读 `part.state` 恒陈旧，须父级重渲染直传原值 prop（`:part-state` 模式）。
- CI windows runner checkout 把文本物化成 CRLF（Git for Windows 默认 `autocrlf=true`），打包产物内资产字节与本机 dev 不同——yaml 会把 frontmatter 末行孤立 `\r` 并进标量；行尾敏感解析必须解析层归一（`\r\n?`→`\n`）+ 资产侧 `.gitattributes` 钉 `eol=lf` 双保险。
- guard 类路径/字符串匹配器禁依赖 node 平台语义 API（`path.isAbsolute` 等）——同代码 Windows 绿 Linux 红；先统一分隔符再按自定义跨平台规则判定。
- 多行字符串字面量 `+` 拼接会被 oxfmt 折叠成单行、触发 no-useless-concat——夹具/多行串构造用 `['...', ...].join(...)`（与 no-nested-ternary 括号还原同属「格式器归化撞 lint」家族）。
- 空 catch 的合规写法 = 块内至少一条实语句（`return` / `console.warn`——no-silent-catch 的豁免判定看块内有无语句）；`oxlint-disable-next-line` 对它无效——报点锚在 CatchClause 起始行，写在块内的 disable 注释行号错位、形同虚设（.vue/.ts 同律）。
- 禁 `x!` 非空断言——正则匹配等可空结果先 `if (!m) throw new Error(...)` 守卫收窄，再索引。
- i18n 新键成对落地：en 源 `packages/vue/src/i18n/messages/<domain>.ts` + `locales/zh-cn/<domain>.json`；zh 译文 Latin+CJK 混排时同步登记 `tools/i18n/mixed-script-baseline.txt`——check:i18n 质量闸，漏登即红。
- 悬浮提示禁用 native `title` 属性（check:arch 硬拦）——一律 Tip 组件包裹。
- 工具 description 里的禁令必须配显式 GO 从句（「用户显式给出 X 时即调用」）——纯负面戒律会被模型误读成拒绝依据。

## 6. 测试纪律

- bun:test 框架；**禁引入 DOM 测试基建**（happy-dom/jsdom 一律不许）——浏览器行为用真浏览器实测（主 agent）。
- worker 只跑目标测试文件；全量单测用 `bun run test:unit:serial`（套件分批串行，带 `(i/N)` 批次进度），禁单次全仓 `bun test tests/engine`（单进程内存累积）。serial 可按批次过滤（`bun tools/unit-tests/src/serial.ts editor scene`，批次 = tests/engine 一级目录）——改动域明确时本地只跑受影响批次，全量交 CI（分片并行）或后台长跑。
- playwright（`test` / `test:figma`）主 agent 独占，与任何重型任务互斥。
- bun mock 生命周期：`mock.restore()` 只恢复 spy，**不撤销 `mock.module()` 覆盖**——模块级 mock 不随 cleanup 钩子隔离；引入全局/模块级插桩前先读现装 runner 的 mock 文档。
- globalThis 桩（fetch 等）的还原钩子禁放共享 helpers 的模块级 `afterEach`——bun 模块缓存致该钩子只随首个 import 者注册一次，第二消费者的桩无人还原、泄漏污染同进程分片后续全部 fetch；每个消费文件各自 `afterEach` 还原。
- 桩贴真实故障边界：协议/验真类路径桩全局 fetch（或 socket），不桩 SDK 方法——SDK 方法桩遵守 throw/成功契约，盖不住实现吞状态。
- 夹具用的虚空路径/名字必须在所有 CI 平台都不存在——`/etc/hosts/x` 在 Linux 是真实文件（报 ENOTDIR 而非 ENOENT）；虚空名用唯一造名。

## 7. 仓库地图

- `src/app/ai/pi-backend/` —— AI 后端（ownedRoot）：service / server / tools / transport / active-design-host / image-gen
- `src/app/ai/fork/` —— AI 前端 fork 层（ownedRoot）：transports / session 管理
- `src/app/bridge/` —— 自动化桥（ownedRoot）：server（browser-rpc 窗口路由）/ client / vite-plugin / runtime
- `src/components/assistant/` —— AI 助手 UI（ownedRoot）：ChatPanel / active-design / markdown
- `src/theme/` —— 双主题令牌（feedback / motion 等预设）。动效工具类用前必核主题层真实生成（tw-animate-css 仅 `animate-collapsible-*` 一族，其余 `animate-*` 来自 tailwind v4 core 的 theme.css，均可 grep 实证）——裸写未注册类名 = 死类名，无任何门禁可兜。
- `packages/core/src/text/` —— 文本与字体：font/cn-catalog（CN 目录）、web-font、fonts.ts 管理器
- `packages/core/src/tools/fork/` —— 工具 fork 层（ownedRoot）：marketing / brief / active-design
- `packages/scene-graph | pen | kiwi | fig | dom-css | vue` —— 基础库：场景图 / 画笔 / 约束求解 / fig 编解码 / DOM CSS / Vue 绑定
- `tests/engine/` —— 单测（`rebuild/` 子目录为 ownedRoot，其余 follow 上游）
- `tools/zone-registry/` —— zone 装备（zones.json + check.ts）
- `tools/hooks/` —— git 钩子（core.hooksPath 指向此）
- `tools/cn-font-catalog/` —— CN 字体目录离线管线
- `docs/` —— ownedRoot；`docs/archive/rebuild-campaign/` 为冻结历史档案，禁止引用为现行规则
- `.github/workflows/` —— CI（ownedRoot，纯 fork 治理设施）

## 8. CI

- CI 跑全量门禁（check + 测试）做最终裁决；本地分层拦截优先——改动域明确时单测只跑受影响批次（§6），大改动收口跑全量 check（§4）。
- CI 红灯先本地最小层复现再修；禁 `gh run rerun`。
