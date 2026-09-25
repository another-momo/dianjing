/**
 * T87：capabilities store 单测——缺省 DEFAULTS（2026-09-22 翻转 full+true）、set/get 往返、坏 JSON 降级、
 * listSkills 仅在 ON 时扫 + 双源去重 + 脱敏白名单。
 * T96：v2 形状（builtinTools 三档 + agentSkills 解耦）+ v1→v2 读盘迁移钉扎。
 * T91o：expandSkillText 宿主侧展开——OFF 透传 / 贴中文展开 / 多 skill /
 * 未知名透传。
 *
 * 测试 fixture：mkdtemp 建临时 agentDir + rootDir；capabilities store 与
 * 真 pi SDK loadSkillsFromDir 协作（这是核心机制，不 mock）。
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCapabilitiesStore } from '@/app/ai/pi-backend/capabilities'

let rootDir = ''
let agentDir = ''

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'cap-root-'))
  agentDir = join(rootDir, 'pi-agent')
  mkdirSync(agentDir, { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

test('T87 缺省：capabilities.json 不存在 → DEFAULTS（2026-09-22 翻转 full+true）', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
  expect(store.listSkills()).toEqual([])
  // 未触发写入（缺省走读 fail-safe，不应副作用生成 capabilities.json）
  expect(existsSync(join(agentDir, 'capabilities.json'))).toBe(false)
})

test('T87 写读往返：set ON → get ON；文件落盘 0o600 含 version+builtinTools+agentSkills', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  const next = store.set({ agentSkills: true })
  // T96：builtinTools 缺省保留旧值（缺省 'full'）——set 只写 agentSkills 的兼容面
  expect(next).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
  expect(store.get()).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })

  // 重新构造读面（验落盘而非仅内存缓存）
  const reread = createCapabilitiesStore({ agentDir, rootDir })
  expect(reread.get()).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })

  // 文件结构钉扎（T96：写盘恒 version:3）
  const raw = JSON.parse(readFileSync(join(agentDir, 'capabilities.json'), 'utf8')) as unknown
  expect((raw as { version: number }).version).toBe(3)
  expect((raw as { builtinTools: string }).builtinTools).toBe('full')
  expect((raw as { agentSkills: boolean }).agentSkills).toBe(true)
})

test('T96 写读往返：三档位 builtinTools 落盘回读', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.set({ agentSkills: false, builtinTools: 'readonly' })).toEqual({
    builtinTools: 'readonly',
    agentSkills: false,
    disabledSkills: []
  })
  expect(store.set({ agentSkills: true, builtinTools: 'full' })).toEqual({
    builtinTools: 'full',
    agentSkills: true,
    disabledSkills: []
  })
  const reread = createCapabilitiesStore({ agentDir, rootDir })
  expect(reread.get()).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
})

test('T87 坏 JSON 降级：写入非 JSON 内容 → 下次构造读 DEFAULTS', () => {
  writeFileSync(join(agentDir, 'capabilities.json'), '{not-json}', 'utf8')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
  expect(store.listSkills()).toEqual([])
})

test('T87 缺字段降级：写入空对象 → DEFAULTS', () => {
  writeFileSync(join(agentDir, 'capabilities.json'), '{}', 'utf8')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
})

test('T96 v1→v2 迁移：version:1 + agentSkills:true → builtinTools full（旧同闸语义）', () => {
  writeFileSync(
    join(agentDir, 'capabilities.json'),
    JSON.stringify({ version: 1, agentSkills: true }),
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
})

test('T96 v1→v2 迁移：version:1 + agentSkills:false → builtinTools off', () => {
  writeFileSync(
    join(agentDir, 'capabilities.json'),
    JSON.stringify({ version: 1, agentSkills: false }),
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'off', agentSkills: false, disabledSkills: [] })
  // 迁移后的首次写盘升级文件形状到 v3
  store.set({ agentSkills: false })
  const raw = JSON.parse(readFileSync(join(agentDir, 'capabilities.json'), 'utf8')) as {
    version: number
  }
  expect(raw.version).toBe(3)
})

test('T96 v2 非法 builtinTools → 降级 DEFAULTS（坏档位不残留）', () => {
  writeFileSync(
    join(agentDir, 'capabilities.json'),
    JSON.stringify({ version: 2, builtinTools: 'everything', agentSkills: true }),
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
})

test('T87 set 校验：agentSkills 非布尔 → 抛错且不写盘', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(() => store.set({ agentSkills: 'yes' })).toThrow(/boolean/)
  expect(() => store.set({ agentSkills: 1 })).toThrow(/boolean/)
  expect(() => store.set({ agentSkills: null })).toThrow(/boolean/)
  // 没副作用落盘
  expect(existsSync(join(agentDir, 'capabilities.json'))).toBe(false)
})

test('T96 set 校验：builtinTools 非法 → 抛错且不写盘', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(() => store.set({ agentSkills: true, builtinTools: 'write' })).toThrow(/builtinTools/)
  expect(() => store.set({ agentSkills: true, builtinTools: 1 })).toThrow(/builtinTools/)
  expect(() => store.set({ agentSkills: true, builtinTools: true })).toThrow(/builtinTools/)
  expect(existsSync(join(agentDir, 'capabilities.json'))).toBe(false)
})

test('T96 set 缺省 builtinTools → 保留旧值（部分更新语义）', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true, builtinTools: 'readonly' })
  const next = store.set({ agentSkills: false })
  expect(next).toEqual({ builtinTools: 'readonly', agentSkills: false, disabledSkills: [] })
})

test('T87 listSkills：OFF 时空集（不泄露已扫到 skill 存在性）', () => {
  // 即便 skills/ 有 SKILL.md，OFF 时 listSkills 也必须空集
  const userSkillsDir = join(rootDir, 'workspace', '.agents', 'skills', 'demo')
  mkdirSync(userSkillsDir, { recursive: true })
  writeFileSync(
    join(userSkillsDir, 'SKILL.md'),
    `---
name: demo
description: 测试
---

正文
`,
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: false })
  expect(store.listSkills()).toEqual([])
})

test('T87 listSkills：ON 时扫 workspace/.agents/skills（2026-09-18 重排单源）+ 脱敏', () => {
  // T89 → D2：单源扫描 skills（扁平化后直接挂 rootDir）；原双源去重测试
  // 不再适用（同名 demo 在单源下不可能双份；保留 name 投影 + 脱敏两条核心断言）
  const userDir = join(rootDir, 'workspace', '.agents', 'skills', 'demo')
  mkdirSync(userDir, { recursive: true })
  writeFileSync(
    join(userDir, 'SKILL.md'),
    `---
name: demo
description: 用户侧 demo
---

正文
`,
    'utf8'
  )
  const otherDir = join(rootDir, 'workspace', '.agents', 'skills', 'other')
  mkdirSync(otherDir, { recursive: true })
  writeFileSync(
    join(otherDir, 'SKILL.md'),
    `---
name: other
description: 另一份
---

正文
`,
    'utf8'
  )

  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true })
  const skills = store.listSkills()

  const names = skills.map((s) => s.name).sort()
  expect(names).toEqual(['demo', 'other'])
  const demo = skills.find((s) => s.name === 'demo')
  expect(demo?.description).toBe('用户侧 demo')

  // 脱敏：每条只含 name + description
  for (const s of skills) {
    expect(Object.keys(s).sort()).toEqual(['description', 'name'])
  }
})

test('T87 listSkills：disable-model-invocation 的 skill 也进清单（描述可空兜底）', () => {
  const userDir = join(rootDir, 'workspace', '.agents', 'skills', 'hidden')
  mkdirSync(userDir, { recursive: true })
  writeFileSync(
    join(userDir, 'SKILL.md'),
    `---
name: hidden
description: 显式调用专用
disable-model-invocation: true
---

正文
`,
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true })
  const skills = store.listSkills()
  expect(skills.map((s) => s.name)).toEqual(['hidden'])
  expect(skills[0].description).toBe('显式调用专用')
})

test('T87 listSkills：缺 description → SDK 拒收不进清单（description 是 frontmatter 必填）', () => {
  // pi SDK 实证：loadSkillsFromDir 要求 SKILL.md frontmatter name + description
  // 齐备；缺 description 即非法，被丢弃不进结果。我们的脱敏兜空只兜 store
  // 收到非法描述的情况（manifest 投影层），不进 SDK 扫描。
  const userDir = join(rootDir, 'workspace', '.agents', 'skills', 'no-desc')
  mkdirSync(userDir, { recursive: true })
  writeFileSync(
    join(userDir, 'SKILL.md'),
    `---
name: no-desc
---

正文
`,
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true })
  expect(store.listSkills()).toEqual([])
})

// ── T91o：expandSkillText 宿主侧展开（解除 SDK「仅开头 + 单命令」双限制） ──

/** 造一个含 frontmatter + 正文的临时 skill，返其目录 */
function writeSkill(name: string, body: string): void {
  const dir = join(rootDir, 'workspace', '.agents', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n${body}\n`,
    'utf8'
  )
}

test('T91o expandSkillText：agentSkills OFF → 原文透传（与 SDK noSkills 同语义）', () => {
  writeSkill('demo', 'DEMO 正文')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: false })
  expect(store.expandSkillText('/skill:demo 画图')).toBe('/skill:demo 画图')
})

test('T91o expandSkillText：名后直接贴中文（无空格）也展开，块与正文空行分隔', () => {
  // owner 情况①：SDK 契约下 skillName 会吞掉整段正文查无此 skill 透传
  writeSkill('demo', 'DEMO 正文')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true })
  const out = store.expandSkillText('/skill:demo使用这个技能生成一张小猫图片')
  expect(out).toContain('<skill name="demo"')
  expect(out).toContain('DEMO 正文')
  expect(out).toContain('</skill>\n\n使用这个技能生成一张小猫图片')
  // frontmatter 不进展开体
  expect(out).not.toContain('description:')
})

test('T91o expandSkillText：句中/句尾提及就地展开；一条消息可激活多个 skill', () => {
  // owner 情况② + 多 skill：SDK 单命令契约下句中/句尾整条透传
  writeSkill('aaa', 'AAA 正文')
  writeSkill('bbb', 'BBB 正文')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true })

  const tail = store.expandSkillText('生成一只小猫图片 /skill:aaa')
  // 前文已有空格分隔 → 不再插空行，块原位展开
  expect(tail.startsWith('生成一只小猫图片 <skill name="aaa"')).toBe(true)
  expect(tail).toContain('AAA 正文')

  const multi = store.expandSkillText('/skill:aaa 和 /skill:bbb 各出一张')
  expect(multi).toContain('<skill name="aaa"')
  expect(multi).toContain('AAA 正文')
  expect(multi).toContain('<skill name="bbb"')
  expect(multi).toContain('BBB 正文')
  // 两 skill 块之间的正文保留
  expect(multi).toContain('</skill> 和 ')
})

test('T91o expandSkillText：未知 skill 名透传；无 /skill: 提及原文不动', () => {
  writeSkill('demo', 'DEMO 正文')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true })
  expect(store.expandSkillText('/skill:ghost 不存在')).toBe('/skill:ghost 不存在')
  expect(store.expandSkillText('普通消息')).toBe('普通消息')
})

// ── 内置层合并（layer-splitting 等内置 skill 进 chips 清单 + 宿主展开面） ──

/** 造一个内置层临时 skill（builtinSkillsDir/<name>/SKILL.md） */
function writeBuiltinSkill(builtinSkillsDir: string, name: string, body: string): void {
  const dir = join(builtinSkillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 内置描述\n---\n\n${body}\n`,
    'utf8'
  )
}

