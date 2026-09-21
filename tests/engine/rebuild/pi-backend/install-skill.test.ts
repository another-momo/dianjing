/**
 * 2026-09-21 skill-installer v1 批 1：install_skill 桥工具单测（仓外
 * docs/202609201453-skill-installer-meta-skill-design.md §5/§6/§10 + 快照
 * docs/202609212224-skill-runtime-facts-snapshot.md §1/§3/§4）。
 *
 * 验收映射（设计稿 §13）：
 *  - 三分支 fixture 各一：直装 / overwrite+备份+prune / 含 scripts 拒装
 *  - 安全回归：name 非法、frontmatter 越键、symlink、..、超体积拒装
 *  - 撞内置名拒装
 *  - 闸门 reject/abort/已挂 = 拒装（与 bash 授权同族）
 *
 * 测试纪律：禁读真实 env/真实 home（rootDir 用 mkdtemp 假根；homeDir 注入为
 * rootDir 同根，绝对无碰撞）；forkSource/bridge 一律直钉 runInstall 不经桥；
 * 测试夹具虚空名 = `no-such-void-<ts>` 全平台不存在；时间戳注入确保 prune
 * 行为可断。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AuthzRequestNotice,
  type InstallSkillAuthzRequest
} from '@/app/ai/pi-backend/authz-guard'
import {
  createInstallSkillTool,
  listBuiltinSkillNames,
  runInstall,
  scanStaging,
  validateSkillFrontmatter,
  validateSkillName
} from '@/app/ai/pi-backend/install-skill'
import {
  resolveBuiltinSkillsDir,
  resolveSkillsDir,
  resolveWorkspaceDir
} from '@/app/ai/pi-backend/paths'
import {
  createPendingDecisionStore,
  type PendingDecisionStore
} from '@/app/ai/pi-backend/pending-decision'

// ── 测试 fixture 辅助 ──

let rootDir: string
let workspaceDir: string
let stagingRoot: string
let skillsDir: string
let builtinSkillsDir: string
let store: PendingDecisionStore
let chunks: Array<{ type: string; id?: string; data?: unknown }>

const SESSION = 'test-session-1'

function makeSkillMd(
  dir: string,
  opts: { name?: string; description?: string; extraKeys?: string[] } = {}
): string {
  const name = opts.name ?? 'demo-skill'
  const description = opts.description ?? 'A demo skill for install_skill tests.'
  const lines = ['---', `name: ${name}`, `description: ${description}`]
  for (const key of opts.extraKeys ?? []) {
    lines.push(`${key}: some value`)
  }
  lines.push('---', '', '# Demo', '', 'Body.')
  const path = join(dir, 'SKILL.md')
  writeFileSync(path, lines.join('\n'))
  return path
}

function makeStaging(slug: string, populate?: (dir: string) => void): string {
  const dir = join(stagingRoot, slug)
  mkdirSync(dir, { recursive: true })
  populate?.(dir)
  return dir
}

function makeSink() {
  chunks = []
  return { emit: (chunk: { type: string; id?: string; data?: unknown }) => chunks.push(chunk) }
}

/**
 * 跑 runInstall 并按 formIdSuffix 同步 resolve authz——runInstall 在 await
 * registration.promise 前的所有 IO 与状态写入都是同步（readFileSync/statSync/
 * mkdirSync 等无 await），挂起前 registerAuthz 已落地；调用方紧跟 resolve
 * 即可解锁 promise（resolveAuthz 对未注册 formId 返 'not_found' 无副作用——
 * 校验失败路径早返不挂卡，resolve 调用是 no-op）。
 */
function runInstallResolved(
  args: Parameters<typeof runInstall>[0],
  decision: { decision: 'allow-once' | 'allow-rule' | 'deny'; note?: string; ruleText?: string }
): Promise<Awaited<ReturnType<typeof runInstall>>> {
  const suffix = args.formIdSuffix ?? 'auto'
  const formId = `install-skill-${suffix}`
  const resultPromise = runInstall(args)
  store.resolveAuthz(formId, decision)
  return resultPromise
}

function requestNotices(): AuthzRequestNotice[] {
  return chunks
    .filter((c) => c.type === 'data-authz-request')
    .map((c) => c.data as AuthzRequestNotice)
}

