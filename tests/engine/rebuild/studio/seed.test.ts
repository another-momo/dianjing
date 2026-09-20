/**
 * P2-11 seed 机制测试——ensureUserStudioSeed 的纯逻辑层。
 *
 * 真目录隔离：内置目录 = 当前 src 树（含 _example 模板），用户目录 = tmp
 * 空目录；不挂进 loadStudioFromDirs（避免测试副作用）。
 *
 * 用例：
 *   1. 空用户目录 → seed 复制两套模板、返回 seeded:true
 *   2. 已有 _example → no-op（不覆盖已存在内容）
 *   3. 复制后二次调用幂等
 *   4. 内置 _example 模板文件本身过 validate（合法 frontmatter）——属于契约钉扎
 *   5. 内置目录不存在 → no-op 不抛
 *   6. skills/ 空目录兜底：新用户 seed 后在位；已 seed 老用户（`_` 早返路径）也补齐
 *
 * `_` 前缀 id 的双保险：registry 扫描跳过 `_` 前缀目录（泳道 A 已落地，
 * 模板永不进 validate）；validate 层 isAssetId 仍拒绝 `_` 起头 id（首字符
 * 须为小写字母/数字）。本测试钉扎 validate 的拒绝行为作为第二道保险。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { splitFrontmatter } from '@/app/ai/pi-backend/studio/parse'
import { ensureUserStudioSeed } from '@/app/ai/pi-backend/studio/seed'
import { validateWorkflow, validateProfile } from '@/app/ai/pi-backend/studio/validate'

const BUILTIN_DIR = join(import.meta.dir, '../../../../src/app/ai/pi-backend/studio')

describe('ensureUserStudioSeed', () => {
  test('空用户目录 → 复制 workflows/_example + profiles/_example、返回 seeded:true', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'studio-seed-fresh-'))
    try {
      const result = ensureUserStudioSeed(userDir, BUILTIN_DIR)

      expect(result.seeded).toBe(true)
      expect(result.copied).toContain('_example')

      // 两套 _example 都应落地
      expect(existsSync(join(userDir, 'workflows/_example/workflow.md'))).toBe(true)
      expect(existsSync(join(userDir, 'profiles/_example/profile.md'))).toBe(true)

      // 复制内容字节相等（UTF-8 直接复制，无解析变形）
      const builtinWf = readFileSync(join(BUILTIN_DIR, 'workflows/_example/workflow.md'), 'utf8')
      const userWf = readFileSync(join(userDir, 'workflows/_example/workflow.md'), 'utf8')
      expect(userWf).toBe(builtinWf)

      const builtinPf = readFileSync(join(BUILTIN_DIR, 'profiles/_example/profile.md'), 'utf8')
      const userPf = readFileSync(join(userDir, 'profiles/_example/profile.md'), 'utf8')
      expect(userPf).toBe(builtinPf)
    } finally {
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  test('用户目录已有 _example → no-op 返回 seeded:false', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'studio-seed-existing-'))
    try {
      // 预先落一份用户改写过的工作流（与内置不同）
      mkdirSync(join(userDir, 'workflows/_example'), { recursive: true })
      const userCustomizedContent = '---\nid: _example\nlabel: 用户已改\n---\n\n用户改写过的正文\n'
      writeFileSync(join(userDir, 'workflows/_example/workflow.md'), userCustomizedContent, 'utf8')

      const result = ensureUserStudioSeed(userDir, BUILTIN_DIR)

      expect(result.seeded).toBe(false)
      expect(result.copied).toEqual([])
      expect(result.skipped).toContain('_example')

      // 用户改写的内容必须保留——seed 不覆盖
      const preserved = readFileSync(join(userDir, 'workflows/_example/workflow.md'), 'utf8')
      expect(preserved).toBe(userCustomizedContent)
    } finally {
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  test('复制后二次调用幂等（第二次 no-op）', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'studio-seed-idempotent-'))
    try {
      const first = ensureUserStudioSeed(userDir, BUILTIN_DIR)
      expect(first.seeded).toBe(true)

      const second = ensureUserStudioSeed(userDir, BUILTIN_DIR)
      expect(second.seeded).toBe(false)
      expect(second.copied).toEqual([])
      expect(second.skipped).toContain('_example')

      // 二次调用不污染首跑内容
      const userWf = readFileSync(join(userDir, 'workflows/_example/workflow.md'), 'utf8')
      const builtinWf = readFileSync(join(BUILTIN_DIR, 'workflows/_example/workflow.md'), 'utf8')
      expect(userWf).toBe(builtinWf)
    } finally {
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  test('内置目录不存在 → no-op 返回 seeded:false 不抛', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'studio-seed-no-builtin-'))
    try {
      const nonExistent = join(userDir, '__definitely_no_builtin__')
      const result = ensureUserStudioSeed(userDir, nonExistent)
      expect(result.seeded).toBe(false)
      expect(result.copied).toEqual([])
    } finally {
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  test('skills 空目录兜底：新用户在位 + 已 seed 老用户（`_` 早返路径）也补齐', () => {
    // 新用户：seed 顺带建空 skills/
    const freshDir = mkdtempSync(join(tmpdir(), 'studio-seed-skills-fresh-'))
    try {
      ensureUserStudioSeed(freshDir, BUILTIN_DIR)
      expect(existsSync(join(freshDir, 'skills'))).toBe(true)
    } finally {
      rmSync(freshDir, { recursive: true, force: true })
    }

    // 已 seed 老用户（`_` 前缀模板在位 → 复制路径早返）：升级后首跑仍须补 skills/
    const legacyDir = mkdtempSync(join(tmpdir(), 'studio-seed-skills-legacy-'))
    try {
      mkdirSync(join(legacyDir, 'workflows/_example'), { recursive: true })
      const result = ensureUserStudioSeed(legacyDir, BUILTIN_DIR)
      expect(result.seeded).toBe(false)
      expect(existsSync(join(legacyDir, 'skills'))).toBe(true)
    } finally {
      rmSync(legacyDir, { recursive: true, force: true })
    }
  })
})

describe('内置 _example 模板钉扎（frontmatter 形态）', () => {
  // 契约钉扎：_example 模板的 frontmatter 形态。结构泳道（泳道 A）已合并：
  // registry 扫描跳过 `_` 前缀目录，模板在生产路径永不进 validate；validate
  // 层 isAssetId 仍拒绝 `_` 起头 id（首字符须为小写字母/数字）——拒绝行为
  // 保留为双保险，本测试钉扎该方向。

  test('workflows/_example/workflow.md：frontmatter 解析成功 + validate 拒绝 `_` 前缀 id（双保险钉扎）', () => {
    const raw = readFileSync(join(BUILTIN_DIR, 'workflows/_example/workflow.md'), 'utf8')
    const parsed = splitFrontmatter(raw)
    if (!parsed.ok) throw new Error(`frontmatter 解析失败：${parsed.reason}`)

    const { issues } = validateWorkflow(parsed, '_example')
    // 当前行为：isAssetId 不允许下划线起头 → 必报 id 合法性 issue
    const idIssues = issues.filter((i) => i.reason.includes('不是合法机读 id'))
    expect(idIssues.length).toBeGreaterThan(0)
  })

  test('profiles/_example/profile.md：frontmatter 解析成功 + validate 拒绝 `_` 前缀 id（双保险钉扎）', () => {
    const raw = readFileSync(join(BUILTIN_DIR, 'profiles/_example/profile.md'), 'utf8')
    const parsed = splitFrontmatter(raw)
    if (!parsed.ok) throw new Error(`frontmatter 解析失败：${parsed.reason}`)

    // modes 字段已被 validate 识别（泳道 A 改名落地）；模板的 modes 示例
    // 默认注释，本钉扎只验 id 拒绝方向。
    const { issues } = validateProfile(parsed, '_example', new Set(['_example']))
    const idIssues = issues.filter((i) => i.reason.includes('不是合法机读 id'))
    expect(idIssues.length).toBeGreaterThan(0)
  })
})