test('内置层 listSkills：用户层为空时内置 skill 也进清单（脱敏白名单同约束）', () => {
  const builtinSkillsDir = join(rootDir, 'builtin-studio', 'skills')
  writeBuiltinSkill(builtinSkillsDir, 'layer-splitting', '内置正文')
  const store = createCapabilitiesStore({ agentDir, rootDir, builtinSkillsDir })
  store.set({ agentSkills: true })
  const skills = store.listSkills()
  expect(skills).toEqual([{ name: 'layer-splitting', description: 'layer-splitting 内置描述' }])
})

test('内置层 listSkills：同名冲突用户层赢（与 SDK collision 先扫者赢同语义）', () => {
  const builtinSkillsDir = join(rootDir, 'builtin-studio', 'skills')
  writeSkill('demo', '用户侧正文')
  writeBuiltinSkill(builtinSkillsDir, 'demo', '内置侧正文')
  const store = createCapabilitiesStore({ agentDir, rootDir, builtinSkillsDir })
  store.set({ agentSkills: true })
  const skills = store.listSkills()
  expect(skills).toEqual([{ name: 'demo', description: 'demo 描述' }])
})

test('内置层 expandSkillText：内置 skill 就地展开，location 指内置文件、引用相对内置目录', () => {
  const builtinSkillsDir = join(rootDir, 'builtin-studio', 'skills')
  writeBuiltinSkill(builtinSkillsDir, 'layer-splitting', 'BUILTIN 正文')
  const store = createCapabilitiesStore({ agentDir, rootDir, builtinSkillsDir })
  store.set({ agentSkills: true })
  const out = store.expandSkillText('/skill:layer-splitting 拆这张图')
  expect(out).toContain('<skill name="layer-splitting"')
  expect(out).toContain('BUILTIN 正文')
  expect(out).toContain(join(builtinSkillsDir, 'layer-splitting', 'SKILL.md'))
  expect(out).toContain(`References are relative to ${join(builtinSkillsDir, 'layer-splitting')}`)
})

