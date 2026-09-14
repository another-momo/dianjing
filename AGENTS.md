# OpenPencil（mode 分支）· 代码向导

> 本文件只装仓库普适事实（任何机器、任何 clone 位置都为真）。
> 协作机制（角色权限矩阵 / 资源治理 / 环境硬约束）不在本文件范围内，由本机工作台层承载。

## 1. 项目与分支拓扑

- AI 设计编辑器：Vue 3 + CanvasKit(Skia) 渲染 + pi-backend AI 后端 + 自动化桥（browser-rpc）。
- 集成分支 `rebuild/mode-arch`；与上游保持定期合并，文件所有权由 zone 登记制机器化管理（§3）。
- monorepo：bun workspaces；`packages/*` 为库，`src/` 为应用。

## 2. 协作摘要（最低限度规则）

- 主 agent 唯一允许：git 写（commit / merge-back）、browser 实测、gh 操作。
- worker（subagent）：限定范围实现 + 目标测试文件；**禁**全量 test / dev / build、commit / push、`gh run rerun`；browser 默认禁——Playwright MCP 与主 agent 共享浏览器单例，派单显式授权时方可自验证且须互斥。commit / push 可经 owner 专项派单授权解禁（授权范围以派单文本为准）。
- push：主 agent 每次收口 commit 后顺势推；失败允许重试 3 次、每次间隔 30s，仍败即积压归 owner 后续处理。worker 禁 push。
- gh 命令一律带 `-R another-momo/dianjing`。

## 3. zone 纪律（改代码前必读）

- `tools/zone-registry/zones.json` 是唯一所有权真相：`ownedRoots` / `ownedFiles` 内自由改；改动其他（上游供血）文件必须登记 `patches`；删除走 `deletedPaths`；搬移登记 `relocations`。台账登记与代码改动同批提交——漏登 = 交付不完整。
- pre-commit 强制 `check:zones`；`bun run check:zones:drift` 查看对上游漂移明细。
- `disposition: "revoked"` 的 patch **不提供覆盖**——改动曾 revoked 退役的文件（回 follow-pure）须新登 P-id，往 revoked 条目上追加备注不算登记（2026-09-14 合并 P144 实证）。
- 上游合并 SOP：合并前 check:zones 绿 → 按 zone 裁定冲突 → 合并窗口内每次 check:zones 输出的 RELOCATION_WATCH advisory 必读（上游残迹落进 ownedRoot 的最早信号），逐条裁定后再 commit → 合并后 ownedFiles 字节审计 + relocations / tarball 台账更新。裁撤目录必须以目录条目登记 deletedPaths——逐文件条目挡不住上游新增，目录条目才有 checkDeletedAbsent 复活硬拦截。
- `tools/zone-registry/` 自身与 `.github/workflows/` 均为 ownedRoot，fork 治理设施自由改。
- 设置类工作流归各业务域自己的 `settings/` 目录（`use.ts` 编排 + 兄弟模块分工、持久化留在 domain services），不建全局 composables 桶——采上游 2026-09 family 重组语义（上游原文以 src/app/ai/models/ 为例，该域 fork 已裁，语义仍适用于健在域）。

## 4. 提交与门禁

- commit 前必跑 `bun run format:check`（CI 红灯首要嫌疑，历史教训）。
- oxfmt 只格式化门禁覆盖内或本批新建的文件——覆盖外的既有文件（desktop-electron 等不在 format 门禁内的目录）顺手格式化制造纯噪音 diff（2026-09-14 ④ 实证：smoke 文件 12 行功能改动被手跑 oxfmt 膨胀成 124 行，`git show HEAD:file` 回滚）。
- commit 前 `git status` 核对无残留未暂存改动——pre-commit 门禁跑的是工作区，绿 ≠ 已入库（2026-09-08 事故：三文件台账改动未暂存，随 worktree 拆除灭失，CI 红一轮才兜住）。
- 日常收口门禁：`bun run check:quick`（format + lint + typecheck + zones 四步串行）。
- 变更集含 `.vue` 时收口补跑 `bun run check:vue`（约 72s，不进 check:quick 是刻意的——主 agent 收口职责，worker 无责）。
- 注意：本机 oxlint 目录取文件为 0（静默假绿，2026-09-07 起未定位）——本地 lint 结果不可信，lint 类门禁以 CI 为准。本地复现 CI lint 的替代法：`bunx oxlint -c oxlint.json --type-aware --type-check <单文件>`（单文件参数不受 0 文件问题影响）。CI lint 分两段不同规则集——src-only 311 条 type-aware / 含 tests 345 条，第二段有独有规则（4728a46d4 实证：optional 参数显式 undefined 第一段规则集复现不出）；逐文件复现先对照 CI 失败日志属哪一段，prefer-optional-chain 等 type-aware 规则只在第二段跑、第一段失败会屏蔽它。
- 大改动（≥10 文件或 ≥200 行）收口跑全量 `bun run check`，跑前停 dev server。
- studio 资产增删改名的耦合断言不止 tests/engine——`spikes/s-pi/backend-smoke/`（CI smoke:pi 契约层）直拷真资产目录并断言具体 id/数量/顺序；改资产同步扫 spikes/（2026-09-08 Phase 2 事故：派单 scope 只圈 tests/engine，CI 红一轮才浮出）。
- 状态根/目录布局/路径契约类改动同样必扫 spikes：`spikes/s-pi/backend-smoke/` 钉死 token/状态文件相对布局，且冒烟 spawn 后端不带 env 时后端状态根不再跟 cwd（2026-09-14 D2 实证：15 处布局钉 + 7 处 env 注入漏扫，CI 红一轮）。**sweep 输出禁截断**——`grep | head` 截断漏掉 t28 archiveDir 钉，本地复现二轮才兜住。
- commit message：中文 conventional（`type(scope): 主题`）+ 正文写清 why——背景、方案取舍、验证证据。
- pre-commit = check:zones；post-commit = 机制复盘计数提醒（advisory，永不阻塞）。

