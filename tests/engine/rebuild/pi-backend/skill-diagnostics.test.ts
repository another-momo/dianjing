/**
 * skill-diagnostics 单测——双源扫描差集 + 诊断码声明集 ↔ emit 集严格相等。
 *
 * 测试 fixture：mkdtemp 建临时 rootDir（含 workspace/.agents/skills 与
 * builtin-studio/skills 两层）+ capabilities store 走真 loadSkillsFromDir。
 *
 * 分类语义对齐 SDK 真实拒收行为（SDK 仅因 description 空 / 解析抛错拒收；
 * name 缺失按目录名兜底加载、name 非法仅 warning 不拒收）：
 *  - parse-failed = 缺 SKILL.md / 无 frontmatter / SDK 解析抛错
 *  - no-description = description 缺失或为空导致未加载（SDK 拒收真因）
 *  - name-invalid = 已加载但生效 name 违反命名规则
 *  - shadowed-by-user = 内置件被用户层同名覆盖
 *
 * 防死码断言：静态扫描 skill-diagnostics.ts 源码（regex 抓 `code: 'xxx'`
 * emit 点）与 SKILL_DIAGNOSTIC_CODES 单源声明做严格相等校验——
 * 声明无 emit 或 emit 未登记即 fail。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SKILL_DIAGNOSTIC_CODES,
  collectSkillDiagnostics
} from '@/app/ai/pi-backend/skill-diagnostics'

let rootDir = ''
let builtinDir = ''

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'skdiag-root-'))
  builtinDir = mkdtempSync(join(tmpdir(), 'skdiag-builtin-'))
  // workspace/.agents/skills 双源用户层落点；builtin/skills 内置层落点
  mkdirSync(join(rootDir, 'workspace', '.agents', 'skills'), { recursive: true })
  mkdirSync(join(builtinDir, 'skills'), { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
  rmSync(builtinDir, { recursive: true, force: true })
})

/** 写一个用户层 skill（含 frontmatter + body） */
function writeUserSkill(
  name: string,
  opts: { description?: string; frontmatter?: string } = {}
): void {
  const dir = join(rootDir, 'workspace', '.agents', 'skills', name)
  mkdirSync(dir, { recursive: true })
  const fm =
    opts.frontmatter ?? `name: ${name}\ndescription: ${opts.description ?? `${name} 描述`}\n`
  writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}---\n\n正文\n`, 'utf8')
}

function writeBuiltinSkill(name: string, opts: { description?: string } = {}): void {
  const dir = join(builtinDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  const fm = `name: ${name}\ndescription: ${opts.description ?? `${name} 内置描述`}\n`
  writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}---\n\n正文\n`, 'utf8')
}

describe('防死码断言：声明集 ↔ emit 集严格相等', () => {
  test('SKILL_DIAGNOSTIC_CODES 静态声明 = skill-diagnostics.ts 源码 emit 集', () => {
    // 源码 grep 'code: \'<value>\'' 字面量字串——确保声明与实现两侧严格对齐
    // 用 readFileSync 直读源文件做静态扫描（无 AST 依赖）
    const sourcePath = join(
      import.meta.dir.replace(/\\/g, '/'),
      '../../../../src/app/ai/pi-backend/skill-diagnostics.ts'
    )
    const source = readFileSync(sourcePath, 'utf8')
    const emitSet = new Set<string>()
    const emitRegex = /code:\s*'([a-z-]+)'/g
    for (const m of source.matchAll(emitRegex)) {
      if (m[1]) emitSet.add(m[1])
    }
    const declared = new Set<string>(SKILL_DIAGNOSTIC_CODES)
    expect([...declared].sort()).toEqual([...emitSet].sort())
    // 双向：声明 ⊇ emit & emit ⊇ 声明（严格相等）
    for (const code of emitSet) expect(declared.has(code)).toBe(true)
    for (const code of declared) expect(emitSet.has(code)).toBe(true)
  })
})