test('内置层 OFF 兜底：agentSkills OFF 时内置 skill 不进清单、不展开', () => {
  const builtinSkillsDir = join(rootDir, 'builtin-studio', 'skills')
  writeBuiltinSkill(builtinSkillsDir, 'layer-splitting', '内置正文')
  const store = createCapabilitiesStore({ agentDir, rootDir, builtinSkillsDir })
  store.set({ agentSkills: false })
  expect(store.listSkills()).toEqual([])
  expect(store.expandSkillText('/skill:layer-splitting 拆图')).toBe('/skill:layer-splitting 拆图')
})

// ── 负向 override：v3 disabledSkills（只记被关闭的 skill 名） ─────────────

test('v3 写盘：setDisabledSkills 后文件含 disabledSkills 字段、落盘恒 version:3', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.setDisabledSkills(['demo', 'other'])
  const raw = JSON.parse(readFileSync(join(agentDir, 'capabilities.json'), 'utf8')) as unknown
  expect((raw as { version: number }).version).toBe(3)
  expect((raw as { disabledSkills: string[] }).disabledSkills).toEqual(['demo', 'other'])
})

test('v3 落盘 roundtrip：写 → 新实例读', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true, builtinTools: 'full' })
  store.setDisabledSkills(['demo'])
  const reread = createCapabilitiesStore({ agentDir, rootDir })
  expect(reread.get()).toEqual({
    builtinTools: 'full',
    agentSkills: true,
    disabledSkills: ['demo']
  })
})