function decisionNotices(): Array<{
  formId: string
  kind: 'authz'
  decision: 'allow-once' | 'allow-rule' | 'deny'
}> {
  return chunks
    .filter((c) => c.type === 'data-authz-decision')
    .map(
      (c) =>
        c.data as { formId: string; kind: 'authz'; decision: 'allow-once' | 'allow-rule' | 'deny' }
    )
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'openpencil-install-skill-'))
  workspaceDir = resolveWorkspaceDir(rootDir)
  stagingRoot = join(workspaceDir, 'skill-install-staging')
  skillsDir = resolveSkillsDir(rootDir)
  builtinSkillsDir = resolveBuiltinSkillsDir(join(rootDir, 'studio'))
  mkdirSync(stagingRoot, { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  store = createPendingDecisionStore()
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

// ── 单元：validateSkillName（SDK 口径复刻） ──

describe('validateSkillName', () => {
  test('合法 name 通过', () => {
    expect(validateSkillName('demo-skill')).toEqual([])
    expect(validateSkillName('a')).toEqual([])
    expect(validateSkillName('123abc')).toEqual([])
  })

  test('空、超长、大写、空格、特殊字符、首尾连字符、连续连字符逐条拒', () => {
    const expectMsg = (errors: string[], needle: string): void => {
      expect(errors.some((m) => m.includes(needle))).toBe(true)
    }
    expectMsg(validateSkillName(''), 'name is empty')
    expectMsg(validateSkillName('A'), 'invalid characters (must be lowercase')
    expectMsg(validateSkillName('-foo'), 'must not start or end with a hyphen')
    expectMsg(validateSkillName('foo-'), 'must not start or end with a hyphen')
    expectMsg(validateSkillName('foo--bar'), 'must not contain consecutive hyphens')
    expectMsg(validateSkillName('foo bar'), 'invalid characters (must be lowercase')
    expectMsg(validateSkillName('a'.repeat(65)), 'exceeds 64 characters')
  })
})

// ── 单元：frontmatter 校验 ──

describe('validateSkillFrontmatter', () => {
  test('三键齐 → ok', () => {
    const fm = '---\nname: x\ndescription: y\ndisable-model-invocation: true\n---\nbody'
    const r = validateSkillFrontmatter(fm)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.name).toBe('x')
      expect(r.description).toBe('y')
      expect(r.disableModelInvocation).toBe(true)
    }
  })

  test('无 frontmatter → 空 {} → name/description 缺 → violations', () => {
    const r = validateSkillFrontmatter('# body')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations).toContain('frontmatter name is empty')
      expect(r.violations).toContain('frontmatter description is empty')
    }
  })

  test('白名单外键（allowedTools/license/version）→ 拒并回报键名', () => {
    const fm = '---\nname: x\ndescription: y\nallowedTools: foo\nlicense: MIT\nversion: 1.0\n---\n'
    const r = validateSkillFrontmatter(fm)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations.some((v) => v.includes('allowedTools'))).toBe(true)
      expect(r.violations.some((v) => v.includes('license'))).toBe(true)
      expect(r.violations.some((v) => v.includes('version'))).toBe(true)
    }
  })

  test('disable-model-invocation 非 true（字符串/数字/null）→ 当 false 处理', () => {
    const fm = '---\nname: x\ndescription: y\ndisable-model-invocation: "true"\n---\n'
    const r = validateSkillFrontmatter(fm)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.disableModelInvocation).toBe(false)
    }
  })
})

// ── 单元：scanStaging ──

