/**
 * T43（S4 W1 / T-A1）studio 资产文件机制内核单测。
 *
 * 验收映射（T43-plan §4）：C1 两源扫描与同 id 覆盖 / C2 解析纪律 / C3 workflow
 * 校验 / C4 profile 校验 / C5 base 唯一性与 general 特例 / C6 reload 幂等与修复路径。
 * 全程 tmp fixture 目录，不依赖真实内置资产（T-A2/A4/A5 前内置目录为空是设计态）。
 *
 * P2-9（2026-09-07）：目录布局重组——资产本体在 `workflows/<id>/workflow.md` 与
 * `profiles/<id>/profile.md`（id = 目录名）。
 *
 * P2-4（2026-09-07）：profile frontmatter `applicable_to` → `modes`。
 *
 * P2-7（2026-09-07）：version/deprecated 通用化。
 *
 * P2-8（2026-09-07）：`hero_composition` 删除（fixture 与断言同步）。
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getStudioRegistry,
  loadStudioFromDirs,
  reloadStudio,
  type StudioRegistry
} from '@/app/ai/pi-backend/studio'

let builtinDir = ''
let userDir = ''

beforeEach(() => {
  builtinDir = mkdtempSync(join(tmpdir(), 'studio-builtin-'))
  userDir = mkdtempSync(join(tmpdir(), 'studio-user-'))
})

afterEach(() => {
  rmSync(builtinDir, { recursive: true, force: true })
  rmSync(userDir, { recursive: true, force: true })
})

function put(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

const BASE_MD = `---
id: base
label: 工作守则
---

## 红线

事实零虚构。
`

const LONGFORM_MD = `---
id: longform
label: 长图设计
subtitle: 电商详情 / 产品长文 / 小红书长图
step_budget: 50
sizes:
  - label: 电商详情长图
    canvas: 750x
  - label: 小红书长图
    canvas: 1080x
---

## 阶段定义

阶段 0-4。

## 画布尺寸

750 宽，高度随内容。

## 纪律

Fix Playbook。
`

const LONGFORM_SIZES = [
  { label: '电商详情长图', canvas: '750x' },
  { label: '小红书长图', canvas: '1080x' }
]

const PROFILE_MD = `---
id: watercolor-poster-v3
label: 水彩海报 v3
modes: [longform]
version: 3
deprecated: false
---

## Fixed system

水彩纸纹 + 手绘笔触。

## Variable system

主色倾向：青蓝 #a0c4e8。

## Anti-identity

不做廉价渐变。

## Tone

克制、留白。

## Recipe

按 longform 分区物化。
`

function loadBoth(): StudioRegistry {
  return loadStudioFromDirs(builtinDir, userDir)
}

// ── C1：两源扫描与同 id 覆盖 ──────────────────────────────────────────────

test('C1: 内置三类资产注册成功，modes 含 general + workflow 派生 mode', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(builtinDir, join('workflows', 'longform', 'workflow.md'), LONGFORM_MD)
  put(builtinDir, join('profiles', 'watercolor-poster-v3', 'profile.md'), PROFILE_MD)
  const r = loadBoth()
  expect(r.failures).toEqual([])
  expect(r.base?.origin).toBe('builtin')
  expect(r.workflows.get('longform')?.label).toBe('长图设计')
  expect(r.workflows.get('longform')?.stepBudget).toBe(50)
  expect(r.workflows.get('longform')?.sizes).toEqual(LONGFORM_SIZES)
  expect(r.profiles.get('watercolor-poster-v3')?.modes).toEqual(['longform'])
  expect(r.modes.map((m) => m.id)).toEqual(['general', 'longform'])
  expect(r.modes[0].source).toBe('general')
  // T65：sizes 透传进 mode 投影；general 无文件 → 无 sizes 字段
  expect(r.modes[1].sizes).toEqual(LONGFORM_SIZES)
  expect('sizes' in r.modes[0]).toBe(false)
})

test('C1: 用户目录同 id 覆盖内置（workflow 与 base 各一例），用户独有 profile 追加注册', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(builtinDir, join('workflows', 'longform', 'workflow.md'), LONGFORM_MD)
  put(
    userDir,
    join('workflows', 'longform', 'workflow.md'),
    LONGFORM_MD.replace('长图设计', '长图设计（用户改写）')
  )
  put(userDir, 'base.md', BASE_MD.replace('事实零虚构。', '用户守则优先。'))
  put(
    userDir,
    join('profiles', 'my-style', 'profile.md'),
    PROFILE_MD.replace('watercolor-poster-v3', 'my-style').replace('水彩海报 v3', '我的风格')
  )
  const r = loadBoth()
  expect(r.failures).toEqual([])
  expect(r.workflows.get('longform')?.label).toBe('长图设计（用户改写）')
  expect(r.workflows.get('longform')?.origin).toBe('user')
  expect(r.base?.origin).toBe('user')
  expect(r.base?.body).toContain('用户守则优先。')
  expect(r.profiles.get('my-style')?.origin).toBe('user')
})

test('C1: 用户目录不存在为正常态（只用内置集）', () => {
  put(builtinDir, 'base.md', BASE_MD)
  const r = loadStudioFromDirs(builtinDir, join(userDir, 'never-created'))
  expect(r.base?.id).toBe('base')
  expect(r.failures).toEqual([])
})

// T46（S4 W1 / T-A5 D-e）：base frontmatter schema 钉扎——id 可缺省（缺省即 base）、
// 免 label（BASE_MD 无 label 字段即注册成功，以上各测试已证）；但写了就必须是 `base`
test('C1: base frontmatter id 写错（非 base）→ 失败；缺省 id 与免 label 合法', () => {
  put(builtinDir, 'base.md', BASE_MD.replace('id: base', 'id: not-base'))
  let r = loadBoth()
  expect(r.base).toBeNull()
  expect(r.failures.some((f) => f.kind === 'base' && f.reason.includes('不是 `base`'))).toBe(true)

  // 缺省 id 合法（缺省即 base；BASE_MD 本就无 label——免 label 由全测试组共同钉扎）
  put(userDir, 'base.md', BASE_MD.replace('---\nid: base\n---\n', '---\n---\n'))
  r = loadBoth()
  expect(r.base?.id).toBe('base')
  expect(r.failures).toEqual([])
})

// P2-10 储备（2026-09-07）：`_` 前缀目录扫描跳过——为 P2-11 seed 模板让路
test('C1: workflows/_example 与 profiles/_seed 前缀目录扫描时跳过不注册', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(builtinDir, join('workflows', 'longform', 'workflow.md'), LONGFORM_MD)
  put(
    builtinDir,
    join('workflows', '_example', 'workflow.md'),
    LONGFORM_MD.replace('id: longform', 'id: _example').replace('长图设计', '示例')
  )
  put(
    builtinDir,
    join('profiles', '_seed', 'profile.md'),
    PROFILE_MD.replace('watercolor-poster-v3', '_seed').replace('水彩海报 v3', '种子')
  )
  const r = loadBoth()
  expect(r.failures).toEqual([])
  expect(r.workflows.has('_example')).toBe(false)
  expect(r.profiles.has('_seed')).toBe(false)
  expect(r.workflows.has('longform')).toBe(true)
})

// ── C2：解析纪律 ──────────────────────────────────────────────────────────

test('C2: 坏 frontmatter 不注册且 failures 带原因与指引，其余文件不受影响', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(builtinDir, join('workflows', 'longform', 'workflow.md'), LONGFORM_MD)
  put(builtinDir, join('workflows', 'no-frontmatter', 'workflow.md'), '## 直接正文\n\n没有头。\n')
  put(
    builtinDir,
    join('profiles', 'bad-yaml', 'profile.md'),
    '---\nid: bad-yaml\nlabel: [未闭合\n---\n\n## x\n'
  )
  put(builtinDir, join('profiles', 'list-fm', 'profile.md'), '---\n- 1\n- 2\n---\n\n## x\n')
  const r = loadBoth()
  expect(r.workflows.get('longform')).toBeDefined()
  expect(r.workflows.get('no-frontmatter')).toBeUndefined()
  expect(r.profiles.size).toBe(0)
  const reasons = r.failures.map((f) => `${f.path}::${f.reason}`)
  expect(reasons.some((s) => s.includes('no-frontmatter') && s.includes('缺 frontmatter'))).toBe(
    true
  )
  expect(reasons.some((s) => s.includes('bad-yaml') && s.includes('YAML 语法错误'))).toBe(true)
  expect(reasons.some((s) => s.includes('list-fm') && s.includes('不是键值 map'))).toBe(true)
  for (const f of r.failures) expect(f.hint.length).toBeGreaterThan(0)
})

// P2-9（2026-09-07）：id 一致性口径改为「id 必须等于所在目录名」（与文件名
// workflow.md/profile.md 解耦）
test('C2: frontmatter id 与所在目录名不一致 → 失败（覆盖引用一致性防线）', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(
    builtinDir,
    join('workflows', 'longform', 'workflow.md'),
    LONGFORM_MD.replace('id: longform', 'id: other-name')
  )
  const r = loadBoth()
  expect(r.workflows.size).toBe(0)
  expect(
    r.failures.some((f) => f.reason.includes('与所在目录名') && f.reason.includes('不一致'))
  ).toBe(true)
})

// ── C3：workflow 校验 ─────────────────────────────────────────────────────

// T62：types 校验段整体删除——frontmatter 残留旧 types 键不再参与校验（容忍
// 未知键，读穿侧同口径）；workflow 必填仅 id/label，step_budget/subtitle 保留
test('C3: 旧 types 键残留不影响注册；step_budget 非正整数 → 失败', () => {
  put(builtinDir, 'base.md', BASE_MD)
  // 旧档 frontmatter 残留 types 列表 → 不再校验、照常注册、不进 workflow 对象
  put(
    builtinDir,
    join('workflows', 'longform', 'workflow.md'),
    LONGFORM_MD.replace(
      'sizes:\n  - label: 电商详情长图\n    canvas: 750x\n  - label: 小红书长图\n    canvas: 1080x\n---',
      'types:\n  - id: ecommerce_detail\n    label: 电商详情页\n    size: 750x\n---'
    )
  )
  let r = loadBoth()
  expect(r.workflows.get('longform')?.label).toBe('长图设计')
  expect(r.workflows.get('longform')?.stepBudget).toBe(50)
  expect('types' in (r.workflows.get('longform') ?? {})).toBe(false)
  expect(r.failures).toEqual([])

  put(
    builtinDir,
    join('workflows', 'longform', 'workflow.md'),
    LONGFORM_MD.replace('step_budget: 50', 'step_budget: -3')
  )
  r = loadBoth()
  expect(r.failures.some((f) => f.reason.includes('step_budget'))).toBe(true)
})

// T65 §2.1：sizes 尺寸预设清单校验——非空 [{label, canvas}]，label 非空、
// canvas 格式 `宽x`/`宽x高`（解析单源 = core parseCanvasSize）；任一非法整条不注册
test('C3: sizes 合法清单注册并透传；缺席 → 无字段（缺省语义不变）', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(builtinDir, join('workflows', 'longform', 'workflow.md'), LONGFORM_MD)
  // 无 sizes 键的 workflow 照常注册（750 宽 HUG 缺省语义由 core 承载）
  put(
    builtinDir,
    join('workflows', 'plain', 'workflow.md'),
    LONGFORM_MD.replace('id: longform', 'id: plain')
      .replace('label: 长图设计', 'label: 朴素')
      .replace(
        'sizes:\n  - label: 电商详情长图\n    canvas: 750x\n  - label: 小红书长图\n    canvas: 1080x\n',
        ''
      )
  )
  const r = loadBoth()
  expect(r.failures).toEqual([])
  expect(r.workflows.get('longform')?.sizes).toEqual(LONGFORM_SIZES)
  expect('sizes' in (r.workflows.get('plain') ?? {})).toBe(false)
  expect('sizes' in (r.modes.find((m) => m.id === 'plain') ?? {})).toBe(false)
})

test('C3: sizes 非法形态 → 不注册 + failure 带指引（非清单/空清单/非键值条目）', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(
    builtinDir,
    join('workflows', 'longform', 'workflow.md'),
    LONGFORM_MD.replace(
      'sizes:\n  - label: 电商详情长图\n    canvas: 750x\n  - label: 小红书长图\n    canvas: 1080x',
      'sizes: 750x'
    )
  )
  let r = loadBoth()
  expect(r.workflows.size).toBe(0)
  expect(r.failures.some((f) => f.reason.includes('`sizes` 不是非空预设清单'))).toBe(true)

  put(
    builtinDir,
    join('workflows', 'longform', 'workflow.md'),
    LONGFORM_MD.replace(
      'sizes:\n  - label: 电商详情长图\n    canvas: 750x\n  - label: 小红书长图\n    canvas: 1080x',
      'sizes: []'
    )
  )
  r = loadBoth()
  expect(r.failures.some((f) => f.reason.includes('不是非空预设清单'))).toBe(true)

  put(
    builtinDir,
    join('workflows', 'longform', 'workflow.md'),
    LONGFORM_MD.replace(
      'sizes:\n  - label: 电商详情长图\n    canvas: 750x\n  - label: 小红书长图\n    canvas: 1080x',
      'sizes:\n  - 750x'
    )
  )
  r = loadBoth()
  expect(r.failures.some((f) => f.reason.includes('非键值条目'))).toBe(true)
  for (const f of r.failures) expect(f.hint.length).toBeGreaterThan(0)
})

test('C3: sizes 条目级非法 → 不注册（缺 label / label 空 / canvas 格式非法）', () => {
  put(builtinDir, 'base.md', BASE_MD)
  const withSizes = (sizesYaml: string) =>
    LONGFORM_MD.replace(
      'sizes:\n  - label: 电商详情长图\n    canvas: 750x\n  - label: 小红书长图\n    canvas: 1080x',
      sizesYaml
    )

  put(
    builtinDir,
    join('workflows', 'longform', 'workflow.md'),
    withSizes('sizes:\n  - canvas: 750x')
  )
  let r = loadBoth()
  expect(r.workflows.size).toBe(0)
  expect(r.failures.some((f) => f.reason.includes('缺 `label`'))).toBe(true)

  put(
    builtinDir,
    join('workflows', 'longform', 'workflow.md'),
    withSizes('sizes:\n  - label: ""\n    canvas: 750x')
  )
  r = loadBoth()
  expect(r.failures.some((f) => f.reason.includes('缺 `label` 或为空'))).toBe(true)

  // canvas 非法三例：非数字宽 / 缺 x / 三段
  for (const bad of ['abc', '750', '750x2000x3']) {
    put(
      builtinDir,
      join('workflows', 'longform', 'workflow.md'),
      withSizes(`sizes:\n  - label: 电商详情长图\n    canvas: ${bad}`)
    )
    r = loadBoth()
    expect(r.workflows.size).toBe(0)
    expect(
      r.failures.some(
        (f) => f.reason.includes('canvas 格式非法') && f.reason.includes('电商详情长图')
      )
    ).toBe(true)
  }

  // 定高预设合法（`宽x高`）
  put(
    builtinDir,
    join('workflows', 'longform', 'workflow.md'),
    withSizes('sizes:\n  - label: 定高详情\n    canvas: 750x2000')
  )
  r = loadBoth()
  expect(r.failures).toEqual([])
  expect(r.workflows.get('longform')?.sizes).toEqual([{ label: '定高详情', canvas: '750x2000' }])
})

// ── C4：profile 校验 ──────────────────────────────────────────────────────

// P2-5（2026-09-07）：节结构不再锁定 + findInvalidHex + collectFontRefs 移除。
// P2-4：profile `applicable_to` → `modes`；P2-7：version/deprecated 通用化。
test('C4: 节结构不再锁定——profile 任意节集（含全空）合法注册；只校验 modes', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(builtinDir, join('workflows', 'longform', 'workflow.md'), LONGFORM_MD)

  // ① 节全空（只剩 frontmatter）——合法
  put(
    builtinDir,
    join('profiles', 'watercolor-poster-v3', 'profile.md'),
    `---\nid: watercolor-poster-v3\nlabel: 水彩海报 v3\nmodes: [longform]\nversion: 3\n---\n`
  )
  let r = loadBoth()
  expect(r.profiles.size).toBe(1)
  expect(r.failures).toEqual([])

  // ② 节全删——同上合法（deprecated 通用化也对 profile 生效）
  put(
    builtinDir,
    join('profiles', 'watercolor-poster-v3', 'profile.md'),
    `---\nid: watercolor-poster-v3\nlabel: 水彩海报 v3\nmodes: [longform]\nversion: 3\ndeprecated: true\n---\n\n没有节。\n`
  )
  r = loadBoth()
  expect(r.profiles.size).toBe(1)
  expect(r.profiles.get('watercolor-poster-v3')?.deprecated).toBe(true)
  expect(r.failures).toEqual([])
})

test('C4: modes 引用不存在的 mode → 失败；general 与真实 workflow 合法；缺省 = 所有 mode', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(
    builtinDir,
    join('profiles', 'watercolor-poster-v3', 'profile.md'),
    PROFILE_MD.replace('[longform]', '[kv]')
  )
  let r = loadBoth()
  expect(r.profiles.size).toBe(0)
  expect(r.failures.some((f) => f.reason.includes('不存在的 mode「kv」'))).toBe(true)

  put(builtinDir, join('workflows', 'longform', 'workflow.md'), LONGFORM_MD)
  put(
    builtinDir,
    join('profiles', 'watercolor-poster-v3', 'profile.md'),
    PROFILE_MD.replace('[longform]', '[general, longform]')
  )
  r = loadBoth()
  expect(r.profiles.size).toBe(1)

  // P2-4：缺省 modes 或空数组 = 所有 mode 可用（无限制）
  put(
    builtinDir,
    join('profiles', 'watercolor-poster-v3', 'profile.md'),
    `---\nid: watercolor-poster-v3\nlabel: 水彩海报 v3\n---\n\n无 modes 字段。\n`
  )
  r = loadBoth()
  expect(r.profiles.size).toBe(1)
  expect(r.profiles.get('watercolor-poster-v3')?.modes).toEqual([])
})

// P2-5（2026-09-07）：findInvalidHex + collectFontRefs 已移除——保留作为反向钉扎
test('C4: P2-5 移除 hex 侦测 + 字体白名单后——profile body / frontmatter 含 hex/字体字段不报错', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(builtinDir, join('workflows', 'longform', 'workflow.md'), LONGFORM_MD)
  put(
    builtinDir,
    join('profiles', 'watercolor-poster-v3', 'profile.md'),
    PROFILE_MD.replace('#a0c4e8', '#a0c4e') // 启发式 hex 笔误——P2-5 后不再拦
  )
  let r = loadBoth()
  expect(r.profiles.size).toBe(1)
  expect(r.failures.some((f) => f.reason.includes('非法 hex'))).toBe(false)

  put(
    builtinDir,
    join('profiles', 'watercolor-poster-v3', 'profile.md'),
    PROFILE_MD.replace(
      '主色倾向：青蓝 #a0c4e8。',
      '主色倾向：青蓝 #a0c4e8 / 辅助 #fff / 候选 #1 稿。'
    )
  )
  r = loadBoth()
  expect(r.failures).toEqual([])

  put(
    builtinDir,
    join('profiles', 'watercolor-poster-v3', 'profile.md'),
    PROFILE_MD.replace('latin_pairing: Alibaba PuHuiTi', 'latin_pairing: No Such Font Family')
  )
  r = loadBoth()
  expect(r.profiles.size).toBe(1)
  expect(r.failures.some((f) => f.reason.includes('不在字体注册表白名单'))).toBe(false)
})

// ── C5：base 唯一性与 general 特例 ────────────────────────────────────────

test('C5: 双源皆无 base → failures 记缺失态；默认集全坏 → 记整体态', () => {
  const r = loadBoth()
  expect(r.base).toBeNull()
  expect(r.failures.some((f) => f.kind === 'base' && f.reason.includes('base.md 缺失'))).toBe(true)
  // 空双目录即产生 2 条 failure（base 缺失 + studio 整体态）；再塞坏文件，整体态仍在
  put(builtinDir, join('workflows', 'broken', 'workflow.md'), '无 frontmatter')
  const r2 = loadBoth()
  expect(r2.failures.some((f) => f.kind === 'studio' && f.reason.includes('整体缺失'))).toBe(true)
})

test('C5: general mode 恒在且无文件', () => {
  const r = loadBoth()
  const general = r.modes.find((m) => m.id === 'general')
  expect(general).toBeDefined()
  expect(general?.source).toBe('general')
  expect(r.workflows.get('general')).toBeUndefined()
})

// ── C6：reload 幂等与修复路径 ─────────────────────────────────────────────

test('C6: loadStudioFromDirs 幂等；文件修复后重载反映新态', () => {
  put(builtinDir, 'base.md', BASE_MD)
  put(builtinDir, join('workflows', 'broken', 'workflow.md'), '无 frontmatter')
  let r = loadBoth()
  expect(r.workflows.size).toBe(0)
  expect(r.failures.length).toBeGreaterThan(0)

  // 修复 → 重载 → 注册成功且 failure 消失
  put(
    builtinDir,
    join('workflows', 'broken', 'workflow.md'),
    LONGFORM_MD.replace('id: longform', 'id: broken').replace('label: 长图设计', 'label: 修复件')
  )
  r = loadBoth()
  expect(r.workflows.get('broken')?.label).toBe('修复件')
  expect(r.failures).toEqual([])

  // 删除 → 重载 → mode 消失
  rmSync(join(builtinDir, 'workflows', 'broken'), { recursive: true, force: true })
  r = loadBoth()
  expect(r.modes.map((m) => m.id)).toEqual(['general'])
})

test('C6: reloadStudio(rootDir) 与 getStudioRegistry(rootDir) 走约定目录', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'studio-root-'))
  try {
    put(rootDir, join('src', 'app', 'ai', 'pi-backend', 'studio', 'base.md'), BASE_MD)
    const r = reloadStudio(rootDir)
    expect(r.base?.body).toContain('事实零虚构。')
    expect(getStudioRegistry(rootDir).base?.id).toBe('base')
    expect(getStudioRegistry().base?.id).toBe('base')
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('C6: DIANJING_STUDIO_BUILTIN_DIR 覆盖内置目录解析（Electron 打包形态宿主注入）', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'studio-root-'))
  const envDir = mkdtempSync(join(tmpdir(), 'studio-env-builtin-'))
  try {
    // rootDir 约定目录留空、env 目录放 base——注册成功即证明 env 覆盖生效
    put(envDir, 'base.md', BASE_MD)
    process.env.DIANJING_STUDIO_BUILTIN_DIR = envDir
    const r = reloadStudio(rootDir)
    expect(r.base?.id).toBe('base')
    expect(getStudioRegistry(rootDir).base?.body).toContain('事实零虚构。')
  } finally {
    delete process.env.DIANJING_STUDIO_BUILTIN_DIR
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(envDir, { recursive: true, force: true })
  }
})
