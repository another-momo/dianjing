/**
 * 2026-09-18 userdata 目录重排：存量一次性迁移（migrate.ts）钉扎——规格
 * docs/202609181334-userdata-relayout-research.md §5.3 各分支。
 *
 * 覆盖：
 *  studio → workspace/.agents：
 *   - 正常 rename（同卷快路径）：内容一致 + 旧位消失
 *   - 新目录已存在 → 跳过 + warn（半态/已迁过，用户资产优先）
 *   - rename 失败 → copy + 逐项 verify + delete 兜底
 *   - rename + copy 双失败 → 半态 warn 不抛、旧目录保留
 *   - 无旧目录 → no-op（无 warn）
 *  image-gen-output 平铺 → workspace/image-gen-output/<YYYY-MM-DD>/：
 *   - 合法日期前缀分桶 / 解析失败进 legacy/ / 子目录条目进 legacy/
 *   - 目标已存在同名 → 跳过不覆盖 + warn、旧目录保留
 *   - 幂等：二次运行 no-op
 *   - 迁移异常仅 warn 不阻断
 *
 * 测试纪律：禁读真实 env；全走 tmp fixture + deps 注入（rename/copyFile/warn）。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrateUserdataLayout } from '@/app/ai/pi-backend/migrate'

let rootDir = ''

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'userdata-migrate-'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

const LEGACY_STUDIO = (): string => join(rootDir, 'studio')
const NEW_AGENTS = (): string => join(rootDir, 'workspace', '.agents')
const LEGACY_IMAGE_GEN = (): string => join(rootDir, 'image-gen-output')
const NEW_IMAGE_GEN = (): string => join(rootDir, 'workspace', 'image-gen-output')

/** 造一份旧 studio 目录（嵌套结构 + 中文内容字节） */
function makeLegacyStudio(): void {
  mkdirSync(join(LEGACY_STUDIO(), 'workflows', 'wf-a'), { recursive: true })
  writeFileSync(join(LEGACY_STUDIO(), 'base.md'), '# 用户基座\n', 'utf8')
  writeFileSync(
    join(LEGACY_STUDIO(), 'workflows', 'wf-a', 'workflow.md'),
    '---\nid: wf-a\n---\n正文\n',
    'utf8'
  )
}

describe('migrateUserdataLayout — studio → workspace/.agents', () => {
  test('正常 rename：整目录搬入新位，内容一致，旧位消失', () => {
    makeLegacyStudio()
    const warns: string[] = []
    migrateUserdataLayout(rootDir, { warn: (m) => warns.push(m) })

    expect(existsSync(LEGACY_STUDIO())).toBe(false)
    expect(readFileSync(join(NEW_AGENTS(), 'base.md'), 'utf8')).toBe('# 用户基座\n')
    expect(readFileSync(join(NEW_AGENTS(), 'workflows', 'wf-a', 'workflow.md'), 'utf8')).toContain(
      'id: wf-a'
    )
    expect(warns).toEqual([])
  })

  test('新目录已存在 → 跳过 + warn，旧目录保留（半态/已迁过）', () => {
    makeLegacyStudio()
    mkdirSync(NEW_AGENTS(), { recursive: true })
    writeFileSync(join(NEW_AGENTS(), 'base.md'), '# 已存在\n', 'utf8')
    const warns: string[] = []
    migrateUserdataLayout(rootDir, { warn: (m) => warns.push(m) })

    // 旧目录保留、新目录内容不被覆盖
    expect(existsSync(LEGACY_STUDIO())).toBe(true)
    expect(readFileSync(join(NEW_AGENTS(), 'base.md'), 'utf8')).toBe('# 已存在\n')
    expect(warns.length).toBeGreaterThan(0)
    expect(warns[0]).toContain('已存在')
  })

  test('rename 失败 → copy + verify + delete 兜底成功', () => {
    makeLegacyStudio()
    const warns: string[] = []
    migrateUserdataLayout(rootDir, {
      rename: () => {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
          code: 'EXDEV'
        })
      },
      warn: (m) => warns.push(m)
    })

    expect(existsSync(LEGACY_STUDIO())).toBe(false)
    expect(readFileSync(join(NEW_AGENTS(), 'base.md'), 'utf8')).toBe('# 用户基座\n')
    expect(readFileSync(join(NEW_AGENTS(), 'workflows', 'wf-a', 'workflow.md'), 'utf8')).toContain(
      'id: wf-a'
    )
    // 兜底路径出声（rename 失败 warn）
    expect(warns.some((m) => m.includes('rename'))).toBe(true)
  })

  test('rename + copy 双失败 → 半态 warn 不抛，旧目录保留', () => {
    makeLegacyStudio()
    const warns: string[] = []
    migrateUserdataLayout(rootDir, {
      rename: () => {
        throw new Error('EBUSY: locked')
      },
      copyFile: () => {
        throw new Error('EACCES: permission denied')
      },
      warn: (m) => warns.push(m)
    })

    // 不阻断：旧目录完整保留（用户资产优先）
    expect(existsSync(join(LEGACY_STUDIO(), 'base.md'))).toBe(true)
    expect(existsSync(join(LEGACY_STUDIO(), 'workflows', 'wf-a', 'workflow.md'))).toBe(true)
    expect(warns.length).toBeGreaterThan(0)
  })

  test('无旧目录 → no-op（无 warn）', () => {
    const warns: string[] = []
    migrateUserdataLayout(rootDir, { warn: (m) => warns.push(m) })
    expect(warns).toEqual([])
    expect(existsSync(NEW_AGENTS())).toBe(false)
  })
})