## 5. 高发门禁坑（写代码时防一手）

历史 CI 红的高频成因，皆为可机械判定的硬规则——写时避开，别等门禁拦：

- 禁 `as unknown as` 双断言；要精确类型用单断言或 helper（lint 硬规则）。
- 会被 node/测试环境加载的模块，访问 `window`/`document` 等浏览器全局前先 `typeof` 守卫（lint + 引擎测试）。
- 新增入口/脚本/测试文件在 knip.json tasklist 登记（knip）。
- 同形对象类型用别名复用，不另立字面量（type-shapes 门禁）。
- ≥10 行级相似块抽 helper，不复制粘贴（jscpd 克隆门禁）。
- 测试不读真实 env/浏览器全局，走注入与桩（引擎测试）。
- 第一方运行时校验用 Valibot；Zod 只留在要求它的 SDK 集成边界，不并行维护双 schema（采上游 2026-09-14 约定）。
- 多行 prompt 组合用 `dedent` 包，不手写转义换行串；成段散文留在属主 Markdown 源，组合不复制（studio 谱系同此原则）。
- Window API 增强归编译边界：app 声明在 `src/global.d.ts`、包级 DOM 缺口在属包 `global.d.ts`；禁在 spec 或实现模块里 `declare global`（本轮合并实证：browser-bridge 声明随上游重构迁居即此规则）。
- import 禁 `../` 逃逸 alias 根（`#tests/../vite` 式）；模块归属错位修归属，不修路径。
- vite.config.ts 加载链文件禁 `@/` alias：链 = vite.config → `vite/automation` + pi-backend/bridge 两个 vite-plugin → 其传递 import（如 `bridge/server/paths.ts`）——Storybook/vite config loader 不注册别名（2026-09-14 CI+dev 双实证漏网）。用相对 import：单个 `../` 直接写，`../../` 逐行注 `// oxlint-disable-next-line open-pencil/no-deep-parent-relative-imports`。
- Electron 主进程/sidecar 单文件产物必须显式 `deps.alwaysBundle` 兜底：tsdown 默认把根 package.json dependencies（含 workspace:* 的 `@open-pencil/*`）external 化，而打包形态 resources/app/ 无 node_modules（electron-builder.yml files 显式排除）——产物留裸 import，安装版主进程启动即炸 ERR_MODULE_NOT_FOUND；dev 形态仓根 node_modules 兜底会完美掩盖，只有打包 L3 能兜住（2026-09-14 ④ 实证，ff1b44d8d 修复）。

## 6. 测试纪律

- bun:test 框架；**禁引入 DOM 测试基建**（happy-dom/jsdom 一律不许）——浏览器行为用真浏览器实测（主 agent）。
- worker 只跑目标测试文件；全量单测用 `bun run test:unit:serial`（套件分批串行，带 `(i/N)` 批次进度），禁单次全仓 `bun test tests/engine`（单进程内存累积）。serial 可按批次过滤（`bun tools/unit-tests/src/serial.ts editor scene`，批次 = tests/engine 一级目录）——改动域明确时本地只跑受影响批次，全量交 CI（分片并行）或后台长跑。
- playwright（`test` / `test:figma`）主 agent 独占，与任何重型任务互斥。
- bun mock 生命周期：`mock.restore()` 只恢复 spy，**不撤销 `mock.module()` 覆盖**——模块级 mock 不随 cleanup 钩子隔离；引入全局/模块级插桩前先读现装 runner 的 mock 文档（采上游 2026-09-14 约定）。

## 7. 仓库地图

- `src/app/ai/pi-backend/` —— AI 后端（ownedRoot）：service / server / tools / transport / active-design-host / image-gen
- `src/app/ai/fork/` —— AI 前端 fork 层（ownedRoot）：transports / session 管理
- `src/app/bridge/` —— 自动化桥（ownedRoot）：server（browser-rpc 窗口路由）/ client / vite-plugin / runtime
- `src/components/assistant/` —— AI 助手 UI（ownedRoot）：ChatPanel / active-design / markdown
- `packages/core/src/text/` —— 文本与字体：font/cn-catalog（CN 目录）、web-font、fonts.ts 管理器
- `packages/core/src/tools/fork/` —— 工具 fork 层（ownedRoot）：marketing / brief / active-design
- `packages/scene-graph | pen | kiwi | fig | dom-css | vue` —— 基础库：场景图 / 画笔 / 约束求解 / fig 编解码 / DOM CSS / Vue 绑定
- `tests/engine/` —— 单测（`rebuild/` 子目录为 ownedRoot，其余 follow 上游）
- `tools/zone-registry/` —— zone 装备（zones.json + check.ts）
- `tools/hooks/` —— git 钩子（core.hooksPath 指向此）
- `tools/cn-font-catalog/` —— CN 字体目录离线管线
- `docs/` —— ownedRoot；`archive/rebuild-campaign/` 为冻结历史档案，禁止引用为现行规则
- `.github/workflows/` —— CI（ownedRoot，纯 fork 治理设施）

## 8. CI

- CI 跑全量门禁（check + 测试）做最终裁决；本地分层拦截优先——改动域明确时单测只跑受影响批次（§6），大改动收口跑全量 check（§4）。
- CI 红灯先本地最小层复现再修；禁 `gh run rerun`。