describe('collectSkillDiagnostics 双源扫描差集', () => {
  test('空两层根 → 空诊断集', () => {
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    expect(result).toEqual([])
  })

  test('正常件 + 缺 SKILL.md 子目录 → parse-failed', () => {
    writeUserSkill('ok-skill')
    // 子目录无 SKILL.md
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'broken'), { recursive: true })
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.code).toBe('parse-failed')
    expect(result[0]?.skillName).toBe('broken')
  })

  test('SKILL.md 无 frontmatter → parse-failed', () => {
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'no-fm'), { recursive: true })
    writeFileSync(
      join(rootDir, 'workspace', '.agents', 'skills', 'no-fm', 'SKILL.md'),
      '正文\n',
      'utf8'
    )
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.code).toBe('parse-failed')
    expect(result[0]?.skillName).toBe('no-fm')
  })

  test('frontmatter 缺 name 但 description 合法 → SDK 按目录名兜底加载 → 无诊断', () => {
    // SDK 行为：name 缺失不拒收——按父目录名兜底加载（loadSkillFromFile 的
    // name = frontmatter.name || parentDirName）。件正常出现在清单，无需诊断。
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'dirname-fallback'), {
      recursive: true
    })
    writeFileSync(
      join(rootDir, 'workspace', '.agents', 'skills', 'dirname-fallback', 'SKILL.md'),
      '---\ndescription: 有描述没名字\n---\n\n正文\n',
      'utf8'
    )
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    expect(result).toEqual([])
  })

  test('frontmatter name 非法（大写）→ SDK 仅 warning 仍加载 → name-invalid', () => {
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'BadCase'), { recursive: true })
    writeFileSync(
      join(rootDir, 'workspace', '.agents', 'skills', 'BadCase', 'SKILL.md'),
      '---\nname: BadCase\ndescription: 大写非法\n---\n\n正文\n',
      'utf8'
    )
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.code).toBe('name-invalid')
    expect(result[0]?.skillName).toBe('BadCase')
  })

  test('缺 name 且目录名兜底后仍非法 → name-invalid', () => {
    // 目录名含空格大写 → SDK 兜底加载的生效 name 不合规
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'My Skill'), { recursive: true })
    writeFileSync(
      join(rootDir, 'workspace', '.agents', 'skills', 'My Skill', 'SKILL.md'),
      '---\ndescription: 目录名兜底\n---\n\n正文\n',
      'utf8'
    )
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.code).toBe('name-invalid')
    expect(result[0]?.skillName).toBe('My Skill')
  })

  test('description 为空 → SDK 拒收 → no-description（SDK 拒收真因）', () => {
    // SDK 行为：description 缺失/为空是唯一字段级拒收因（validateDescription）
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'empty-desc'), { recursive: true })
    writeFileSync(
      join(rootDir, 'workspace', '.agents', 'skills', 'empty-desc', 'SKILL.md'),
      '---\nname: empty-desc\ndescription: ""\n---\n\n正文\n',
      'utf8'
    )
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.code).toBe('no-description')
    expect(result[0]?.skillName).toBe('empty-desc')
  })

  test('正常件（合法 name + 非空 description）→ 无任何诊断', () => {
    writeUserSkill('has-desc', { description: '正常描述' })
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    expect(result).toEqual([])
  })

  test('内置层被用户层同名覆盖 → shadowed-by-user', () => {
    writeUserSkill('dup-name')
    writeBuiltinSkill('dup-name')
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    const shadowed = result.filter((d) => d.code === 'shadowed-by-user')
    expect(shadowed).toHaveLength(1)
    expect(shadowed[0]?.skillName).toBe('dup-name')
  })

  test('多层叠加：诊断按 (code, skillName) 排序稳定，四码可同屏出现', () => {
    // 用户层：2 个 parse-failed（缺 SKILL.md）+ 1 个 name-invalid（大写名）
    //        + 1 个 no-description（description 空）
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'no-md-1'), { recursive: true })
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'no-md-2'), { recursive: true })
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'BadName'), { recursive: true })
    writeFileSync(
      join(rootDir, 'workspace', '.agents', 'skills', 'BadName', 'SKILL.md'),
      '---\nname: BadName\ndescription: 大写名仍加载\n---\n\n正文\n',
      'utf8'
    )
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', 'no-desc'), { recursive: true })
    writeFileSync(
      join(rootDir, 'workspace', '.agents', 'skills', 'no-desc', 'SKILL.md'),
      '---\nname: no-desc\ndescription:\n---\n\n正文\n',
      'utf8'
    )
    // 内置层：1 个被用户层覆盖
    writeBuiltinSkill('dup')
    writeUserSkill('dup')

    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })

    // 验证排序稳定性
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1]
      const cur = result[i]
      if (!prev || !cur) continue
      const cmp = prev.code.localeCompare(cur.code)
      if (cmp === 0)
        expect((prev.skillName ?? '').localeCompare(cur.skillName ?? '')).toBeLessThanOrEqual(0)
    }
    // 四码同屏全有
    const codes = new Set(result.map((d) => d.code))
    expect(codes.has('parse-failed')).toBe(true)
    expect(codes.has('name-invalid')).toBe(true)
    expect(codes.has('no-description')).toBe(true)
    expect(codes.has('shadowed-by-user')).toBe(true)
  })

  test('下划线前缀子目录（_example 等内置模板）跳过——不出诊断', () => {
    mkdirSync(join(rootDir, 'workspace', '.agents', 'skills', '_example'), { recursive: true })
    // 即便 _example 缺 SKILL.md，也不应当诊断
    const result = collectSkillDiagnostics({
      userSkillsDir: join(rootDir, 'workspace', '.agents', 'skills'),
      builtinSkillsDir: join(builtinDir, 'skills')
    })
    expect(result).toEqual([])
  })
})