describe('scanStaging', () => {
  test('正常目录 → 文件清单 + 总字节', () => {
    const staging = makeStaging('ok', (dir) => {
      makeSkillMd(dir)
      writeFileSync(join(dir, 'references.md'), '# references\n')
    })
    const scan = scanStaging(staging)
    expect(scan.violations).toEqual([])
    expect(scan.files.map((f) => f.relPath).sort()).toEqual(['SKILL.md', 'references.md'])
    expect(scan.totalBytes).toBeGreaterThan(0)
  })

  test('.git / . 开头件 + node_modules 跳过', () => {
    const staging = makeStaging('skip', (dir) => {
      makeSkillMd(dir)
      mkdirSync(join(dir, '.git'), { recursive: true })
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main')
      writeFileSync(join(dir, '.hidden'), 'secret')
      mkdirSync(join(dir, 'node_modules'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'x.js'), 'module.exports=1')
    })
    const scan = scanStaging(staging)
    expect(scan.violations).toEqual([])
    expect(scan.files.map((f) => f.relPath)).toEqual(['SKILL.md'])
  })

  test('scripts/ 一级目录硬拒（v1：bash 层2-D 未落地前不放行）', () => {
    const staging = makeStaging('scripts', (dir) => {
      makeSkillMd(dir)
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'build.sh'), '#!/usr/bin/env bash\necho hi')
    })
    const scan = scanStaging(staging)
    expect(scan.violations.some((v) => v.includes('scripts/'))).toBe(true)
    // scripts 目录不进 files 清单（保证写盘面无 scripts 件）
    expect(scan.files.find((f) => f.relPath.startsWith('scripts'))).toBeUndefined()
  })

  test('symlink 拒装', () => {
    const staging = makeStaging('sym', (dir) => {
      makeSkillMd(dir)
      mkdirSync(join(rootDir, 'outside'), { recursive: true })
      writeFileSync(join(rootDir, 'outside', 'evil.sh'), '#!/usr/bin/env bash\nrm -rf /')
      try {
        symlinkSync(join(rootDir, 'outside', 'evil.sh'), join(dir, 'link.sh'))
      } catch {
        // Windows 沙箱无 SeCreateSymbolicLinkPrivilege 跳过本测
      }
    })
    const scan = scanStaging(staging)
    // symlink 拒绝 / 或跳过（Win 沙箱下失败则不在 violations）
    if (scan.files.find((f) => f.relPath === 'link.sh')) {
      throw new Error('symlink should not appear in files')
    }
  })

  test('单文件超 5MB 拒装', () => {
    const staging = makeStaging('big', (dir) => {
      makeSkillMd(dir)
      const big = join(dir, 'big.bin')
      writeFileSync(big, new Uint8Array(8))
      truncateSync(big, 5 * 1024 * 1024 + 1)
    })
    const scan = scanStaging(staging)
    expect(scan.violations.some((v) => v.includes('5 MB'))).toBe(true)
    expect(scan.files.find((f) => f.relPath === 'big.bin')).toBeUndefined()
  })

  test('总体积超 20MB 拒装', () => {
    const staging = makeStaging('total', (dir) => {
      makeSkillMd(dir)
      for (let i = 0; i < 5; i++) {
        const f = join(dir, `chunk-${i}.bin`)
        writeFileSync(f, new Uint8Array(8))
        truncateSync(f, 4 * 1024 * 1024 + 1024) // 5 件 × 4MB+ ≈ 20MB+
      }
    })
    const scan = scanStaging(staging)
    expect(scan.violations.some((v) => v.includes('20 MB'))).toBe(true)
  })
})

// ── 单元：listBuiltinSkillNames ──

describe('listBuiltinSkillNames', () => {
  test('空目录 → []', () => {
    expect(listBuiltinSkillNames(builtinSkillsDir)).toEqual([])
  })

  test('有 SKILL.md 的子目录进入清单（含 SKILL.md 即视为 skill）', () => {
    mkdirSync(join(builtinSkillsDir, 'a-skill'), { recursive: true })
    writeFileSync(
      join(builtinSkillsDir, 'a-skill', 'SKILL.md'),
      '---\nname: a-skill\ndescription: x\n---\n'
    )
    mkdirSync(join(builtinSkillsDir, 'no-md'), { recursive: true })
    writeFileSync(join(builtinSkillsDir, 'no-md', 'README.md'), '# no SKILL.md')
    expect(listBuiltinSkillNames(builtinSkillsDir)).toEqual(['a-skill'])
  })

  test('不存在的目录 → []（不抛错）', () => {
    expect(listBuiltinSkillNames(join(rootDir, 'no-such-void-' + Date.now()))).toEqual([])
  })
})

// ── runInstall 集成：直装成功 ──