test('v2 旧文件读：disabledSkills 缺省 []（v3 形状补全）', () => {
  writeFileSync(
    join(agentDir, 'capabilities.json'),
    JSON.stringify({ version: 2, builtinTools: 'full', agentSkills: true }),
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get().disabledSkills).toEqual([])
})

test('v3 disabledSkills 非数组 → 字段降级 []（其余字段照常解析，不整文件降级）', () => {
  writeFileSync(
    join(agentDir, 'capabilities.json'),
    JSON.stringify({
      version: 3,
      builtinTools: 'full',
      agentSkills: true,
      disabledSkills: 'not-an-array'
    }),
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  // 字段降级而非整文件降级——其余字段仍按 v3 解析
  expect(store.get()).toEqual({ builtinTools: 'full', agentSkills: true, disabledSkills: [] })
})

test('v3 disabledSkills 含非字符串元素 → 过滤为字符串子集（其余字段照常解析）', () => {
  writeFileSync(
    join(agentDir, 'capabilities.json'),
    JSON.stringify({
      version: 3,
      builtinTools: 'readonly',
      agentSkills: false,
      // 类型混合——数字/对象/字符串三种：字符串保留，其余过滤
      disabledSkills: ['demo', 42, null, 'other', { bad: true }]
    }),
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({
    builtinTools: 'readonly',
    agentSkills: false,
    disabledSkills: ['demo', 'other']
  })
})

test('setDisabledSkills 去重保序归一', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  const result = store.setDisabledSkills(['b', 'a', 'b', 'c', 'a'])
  expect(result).toEqual(['b', 'a', 'c'])
})

test('setDisabledSkills 非 string[] → TypeError 且不写盘', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(() => store.setDisabledSkills('not-array')).toThrow(/array/)
  expect(() => store.setDisabledSkills(null)).toThrow(/array/)
  expect(() => store.setDisabledSkills(42)).toThrow(/array/)
  expect(existsSync(join(agentDir, 'capabilities.json'))).toBe(false)
})

