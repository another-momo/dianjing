/**
 * 2026-09-17 studio frontmatter CRLF 根治——回归门禁。
 *
 * 事故链：splitFrontmatter 剥 BOM 后按 `\n` 切行不剥 `\r`，CRLF 文件 frontmatter
 * 末行残留孤立 `\r` 进 YAML 文本 EOF，被 yaml 库并入最后一个标量。
 * `version: 2\r` → 字符串 "2\r"（typeof !== number）→ validate.parseVersion 拒绝
 * → profile 静默不注册。CI windows runner checkout（autocrlf 默认 true）把内置
 * studio md 转 CRLF 打进安装包 → v0.1.0-ci.4 安装版 profile 全灭；Windows 用户编辑
 * `%APPDATA%` 下的自定义资产同因撞。
 *
 * 本测试分三层钉扎：
 *  A. tmp fixture：CRLF profile + workflow 写盘 → loadStudioFromDirs 注册成功；
 *  B. unit 级 splitFrontmatter：孤立 `\r` 行尾同样归一（无 `\n` 跟随的纯 `\r`）；
 *  C. 真资产复制到 tmp 后强制 CRLF：递归 cp 内置 studio/ → tmp 目录 → 全部 LF 替
 *     CRLF → loadStudioFromDirs 注册零 failures（不动磁盘真文件）。
 *
 * 注：C 是 fixture 隔离的"真实资产形状"断言，与 builtin-assets.test.ts 的"默认
 * 零 failures 承重断言"是两条独立门禁——前者钉 CRLF，后者钉内容形态。本测试仅
 * 扩写 fixture，不改 builtin-assets.test.ts 的承重口径。
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Dirent
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { loadStudioFromDirs, type StudioRegistry } from '@/app/ai/pi-backend/studio'
import { splitFrontmatter } from '@/app/ai/pi-backend/studio/parse'

let builtinDir = ''
let userDir = ''

beforeEach(() => {
  builtinDir = mkdtempSync(join(tmpdir(), 'studio-crlf-builtin-'))
  userDir = mkdtempSync(join(tmpdir(), 'studio-crlf-user-'))
})

afterEach(() => {
  rmSync(builtinDir, { recursive: true, force: true })
  rmSync(userDir, { recursive: true, force: true })
})

function put(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

function loadBoth(): StudioRegistry {
  return loadStudioFromDirs(builtinDir, userDir)
}

// ── A. tmp fixture：CRLF profile + workflow 注册成功（事故形态直接复现）──

test('A: CRLF profile（version 押 frontmatter 末行）+ CRLF workflow 注册成功、failures 零', () => {
  // 事故形态：profile frontmatter 末行恰为 `version: N`——残留 `\r` 把 2 污染成 "2\r"
  const PROFILE_CRLF = [
    '---',
    'id: watercolor-poster-v3',
    'label: 水彩海报 v3',
    'modes: [longform]',
    'version: 3', // ← 末行残留 \r 进 YAML EOF
    '---',
    '',
    '## Fixed system',
    '',
    '水彩纸纹。',
    ''
  ].join('\r\n')

  const WORKFLOW_CRLF = [
    '---',
    'id: longform',
    'label: 长图设计',
    'subtitle: 电商详情 / 产品长文',
    'step_budget: 50',
    '---',
    '',
    '## 阶段定义',
    '',
    '阶段 0-4。',
    ''
  ].join('\r\n')

  const BASE_CRLF = ['---', 'id: base', '---', '', '## 红线', '', '事实零虚构。', ''].join('\r\n')

  put(builtinDir, 'base.md', BASE_CRLF)
  put(builtinDir, join('workflows', 'longform', 'workflow.md'), WORKFLOW_CRLF)
  put(builtinDir, join('profiles', 'watercolor-poster-v3', 'profile.md'), PROFILE_CRLF)

  const r = loadBoth()
  // failures 零 = 没有任何「version 不是正整数」「frontmatter 不是 map」之类漂红
  expect(r.failures).toEqual([])
  // 关键断言：profile 注册成功且 version 是 number 而非 "3\r"
  const profile = r.profiles.get('watercolor-poster-v3')
  expect(profile).toBeDefined()
  expect(profile?.version).toBe(3) // typeof === 'number' 的强钉
  expect(typeof profile?.version).toBe('number')
  expect(r.workflows.get('longform')?.stepBudget).toBe(50)
  expect(r.base?.id).toBe('base')
})

// ── B. unit 级 splitFrontmatter：孤立 \r（无 \n 跟随）同样归一 ──────────

test('B: splitFrontmatter 把孤立 \\r（无 \\n 跟随）也归一为 \\n', () => {
  // 极端：frontmatter 中间一行 `version: 2\r`（无 \n 跟随），但 frontmatter 块本身有
  // 闭合 `---`。归一前：`version: 2\r---` 是一整段，闭合 `---` 识别失败；归一后：
  // `version: 2\n---` 独立成行 + 闭合命中。
  const raw = '---\r\nid: probe\r\nlabel: 探针\r\nversion: 2\r---\r\n'
  const r = splitFrontmatter(raw)
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(`splitFrontmatter 失败：${r.reason}`)

  // 关键：version 是 number 2 而非字符串 "2\r"
  expect(r.frontmatter.version).toBe(2)
  expect(typeof r.frontmatter.version).toBe('number')
  expect(r.frontmatter.id).toBe('probe')
  expect(r.frontmatter.label).toBe('探针')
})

test('B: splitFrontmatter 处理 \\r\\n + 纯 \\r 混存的极端输入', () => {
  // 头几行 CRLF、夹一行只 \r 行尾——两种归一在同一文件里都生效
  const raw = '---\r\nid: mix\r\nlabel: 混\r\nversion: 5\r---\r\nbody 行\r\n'
  const r = splitFrontmatter(raw)
  expect(r.ok).toBe(true)
  if (!r.ok) throw new Error(`splitFrontmatter 失败：${r.reason}`)
  expect(r.frontmatter.version).toBe(5)
  // body 也归一为 LF
  expect(r.body).toBe('body 行\n')
})

// ── C. 真资产复制到 tmp 后强制 CRLF——直接钉扎本次 CI 事故 ─────────────

/** 把真内置资产目录递归 cp 到 dst 目录，再把所有文件的 LF 替换为 CRLF。 */
function cpBuiltinAsCrlf(dst: string): void {
  const BUILTIN = join(import.meta.dir, '../../../../src/app/ai/pi-backend/studio')
  cpSync(BUILTIN, dst, { recursive: true })
  // 递归遍历 dst 把每个文件读 → 替换 → 重写（仅 UTF-8 文本——本目录全 .md 无二进制）
  readdirSync(dst, { recursive: true, withFileTypes: true })
    .filter((e: Dirent) => e.isFile())
    .forEach((e: Dirent) => {
      const full = join(e.parentPath, e.name)
      const txt = readFileSync(full, 'utf8')
      // 把每个 \n 替换为 \r\n；已有的 \r\n 保留为 \r\n（替换 \n 不会重复加 \r）
      const crlf = txt.replace(/\r?\n/g, '\r\n')
      if (crlf !== txt) {
        writeFileSync(full, crlf, 'utf8')
      }
    })
}

test('C: 真内置资产复制到 tmp 后强制 CRLF——注册零 failures（本次事故直接钉扎）', () => {
  // 把真内置 studio/ 拷到 builtinDir，所有 .md 强制 CRLF；userDir 空
  cpBuiltinAsCrlf(builtinDir)
  const r = loadBoth()
  // 关键：CRLF 形态下全套真资产仍零失败——内置集 shape + 内容 + 引用全过
  expect(r.failures).toEqual([])
  // 进一步钉 version 是 number（事故形态核心：watercolor_poster_v2 profile 的
  // `version: 2` 末行残留 \r 进 YAML 后是否被吃）
  const profile = r.profiles.get('watercolor_poster_v2')
  expect(profile).toBeDefined()
  expect(profile?.version).toBe(2)
  expect(typeof profile?.version).toBe('number')
  // base 也注册成功
  expect(r.base?.id).toBe('base')
  // 至少一个 workflow 注册成功（防"全部被静默吞"的退化）
  expect(r.workflows.size).toBeGreaterThan(0)
  // general 首位保留
  expect(r.modes[0]?.id).toBe('general')
})