describe('runInstall 直装成功', () => {
  test('合法 staging → 写入 skills/<name>/ 并返回完整契约', async () => {
    const staging = makeStaging('demo', (dir) => {
      makeSkillMd(dir, { name: 'demo-skill' })
      writeFileSync(join(dir, 'references.md'), '# references')
    })
    const sink = makeSink()
    const result = await runInstallResolved(
      {
        sourceDir: staging,
        name: 'demo-skill',
        overwrite: false,
        rootDir,
        store,
        sessionId: SESSION,
        authzSink: sink,
        builtinSkillsDir,
        formIdSuffix: 'fixed-form-id',
        now: new Date('2026-09-21T12:34:56.789Z')
      },
      { decision: 'allow-once' }
    )
    expect(result.error).toBeUndefined()
    // paths 模块返回归一化正斜杠路径；join 期望是原生分隔符——两侧归一后比
    expect(result.path?.replaceAll('\\', '/')).toBe(
      join(skillsDir, 'demo-skill').replaceAll('\\', '/')
    )
    expect(result.name).toBe('demo-skill')
    expect(result.effectiveNextSession).toBe(true)
    expect(result.invocation).toBe('/skill:demo-skill')
    expect(result.files?.sort()).toEqual(['SKILL.md', 'references.md'])
    expect(result.backupPath).toBeUndefined()

    // 实际写盘：SKILL.md + references.md 落位
    expect(existsSync(join(skillsDir, 'demo-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(skillsDir, 'demo-skill', 'references.md'))).toBe(true)

    // 闸门轨迹：一次 request + 一次 decision
    const req = requestNotices()
    expect(req).toHaveLength(1)
    const r0 = req[0]
    if (r0 && r0.toolName === 'install_skill') {
      expect(r0.formId).toBe('install-skill-fixed-form-id')
      expect(r0.sourceDir.replaceAll('\\', '/')).toBe(staging.replaceAll('\\', '/'))
      expect(r0.name).toBe('demo-skill')
      expect(r0.overwrite).toBe(false)
      expect(r0.files.sort()).toEqual(['SKILL.md', 'references.md'])
      expect(r0.adapterSummary).toContain('files: 2')
      expect(r0.adapterSummary).toContain('description:')
    } else {
      throw new Error('expected install_skill notice')
    }
    expect(decisionNotices()).toEqual([
      { formId: 'install-skill-fixed-form-id', kind: 'authz', decision: 'allow-once' }
    ])
  })
})

// ── runInstall 集成：name 校验 ──

describe('runInstall name 硬闸（SDK validateName 同口径）', () => {
  test.each([
    ['空名', ''],
    ['含大写', 'FooBar'],
    ['含空格', 'foo bar'],
    ['首尾连字符', '-foo'],
    ['连续连字符', 'foo--bar'],
    ['超长', 'a'.repeat(65)]
  ])('%s → reason=invalid + violations', async (_label, badName) => {
    const staging = makeStaging('n', (dir) => {
      makeSkillMd(dir)
    })
    const sink = makeSink()
    const beforeSkills = readdirSync(skillsDir).sort()
    const result = await runInstall({
      sourceDir: staging,
      name: badName,
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('invalid')
    expect(result.violations?.length ?? 0).toBeGreaterThan(0)
    // 无卡面推送（name 硬闸在闸门前）
    expect(requestNotices()).toHaveLength(0)
    // 无任何写盘：skillsDir 内容前后一致（空名 join 等于 skillsDir 自身，existsSync 恒真，
    // 不能用它断言）
    expect(readdirSync(skillsDir).sort()).toEqual(beforeSkills)
  })
})

// ── runInstall 集成：frontmatter 越键 ──

describe('runInstall frontmatter 校验', () => {
  test('白名单外键（allowedTools/license/version）→ 拒装 + 违规清单含键名', async () => {
    const staging = makeStaging('fm', (dir) => {
      makeSkillMd(dir, { name: 'fm-skill', extraKeys: ['allowedTools', 'license', 'version'] })
    })
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: staging,
      name: 'fm-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('invalid')
    expect(result.violations?.some((v) => v.includes('allowedTools'))).toBe(true)
    expect(result.violations?.some((v) => v.includes('license'))).toBe(true)
    expect(result.violations?.some((v) => v.includes('version'))).toBe(true)
    expect(requestNotices()).toHaveLength(0)
  })

  test('frontmatter 缺 description → 拒装', async () => {
    const staging = makeStaging('nod', (dir) => {
      // 自实现 SKILL.md：name 有但 description 空
      writeFileSync(join(dir, 'SKILL.md'), '---\nname: nod-skill\ndescription: "  "\n---\n# body')
    })
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: staging,
      name: 'nod-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('invalid')
    expect(result.violations?.some((v) => v.includes('description is empty'))).toBe(true)
  })

  test('frontmatter name ≠ 参数 name → 拒装', async () => {
    const staging = makeStaging('mismatch', (dir) => {
      makeSkillMd(dir, { name: 'real-name' })
    })
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: staging,
      name: 'fake-name',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('invalid')
    expect(result.violations?.some((v) => v.includes('does not match'))).toBe(true)
  })
})

// ── runInstall 集成：staging 越界 / 越路径 ──

describe('runInstall source_dir 越界与文件树', () => {
  test('source_dir 不在 staging 根下 → 拒装', async () => {
    // rootDir/workspace/elsewhere 不在 skill-install-staging 下
    const elsewhere = join(workspaceDir, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    makeSkillMd(elsewhere)
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: elsewhere,
      name: 'demo-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('invalid')
    expect(result.violations?.some((v) => v.includes('must be inside'))).toBe(true)
  })

  test('source_dir 是文件不是目录 → 拒装', async () => {
    const file = join(stagingRoot, 'not-a-dir')
    writeFileSync(file, 'hello')
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: file,
      name: 'demo-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('invalid')
    expect(result.violations?.some((v) => v.includes('not a directory'))).toBe(true)
  })

  test('scripts/ 件拒装', async () => {
    const staging = makeStaging('scripts', (dir) => {
      makeSkillMd(dir, { name: 'scripts-skill' })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'build.sh'), '#!/usr/bin/env bash\necho hi')
    })
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: staging,
      name: 'scripts-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('invalid')
    expect(result.violations?.some((v) => v.includes('scripts/'))).toBe(true)
    expect(requestNotices()).toHaveLength(0)
  })

  test('symlink 件拒装', async () => {
    const staging = makeStaging('sym', (dir) => {
      makeSkillMd(dir, { name: 'sym-skill' })
      const outside = join(rootDir, 'outside-secret')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'evil.sh'), '#!/usr/bin/env bash\nrm -rf /')
      try {
        symlinkSync(join(outside, 'evil.sh'), join(dir, 'evil.sh'))
      } catch {
        // Windows 沙箱无 SeCreateSymbolicLinkPrivilege → 测试跳过
        return
      }
    })
    const sink = makeSink()
    // 必须走 runInstallResolved：本机无 symlink 权限时扫描会通过、流程进入闸门，
    // 裸 await runInstall 无人解锁 = 全文件挂死（本测曾把批 1 worker 卡夭）
    const result = await runInstallResolved(
      {
        sourceDir: staging,
        name: 'sym-skill',
        overwrite: false,
        rootDir,
        store,
        sessionId: SESSION,
        authzSink: sink,
        builtinSkillsDir,
        formIdSuffix: 'sym'
      },
      { decision: 'allow-once' }
    )
    // Win 沙箱下 symlink 创建失败，扫描可能 SKILL.md 单件通过——跳过本测。
    // 非 Win 下应见 symlink 违规。
    if (existsSync(join(staging, 'evil.sh'))) {
      expect(result.reason).toBe('invalid')
      expect(result.violations?.some((v) => v.includes('symbolic link'))).toBe(true)
    }
  })

  test('超总体积 → 拒装', async () => {
    const staging = makeStaging('big', (dir) => {
      makeSkillMd(dir, { name: 'big-skill' })
      for (let i = 0; i < 5; i++) {
        const f = join(dir, `chunk-${i}.bin`)
        writeFileSync(f, new Uint8Array(8))
        truncateSync(f, 4 * 1024 * 1024 + 1024)
      }
    })
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: staging,
      name: 'big-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('invalid')
    expect(result.violations?.some((v) => v.includes('20 MB'))).toBe(true)
  })
})

// ── runInstall 集成：撞名 ──

describe('runInstall 撞名校验', () => {
  test('与内置层同名 → reason=conflict + conflictWith=builtin', async () => {
    mkdirSync(join(builtinSkillsDir, 'core-skill'), { recursive: true })
    writeFileSync(
      join(builtinSkillsDir, 'core-skill', 'SKILL.md'),
      '---\nname: core-skill\ndescription: builtin\n---\n'
    )
    const staging = makeStaging('collision', (dir) => {
      makeSkillMd(dir, { name: 'core-skill' })
    })
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: staging,
      name: 'core-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('conflict')
    expect(result.conflictWith).toBe('builtin')
    expect(String(result.error)).toContain('built-in skill')
    expect(requestNotices()).toHaveLength(0)
  })

  test('用户层同名 + 未带 overwrite → reason=conflict + conflictWith=user', async () => {
    // 已存用户层同名 skill
    const existingDir = join(skillsDir, 'exists-skill')
    mkdirSync(existingDir, { recursive: true })
    writeFileSync(join(existingDir, 'SKILL.md'), '# existing')
    const staging = makeStaging('conflict', (dir) => {
      makeSkillMd(dir, { name: 'exists-skill' })
    })
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: staging,
      name: 'exists-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('conflict')
    expect(result.conflictWith).toBe('user')
    expect(String(result.error)).toContain('overwrite:true')
    // 旧目录仍在
    expect(existsSync(existingDir)).toBe(true)
    expect(requestNotices()).toHaveLength(0)
  })
})

// ── runInstall 集成：overwrite + 备份 + prune ──

describe('runInstall overwrite 链路', () => {
  test('同名 overwrite:true → 旧目录移入 .skill-backups/<name>/<ts>/', async () => {
    const existingDir = join(skillsDir, 'replace-skill')
    mkdirSync(existingDir, { recursive: true })
    writeFileSync(join(existingDir, 'old.txt'), 'old content')
    const staging = makeStaging('replace', (dir) => {
      makeSkillMd(dir, { name: 'replace-skill' })
    })
    const sink = makeSink()
    const result = await runInstallResolved(
      {
        sourceDir: staging,
        name: 'replace-skill',
        overwrite: true,
        rootDir,
        store,
        sessionId: SESSION,
        authzSink: sink,
        builtinSkillsDir,
        formIdSuffix: 'replace',
        now: new Date('2026-09-21T08:00:00.000Z')
      },
      { decision: 'allow-once' }
    )
    expect(result.error).toBeUndefined()
    expect(result.path?.replaceAll('\\', '/')).toBe(
      join(skillsDir, 'replace-skill').replaceAll('\\', '/')
    )
    expect(result.backupPath).toBeDefined()
    expect(result.backupPath).toContain('.skill-backups')
    expect(result.backupPath).toContain('replace-skill')

    // 备份目录含旧内容
    expect(existsSync(join(result.backupPath ?? '', 'old.txt'))).toBe(true)
    expect(readFileSync(join(result.backupPath ?? '', 'old.txt'), 'utf-8')).toBe('old content')

    // 新目录含 SKILL.md（来自 staging）
    expect(existsSync(join(skillsDir, 'replace-skill', 'SKILL.md'))).toBe(true)
    // 旧文件不再在新目录
    expect(existsSync(join(skillsDir, 'replace-skill', 'old.txt'))).toBe(false)
  })

  test('第 4 次 overwrite 后 prune 到 3 份', async () => {
    // 预填 3 份旧备份 + 1 个用户层旧目录
    const backupParent = join(rootDir, 'workspace', '.agents', '.skill-backups', 'rotate-skill')
    const backupDirs = [
      join(backupParent, '20260101-080000-000'),
      join(backupParent, '20260201-080000-000'),
      join(backupParent, '20260301-080000-000')
    ]
    for (const dir of backupDirs) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'old.txt'), 'snapshot')
      // 设不同 mtime（旧的更早）
      const ts = dir.match(/20260(\d+)/)?.[1] ?? '1'
      const past = new Date(2026, 0, Number(ts), 8, 0, 0)
      utimesSyncCompat(dir, past)
    }
    // 第 4 个时间戳 = 更晚
    const existingDir = join(skillsDir, 'rotate-skill')
    mkdirSync(existingDir, { recursive: true })
    writeFileSync(join(existingDir, 'old.txt'), 'old')
    utimesSyncCompat(existingDir, new Date(2026, 8, 1, 8, 0, 0))

    const staging = makeStaging('rotate', (dir) => {
      makeSkillMd(dir, { name: 'rotate-skill' })
    })
    const sink = makeSink()
    const result = await runInstallResolved(
      {
        sourceDir: staging,
        name: 'rotate-skill',
        overwrite: true,
        rootDir,
        store,
        sessionId: SESSION,
        authzSink: sink,
        builtinSkillsDir,
        formIdSuffix: 'rotate',
        now: new Date('2026-09-21T08:00:00.000Z')
      },
      { decision: 'allow-once' }
    )
    expect(result.error).toBeUndefined()

    // 备份父目录现存 3 份（旧的 1 月份被 prune）
    const remainingDirs = readdirSync(backupParent)
    expect(remainingDirs.length).toBe(3)
    // 被 prune 的应该是最老的一份（20260101-*）
    expect(remainingDirs.some((d) => d.startsWith('20260101'))).toBe(false)
    expect(result.backupPath).toBeDefined()
    expect(remainingDirs.includes((result.backupPath ?? '').split(/[\\/]/).pop() ?? '')).toBe(true)
  })
})

