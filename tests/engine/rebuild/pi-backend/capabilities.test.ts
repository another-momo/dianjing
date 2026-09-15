/**
 * T87：capabilities store 单测——缺省 OFF、set/get 往返、坏 JSON 降级、
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

test('T87 缺省：capabilities.json 不存在 → OFF（不暴露新攻击面）', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'off', agentSkills: false })
  expect(store.listSkills()).toEqual([])
  // 未触发写入（缺省走读 fail-safe，不应副作用生成 capabilities.json）
  expect(existsSync(join(agentDir, 'capabilities.json'))).toBe(false)
})

test('T87 写读往返：set ON → get ON；文件落盘 0o600 含 version+builtinTools+agentSkills', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  const next = store.set({ agentSkills: true })
  // T96：builtinTools 缺省保留旧值（缺省 'off'）——set 只写 agentSkills 的兼容面
  expect(next).toEqual({ builtinTools: 'off', agentSkills: true })
  expect(store.get()).toEqual({ builtinTools: 'off', agentSkills: true })

  // 重新构造读面（验落盘而非仅内存缓存）
  const reread = createCapabilitiesStore({ agentDir, rootDir })
  expect(reread.get()).toEqual({ builtinTools: 'off', agentSkills: true })

  // 文件结构钉扎（T96：写盘恒 version:2）
  const raw = JSON.parse(readFileSync(join(agentDir, 'capabilities.json'), 'utf8')) as unknown
  expect((raw as { version: number }).version).toBe(2)
  expect((raw as { builtinTools: string }).builtinTools).toBe('off')
  expect((raw as { agentSkills: boolean }).agentSkills).toBe(true)
})

test('T96 写读往返：三档位 builtinTools 落盘回读', () => {
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.set({ agentSkills: false, builtinTools: 'readonly' })).toEqual({
    builtinTools: 'readonly',
    agentSkills: false
  })
  expect(store.set({ agentSkills: true, builtinTools: 'full' })).toEqual({
    builtinTools: 'full',
    agentSkills: true
  })
  const reread = createCapabilitiesStore({ agentDir, rootDir })
  expect(reread.get()).toEqual({ builtinTools: 'full', agentSkills: true })
})

test('T87 坏 JSON 降级：写入非 JSON 内容 → 下次构造读 OFF', () => {
  writeFileSync(join(agentDir, 'capabilities.json'), '{not-json}', 'utf8')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'off', agentSkills: false })
  expect(store.listSkills()).toEqual([])
})

test('T87 缺字段降级：写入空对象 → OFF', () => {
  writeFileSync(join(agentDir, 'capabilities.json'), '{}', 'utf8')
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'off', agentSkills: false })
})

test('T96 v1→v2 迁移：version:1 + agentSkills:true → builtinTools full（旧同闸语义）', () => {
  writeFileSync(
    join(agentDir, 'capabilities.json'),
    JSON.stringify({ version: 1, agentSkills: true }),
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'full', agentSkills: true })
})

test('T96 v1→v2 迁移：version:1 + agentSkills:false → builtinTools off', () => {
  writeFileSync(
    join(agentDir, 'capabilities.json'),
    JSON.stringify({ version: 1, agentSkills: false }),
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'off', agentSkills: false })
  // 迁移后的首次写盘升级文件形状到 v2
  store.set({ agentSkills: false })
  const raw = JSON.parse(readFileSync(join(agentDir, 'capabilities.json'), 'utf8')) as {
    version: number
  }
  expect(raw.version).toBe(2)
})

test('T96 v2 非法 builtinTools → 降级 DEFAULTS（坏档位不残留）', () => {
  writeFileSync(
    join(agentDir, 'capabilities.json'),
    JSON.stringify({ version: 2, builtinTools: 'everything', agentSkills: true }),
    'utf8'
  )
  const store = createCapabilitiesStore({ agentDir, rootDir })
  expect(store.get()).toEqual({ builtinTools: 'off', agentSkills: false })
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
  expect(next).toEqual({ builtinTools: 'readonly', agentSkills: false })
})

test('T87 listSkills：OFF 时空集（不泄露已扫到 skill 存在性）', () => {
  // 即便 skills/ 有 SKILL.md，OFF 时 listSkills 也必须空集
  const userSkillsDir = join(rootDir, 'studio', 'skills', 'demo')
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

test('T87 listSkills：ON 时扫 studio/skills（D2 扁平化单源）+ 脱敏', () => {
  // T89 → D2：单源扫描 skills（扁平化后直接挂 rootDir）；原双源去重测试
  // 不再适用（同名 demo 在单源下不可能双份；保留 name 投影 + 脱敏两条核心断言）
  const userDir = join(rootDir, 'studio', 'skills', 'demo')
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
  const otherDir = join(rootDir, 'studio', 'skills', 'other')
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
  const userDir = join(rootDir, 'studio', 'skills', 'hidden')
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
  const userDir = join(rootDir, 'studio', 'skills', 'no-desc')
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
  const dir = join(rootDir, 'studio', 'skills', name)
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