test('setDisabledSkills 不校验名字存在性（被禁名对应 skill 卸载后再装回保持禁用）', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  // 不存在的 skill 名也能写入——负向韧性
  expect(store.setDisabledSkills(['never-installed-skill'])).toEqual(['never-installed-skill'])
  expect(store.get().disabledSkills).toEqual(['never-installed-skill'])
})

test('set 不动 disabledSkills：builtinTools 缺省保留旧值的同模式', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.setDisabledSkills(['existing'])
  store.set({ agentSkills: true, builtinTools: 'readonly' })
  expect(store.get().disabledSkills).toEqual(['existing'])
  // 再次只写 agentSkills 也不动 disabledSkills
  store.set({ agentSkills: false })
  expect(store.get()).toEqual({
    builtinTools: 'readonly',
    agentSkills: false,
    disabledSkills: ['existing']
  })
})

test('listSkills 过滤 disabledSkills（被禁件不进 chips/manifest）', () => {
  writeSkill('a', 'A 描述')
  writeSkill('b', 'B 描述')
  writeSkill('c', 'C 描述')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true })
  store.setDisabledSkills(['b'])
  const skills = store.listSkills()
  expect(skills.map((s) => s.name).sort()).toEqual(['a', 'c'])
})

test('expandSkillText 跳过 disabledSkills：被禁件按未知名透传（与 SDK noSkills 同语义）', () => {
  writeSkill('enabled', '启用正文')
  writeSkill('disabled', '被禁正文')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  store.set({ agentSkills: true })
  store.setDisabledSkills(['disabled'])
  const out = store.expandSkillText('/skill:enabled 和 /skill:disabled')
  expect(out).toContain('<skill name="enabled"')
  expect(out).toContain('启用正文')
  // 被禁件按未知名透传
  expect(out).not.toContain('<skill name="disabled"')
  expect(out).toContain('/skill:disabled')
})

test('listSkillsForManagement：全量清单含被禁件、shape 带 source + enabled', () => {
  writeSkill('user-skill', '用户侧描述')
  const builtinSkillsDir = join(rootDir, 'builtin-studio', 'skills')
  writeBuiltinSkill(builtinSkillsDir, 'builtin-skill', '内置描述')
  const store = createCapabilitiesStore({ agentDir, rootDir, builtinSkillsDir })
  store.set({ agentSkills: true })
  store.setDisabledSkills(['user-skill'])

  const managed = store.listSkillsForManagement()
  // 不受 agentSkills 总闸影响——即便总闸 OFF 也会返回（规格要求）
  store.set({ agentSkills: false })
  const managedWhenOff = store.listSkillsForManagement()

  for (const entry of [...managed, ...managedWhenOff]) {
    expect(Object.keys(entry).sort()).toEqual(['description', 'enabled', 'name', 'source'])
  }
  // source 标记赢家层
  const userEntry = managed.find((e) => e.name === 'user-skill')
  const builtinEntry = managed.find((e) => e.name === 'builtin-skill')
  expect(userEntry?.source).toBe('user')
  expect(builtinEntry?.source).toBe('builtin')
  // enabled 反映 disabledSkills
  expect(userEntry?.enabled).toBe(false)
  expect(builtinEntry?.enabled).toBe(true)
})

test('listSkillsForManagement 同名冲突时 source 标记用户层（合并赢家层归属）', () => {
  const builtinSkillsDir = join(rootDir, 'builtin-studio', 'skills')
  writeSkill('demo', '用户侧正文')
  writeBuiltinSkill(builtinSkillsDir, 'demo', '内置侧正文')
  const store = createCapabilitiesStore({ agentDir, rootDir, builtinSkillsDir })
  store.set({ agentSkills: true })
  const managed = store.listSkillsForManagement()
  const demo = managed.find((e) => e.name === 'demo')
  expect(demo?.source).toBe('user')
})