describe('migrateUserdataLayout — image-gen-output 平铺 → workspace/image-gen-output/日期桶', () => {
  function makeLegacyImageGen(): void {
    mkdirSync(LEGACY_IMAGE_GEN(), { recursive: true })
    writeFileSync(join(LEGACY_IMAGE_GEN(), '20260901-123000-0-1024x768.png'), 'AAAA')
    writeFileSync(join(LEGACY_IMAGE_GEN(), '20260901-123001-1-1024x768.png'), 'BBBB')
    writeFileSync(join(LEGACY_IMAGE_GEN(), '20260917-235959-0-512x512.png'), 'CCCC')
  }

  test('合法日期前缀分桶搬入，旧目录清空后删除', () => {
    makeLegacyImageGen()
    const warns: string[] = []
    migrateUserdataLayout(rootDir, { warn: (m) => warns.push(m) })

    expect(existsSync(LEGACY_IMAGE_GEN())).toBe(false)
    expect(
      readFileSync(join(NEW_IMAGE_GEN(), '2026-09-01', '20260901-123000-0-1024x768.png'), 'utf8')
    ).toBe('AAAA')
    expect(
      readFileSync(join(NEW_IMAGE_GEN(), '2026-09-01', '20260901-123001-1-1024x768.png'), 'utf8')
    ).toBe('BBBB')
    expect(
      readFileSync(join(NEW_IMAGE_GEN(), '2026-09-17', '20260917-235959-0-512x512.png'), 'utf8')
    ).toBe('CCCC')
    expect(warns).toEqual([])
  })

  test('解析失败（手动放入的文件）进 legacy/ 子目录；非法日期前缀同归 legacy', () => {
    makeLegacyImageGen()
    writeFileSync(join(LEGACY_IMAGE_GEN(), 'manual-note.txt'), 'manual')
    writeFileSync(join(LEGACY_IMAGE_GEN(), '20261301-000000-0-1x1.png'), 'BADMONTH')
    migrateUserdataLayout(rootDir, { warn: () => undefined })

    expect(readFileSync(join(NEW_IMAGE_GEN(), 'legacy', 'manual-note.txt'), 'utf8')).toBe('manual')
    // 月份 13 越界 → legacy
    expect(readFileSync(join(NEW_IMAGE_GEN(), 'legacy', '20261301-000000-0-1x1.png'), 'utf8')).toBe(
      'BADMONTH'
    )
    // 合法前缀仍正常分桶
    expect(existsSync(join(NEW_IMAGE_GEN(), '2026-09-01', '20260901-123000-0-1024x768.png'))).toBe(
      true
    )
  })

  test('子目录条目（平铺期不存在 = 手动放入）整体进 legacy/', () => {
    makeLegacyImageGen()
    mkdirSync(join(LEGACY_IMAGE_GEN(), 'sub-dir'), { recursive: true })
    writeFileSync(join(LEGACY_IMAGE_GEN(), 'sub-dir', 'x.png'), 'X')
    migrateUserdataLayout(rootDir, { warn: () => undefined })

    expect(readFileSync(join(NEW_IMAGE_GEN(), 'legacy', 'sub-dir', 'x.png'), 'utf8')).toBe('X')
  })

  test('目标已存在同名 → 跳过不覆盖 + warn，旧目录保留（非空不删）', () => {
    makeLegacyImageGen()
    mkdirSync(join(NEW_IMAGE_GEN(), '2026-09-01'), { recursive: true })
    writeFileSync(join(NEW_IMAGE_GEN(), '2026-09-01', '20260901-123000-0-1024x768.png'), 'EXISTING')
    const warns: string[] = []
    migrateUserdataLayout(rootDir, { warn: (m) => warns.push(m) })

    // 已存在条目不覆盖
    expect(
      readFileSync(join(NEW_IMAGE_GEN(), '2026-09-01', '20260901-123000-0-1024x768.png'), 'utf8')
    ).toBe('EXISTING')
    // 其余条目照常搬入
    expect(existsSync(join(NEW_IMAGE_GEN(), '2026-09-17', '20260917-235959-0-512x512.png'))).toBe(
      true
    )
    // 旧目录因跳过项保留 + warn 出声
    expect(existsSync(join(LEGACY_IMAGE_GEN(), '20260901-123000-0-1024x768.png'))).toBe(true)
    expect(warns.some((m) => m.includes('已存在'))).toBe(true)
  })

  test('幂等：二次运行 no-op（无 warn、内容不变）', () => {
    makeLegacyStudio()
    makeLegacyImageGen()
    migrateUserdataLayout(rootDir, { warn: () => undefined })
    const warns: string[] = []
    migrateUserdataLayout(rootDir, { warn: (m) => warns.push(m) })

    expect(warns).toEqual([])
    expect(readFileSync(join(NEW_AGENTS(), 'base.md'), 'utf8')).toBe('# 用户基座\n')
    expect(
      readFileSync(join(NEW_IMAGE_GEN(), '2026-09-01', '20260901-123000-0-1024x768.png'), 'utf8')
    ).toBe('AAAA')
  })

  test('迁移异常仅 warn 不阻断（rename/copy 双失败 → 不抛）', () => {
    makeLegacyImageGen()
    const warns: string[] = []
    expect(() =>
      migrateUserdataLayout(rootDir, {
        rename: () => {
          throw new Error('EIO')
        },
        copyFile: () => {
          throw new Error('EIO')
        },
        warn: (m) => warns.push(m)
      })
    ).not.toThrow()
    expect(warns.length).toBeGreaterThan(0)
  })
})