/** 跨平台 mtime 设值（Node 17+ utimesSync；本仓 bun 1.x 验证存在） */
function utimesSyncCompat(path: string, time: Date): void {
  const { utimesSync } = require('node:fs') as typeof import('node:fs')
  utimesSync(path, time, time)
}

// ── runInstall 集成：闸门 reject / abort / 已挂 ──

describe('runInstall 闸门族（与 bash 授权同待遇）', () => {
  test('deny → reason=denied + abort 回执文案 + 完结信号', async () => {
    const staging = makeStaging('deny', (dir) => {
      makeSkillMd(dir, { name: 'deny-skill' })
    })
    const sink = makeSink()
    const resultPromise = runInstall({
      sourceDir: staging,
      name: 'deny-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir,
      formIdSuffix: 'deny-1'
    })
    // 注册后立刻 resolve deny
    expect(store.pendingKindForSession(SESSION)).toBe('authz')
    store.resolveAuthz('install-skill-deny-1', { decision: 'deny', note: '不放心来源' })
    const result = await resultPromise
    expect(result.reason).toBe('denied')
    expect(String(result.error)).toContain('Install skill denied by the user: deny-skill')
    expect(String(result.error)).toContain('User note: 不放心来源')
    expect(decisionNotices().find((d) => d.formId === 'install-skill-deny-1')?.decision).toBe(
      'deny'
    )
    // 不写盘
    expect(existsSync(join(skillsDir, 'deny-skill'))).toBe(false)
  })

  test('abort（rejectForSession）→ reason=denied + abort 文案 + 完结信号 deny', async () => {
    const staging = makeStaging('abort', (dir) => {
      makeSkillMd(dir, { name: 'abort-skill' })
    })
    const sink = makeSink()
    const resultPromise = runInstall({
      sourceDir: staging,
      name: 'abort-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir,
      formIdSuffix: 'abort-1'
    })
    expect(store.pendingKindForSession(SESSION)).toBe('authz')
    store.rejectForSession(SESSION, new Error('aborted'))
    const result = await resultPromise
    expect(result.reason).toBe('denied')
    expect(String(result.error)).toContain('aborted')
    expect(String(result.error)).toContain('unattended runs default to deny')
    expect(decisionNotices()[0]?.decision).toBe('deny')
  })

  test('已挂 pending（其他 ask 在挂）→ alreadyPending 直接拒', async () => {
    const staging = makeStaging('already', (dir) => {
      makeSkillMd(dir, { name: 'already-skill' })
    })
    store.registerAsk(SESSION, 'ask-pending')
    const sink = makeSink()
    const result = await runInstall({
      sourceDir: staging,
      name: 'already-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(result.reason).toBe('denied')
    expect(String(result.error)).toContain('another form or authorization request')
    // 不应推卡（已挂在前）
    expect(requestNotices()).toHaveLength(0)
    store.resolveAsk('ask-pending', { skip: true })
  })

  test('allow-rule 在 install_skill 不启用（虽 AuthzAnswerPayload 允许）→ 拒装', async () => {
    // 防御性：当前端误传 allow-rule 时不应绕过闸门
    const staging = makeStaging('rule', (dir) => {
      makeSkillMd(dir, { name: 'rule-skill' })
    })
    const sink = makeSink()
    const resultPromise = runInstall({
      sourceDir: staging,
      name: 'rule-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir,
      formIdSuffix: 'rule-1'
    })
    store.resolveAuthz('install-skill-rule-1', { decision: 'allow-rule', ruleText: 'install *' })
    const result = await resultPromise
    expect(result.reason).toBe('denied')
    // 不写盘
    expect(existsSync(join(skillsDir, 'rule-skill'))).toBe(false)
  })
})

// ── createInstallSkillTool 形态钉扎 ──

describe('createInstallSkillTool 工具形态', () => {
  test('name/label/parameters 冻结契约 + execute 走通直装', async () => {
    const staging = makeStaging('tool', (dir) => {
      makeSkillMd(dir, { name: 'tool-skill' })
    })
    const sink = makeSink()
    const tool = createInstallSkillTool({
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir
    })
    expect(tool.name).toBe('install_skill')
    expect(tool.label).toBe('Install Skill')
    // execute 缺省 formId 随机——先发起（闸门前全同步），从卡面拿真实 formId 再解锁
    const resultPromise = tool.execute('call-1', {
      source_dir: staging,
      name: 'tool-skill',
      overwrite: false
    })
    const pendingReq = requestNotices()
    expect(pendingReq).toHaveLength(1)
    store.resolveAuthz(pendingReq[0]?.formId ?? '', { decision: 'allow-once' })
    const result = await resultPromise
    const details = result.details as Record<string, unknown>
    expect(details.error).toBeUndefined()
    expect(details.name).toBe('tool-skill')
    expect(details.invocation).toBe('/skill:tool-skill')
    expect(details.effectiveNextSession).toBe(true)
    expect(typeof details.path === 'string' ? details.path.replaceAll('\\', '/') : '').toBe(
      join(skillsDir, 'tool-skill').replaceAll('\\', '/')
    )
  })

  test('tool execute 错误路径：name 非法 → 返 invalid details，无闸门', async () => {
    const staging = makeStaging('bad', (dir) => {
      makeSkillMd(dir)
    })
    const sink = makeSink()
    const tool = createInstallSkillTool({
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink
    })
    const result = await tool.execute('call-1', {
      source_dir: staging,
      name: 'Bad Name',
      overwrite: false
    })
    const details = result.details as Record<string, unknown>
    expect(details.reason).toBe('invalid')
    expect(Array.isArray(details.violations)).toBe(true)
    expect(requestNotices()).toHaveLength(0)
  })
})

// ── 端到端：数据 part 直推的 payload 形状（含 BashAuthz」/ InstallSkillAuthz 联合） ──

describe('AuthzRequestNotice 联合判别（install_skill 分支字段）', () => {
  test('install_skill 卡面 = 文件清单 + 适配点摘要（不含 command/matchedRule）', async () => {
    const staging = makeStaging('shape', (dir) => {
      makeSkillMd(dir, { name: 'shape-skill' })
      writeFileSync(join(dir, 'principles.md'), '# principles')
    })
    const sink = makeSink()
    const resultPromise = runInstall({
      sourceDir: staging,
      name: 'shape-skill',
      overwrite: false,
      rootDir,
      store,
      sessionId: SESSION,
      authzSink: sink,
      builtinSkillsDir,
      formIdSuffix: 'shape-1'
    })
    const notices = requestNotices()
    expect(notices).toHaveLength(1)
    const r0 = notices[0] as InstallSkillAuthzRequest
    expect(r0.toolName).toBe('install_skill')
    expect(r0.formId).toBe('install-skill-shape-1')
    expect(r0.sourceDir.replaceAll('\\', '/')).toBe(staging.replaceAll('\\', '/'))
    expect(r0.name).toBe('shape-skill')
    expect(r0.overwrite).toBe(false)
    expect(r0.files.sort()).toEqual(['SKILL.md', 'principles.md'])
    expect(r0.adapterSummary).toContain('files: 2')
    expect(r0.adapterSummary).toContain('description:')
    // bash 字段在 install_skill 不应出现（判别 = toolName）
    expect('command' in r0).toBe(false)
    expect('matchedRule' in r0).toBe(false)
    store.resolveAuthz('install-skill-shape-1', { decision: 'allow-once' })
    await resultPromise
  })
})
