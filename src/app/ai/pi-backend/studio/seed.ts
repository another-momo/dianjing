/**
 * P2-11 用户扩展 seed 机制——首次启动把内置 `_example` 模板复制到用户目录。
 *
 * 规格真源：docs/202609061800-prompt-assembly/202609061800-01-prompt-assembly-mechanism.md
 * §5.4 第 8 条「用户扩展维护支持」/ §8.2.8（同节）。
 *
 * 设计要点：
 * - 内置模板以 `_` 前缀命名（`_example`），registry 加载时跳过不注册——仅作
 *   复制源，用户首跑检测到用户扩展目录（2026-09-18 起 = `<状态根>/workspace/
 *   .agents`）下没有任何 `_` 前缀资产即递归复制整套 `_example`
 *   （workflows + profiles）。
 * - 纯逻辑、无 I/O 副作用外的依赖：用户目录路径由调用方注入，便于测试用临时
 *   目录；不挂进 loadStudioFromDirs（加载路径有测试用临时目录，副作用会污染）。
 * - 复制用 bun node:fs API，UTF-8 无关（纯文件复制，不读不解析）——避 GBK 链
 *   路误读事故。
 * - 幂等：检测到任一 `_` 前缀已存在即 no-op 返回 `{seeded: false}`；不增量
 *   覆盖（用户已改写的内容一律保留）。
 * - ai-panel-ux-consolidation：seed 同时落地 README.md（用户操作手册）；已存
 *   在则跳过（不覆盖用户改写）——与 `_example` 复制同纪律。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SeedResult {
  /** true = 本次调用执行了复制；false = 检测到已 seed，跳过 */
  seeded: boolean
  /** 实际复制过去的顶层资产目录名（如 `_example`） */
  copied: string[]
  /** 已存在的（被跳过的）顶层资产目录名 */
  skipped: string[]
}

/** 触发 seed 复制的内置资产顶层目录名清单。预留扩展位：未来加更多示例
 * 只需在此数组追加，不动调用方。 */
const SEED_TOP_DIRS = ['_example'] as const

/** 用户目录首次启动时落地的 README——中文操作手册（内嵌字符串，避免依赖
 *  额外文件）。SDK 真实加载约定见同模块头注（SKILL.md + frontmatter
 *  `description` 必填，`name` 可省略回退父目录名；顶层平铺或子目录递归）。
 *  2026-09-18 userdata 重排：用户层 = `<状态根>/workspace/.agents`（平铺，
 *  agent 会话 cwd 内；写侧被 key-guard deny——AI 只读，改动须用户手动）。 */
const README_CONTENT = `# 自定义拓展目录（.agents）

这是 Dianjing / OpenPencil 的本地扩展存放目录，位于应用数据根的
\`workspace/.agents\`（AI 会话的工作目录之内，命名对齐通行的 \`.agents\`
约定）。把 \`workflows/<id>/workflow.md\` / \`profiles/<id>/profile.md\` /
\`skills/<id>/SKILL.md\` 三类资产放在这里，AI 聊天代理会按内置 + 用户
两层覆盖规则读取——同名 id 用户版覆盖内置版。

> 安全边界：AI 代理对本目录**只读**——它可以看到这里的资产，但一切写入
> 都会被安全守卫拒绝。新增 / 修改 / 删除资产请用你的编辑器手动完成，
> 改完重启应用或等待下次会话生效。

## 三种资产形态

- **workflow**（agent mode）：\`workflows/<id>/workflow.md\`
  每个子目录是一份独立的 agent mode。\`id\` = 目录名（小写字母 / 数字 /
  连字符）；frontmatter 必填 \`label\` / 可选 \`subtitle\` / \`step_budget\` /
  \`sizes\`。
- **profile**（style profile）：\`profiles/<id>/profile.md\`
  每个子目录是一份独立风格档案。结构同 workflow，与 mode 配对使用。
- **skill**：\`skills/\` 下平铺 \`SKILL.md\` 或 \`<id>/SKILL.md\`
  SDK 扫到 \`SKILL.md\` 立即作为 skill 根（不继续递归）；子目录里再找
  \`SKILL.md\` 是另一份 skill。frontmatter 必填 \`description\`（\`name\`
  缺省回退父目录名）。无 description 的 SKILL.md 直接被 SDK 拒收。

## base.md 与按需参考

\`base.md\` 也可覆盖（放本目录根）：所有 mode 共享的行为基座，每回合注入。
base / workflow / profile 的 frontmatter 均可声明 \`references\` 按需参考
（\`[{path, description}]\`），agent 经 \`load_reference\` 工具按需读取——
path 相对该资产文件所在目录解析：用户覆盖 base.md 时，其 references 相对
**本目录**解析（如声明 \`references/xxx.md\` 即读本目录 \`references/xxx.md\`）。

## 起步

首跑已把内置 \`_example\` 复制到 \`workflows/\` 与 \`profiles/\`——
复制即改名改写（去掉 \`_\` 前缀、改目录名与 frontmatter \`id\` 即可
注册）。详细字段说明与可调样式见各文件头部注释。

> 本目录是单向用户面——删 \`_example\`、改写资产本体都不影响内置副本。
> 想要复位示例：删 \`_example\` 后重启应用即可重新复制。
`

/**
 * 把 `srcDir` 下 `entries` 命名的子目录递归复制到 `dstDir`。
 *  - entries 任意一个在 dstDir 已存在 → 整个调用视为「已 seed」，
 *    不复制任何条目（保留用户已改写内容）。
 *  - 不存在的全部复制过去。复制顺序按 entries 数组序写入。
 */
function seedEntries(
  srcDir: string,
  dstDir: string,
  entries: readonly string[]
): {
  copied: string[]
  skipped: string[]
} {
  const copied: string[] = []
  const skipped: string[] = []

  for (const name of entries) {
    const srcPath = join(srcDir, name)
    const dstPath = join(dstDir, name)

    if (!existsSync(srcPath)) {
      // 内置模板缺失（开发期误删等）——跳过该条目，不阻断其他条目
      continue
    }

    if (existsSync(dstPath)) {
      skipped.push(name)
      continue
    }

    mkdirSync(dstPath, { recursive: true })
    copyTree(srcPath, dstPath)
    copied.push(name)
  }

  return { copied, skipped }
}

/** 递归复制目录树（文件 → copyFileSync；目录 → mkdir + 递归）。 */
function copyTree(src: string, dst: string): void {
  const stat = statSync(src)
  if (stat.isFile()) {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    return
  }
  if (!stat.isDirectory()) return

  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    // 跳过 symlink：避免循环引用 + 跨设备边界；模板树不依赖符号链接
    if (entry.isSymbolicLink()) continue
    copyTree(join(src, entry.name), join(dst, entry.name))
  }
}

/**
 * 检测用户目录是否已有 `_` 前缀模板；无则从内置目录递归复制 `_example`。
 *
 * 调用方契约：
 *  - `userStudioDir`：用户扩展目录绝对路径（现行 = `<状态根>/workspace/.agents`，
 *    paths.ts USER_STUDIO_SUBPATH 单源）。若目录不存在本函数会创建它。
 *  - `builtinStudioDir`：内置 studio 目录绝对路径（含 `workflows/` `profiles/` 子目录）。
 *    缺失对应子目录视为「无内置模板可 seed」，跳过并返回。
 *
 * 返回值：
 *  - `{seeded: true, copied: [...], skipped: []}`：本次执行了复制；
 *  - `{seeded: false, copied: [], skipped: [...]}`：检测到已 seed（任一 `_`
 *    前缀目录已存在于用户侧），no-op；
 *  - 可预期情形（内置目录缺失 / 已 seed）不抛；文件系统错误（权限 / IO）
 *    会上抛——调用方（service.ts）已 try/catch 降级为 warn，不阻断启动。
 */
export function ensureUserStudioSeed(userStudioDir: string, builtinStudioDir: string): SeedResult {
  const empty: SeedResult = { seeded: false, copied: [], skipped: [] }

  // 早返：内置目录不存在 → 无可复制模板
  if (!existsSync(builtinStudioDir)) return empty

  // 检测用户目录：先建目录（首跑 userStudioDir 不存在是正常的，不是错误），
  // 再扫是否已有 `_` 前缀的子目录（workflows 或 profiles 任一侧即视为已 seed）。
  mkdirSync(userStudioDir, { recursive: true })

  // 写 README（已存在则跳过——不覆盖用户改写；与 `_example` 复制同纪律）
  const readmePath = join(userStudioDir, 'README.md')
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, README_CONTENT, 'utf8')
  }

  if (hasAnyUnderscoreDir(userStudioDir)) {
    return {
      seeded: false,
      copied: [],
      skipped: [...SEED_TOP_DIRS]
    }
  }

  // 内置两个分目录分别复制。任一侧 throw 会中断本次 seed——此处不包
  // try/catch，错误上抛由调用方（service.ts）捕获降级为 warn；seed 幂等，
  // 下次启动会重试未复制的部分。
  const workflowsResult = seedEntries(
    join(builtinStudioDir, 'workflows'),
    join(userStudioDir, 'workflows'),
    SEED_TOP_DIRS
  )
  const profilesResult = seedEntries(
    join(builtinStudioDir, 'profiles'),
    join(userStudioDir, 'profiles'),
    SEED_TOP_DIRS
  )

  return {
    seeded: workflowsResult.copied.length > 0 || profilesResult.copied.length > 0,
    copied: [...workflowsResult.copied, ...profilesResult.copied],
    skipped: [...workflowsResult.skipped, ...profilesResult.skipped]
  }
}

/** 检测 dir 下 workflows / profiles 任一侧是否已有 `_` 前缀子目录。 */
function hasAnyUnderscoreDir(dir: string): boolean {
  for (const sub of ['workflows', 'profiles']) {
    const subDir = join(dir, sub)
    if (!existsSync(subDir)) continue
    try {
      for (const entry of readdirSync(subDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('_')) return true
      }
    } catch (err) {
      // 权限/IO 错误：保守视为「无 _」，让后续复制尝试；不阻断启动
      console.warn(`[studio] seed 预检 _ 目录失败（按「无」继续）：${subDir}`, err)
    }
  }
  return false
}
