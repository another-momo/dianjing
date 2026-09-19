/**
 * 2026-09-18 broker P0-2 shadow 观测：path-observe handler 直钉单测。
 *
 * 覆盖：六工具映射（read/grep/load_image → read facet，write/edit/
 * export_image_to_file → write facet；内建四件 input.path、load_image
 * input.file_path、export_image_to_file input.output_path）/ grep 缺省
 * path 按 cwd 观测 / export_image_to_file 省略 output_path 跳过 /
 * 不观测工具（bash/find/ls/custom）不落行 / 异常静默吞（不落盘不抛）/
 * JSONL 行格式（字段集 + ISO ts + decision/outside 语义）+ append 多行。
 *
 * 测试纪律：tmp fixture 合成根（真实 appendFileSync 落盘读回）；homeDir
 * 注入假根，禁读真实 home。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPathObserveHandler } from '@/app/ai/pi-backend/path-observe'

let rootDir = ''
let workspaceDir = ''

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'openpencil-path-observe-'))
  workspaceDir = join(rootDir, 'workspace')
  mkdirSync(workspaceDir, { recursive: true })
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** JSONL 读回形态（宽松类型——与源码 ShadowRecord 刻意不同形，type-shapes 门禁） */
interface ShadowLine {
  ts: string
  toolName: string
  facet: string
  decision: string
  outside: boolean
  path: string
}

function readLog(dir: string = rootDir): ShadowLine[] {
  const file = join(dir, 'broker-shadow.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ShadowLine)
}

function makeHandler(dir: string = rootDir) {
  return createPathObserveHandler({ rootDir: dir, cwd: workspaceDir, homeDir: join(dir, 'home') })
}

function ws(rel: string): string {
  return join(workspaceDir, rel).replaceAll('\\', '/')
}

describe('六工具映射与 facet', () => {
  test('read workspace 内文件 → read facet / allow / outside=false', () => {
    const handler = makeHandler()
    expect(handler({ toolName: 'read', input: { path: ws('a.png') } })).toBeUndefined()
    expect(readLog()).toEqual([
      expect.objectContaining({
        toolName: 'read',
        facet: 'read',
        decision: 'allow',
        outside: false,
        path: ws('a.png')
      })
    ])
  })

  test('write / edit 出界 → write facet / deny / outside=true', () => {
    const handler = makeHandler()
    const outsidePath = join(rootDir, 'out.txt').replaceAll('\\', '/')
    handler({ toolName: 'write', input: { path: outsidePath } })
    handler({ toolName: 'edit', input: { path: outsidePath } })
    const lines = readLog()
    expect(lines).toHaveLength(2)
    for (const [i, toolName] of ['write', 'edit'].entries()) {
      expect(lines[i]).toEqual(
        expect.objectContaining({ toolName, facet: 'write', decision: 'deny', outside: true })
      )
    }
  })

  test('grep 带 path → read facet；load_image file_path → read facet', () => {
    const handler = makeHandler()
    handler({ toolName: 'grep', input: { pattern: 'x', path: ws('src') } })
    handler({ toolName: 'load_image', input: { file_path: ws('logo.png') } })
    const lines = readLog()
    expect(lines).toEqual([
      expect.objectContaining({
        toolName: 'grep',
        facet: 'read',
        decision: 'allow',
        path: ws('src')
      }),
      expect.objectContaining({
        toolName: 'load_image',
        facet: 'read',
        decision: 'allow',
        path: ws('logo.png')
      })
    ])
  })

  test('export_image_to_file output_path workspace 内 → write facet / allow', () => {
    const handler = makeHandler()
    handler({ toolName: 'export_image_to_file', input: { output_path: ws('exports/hero.png') } })
    expect(readLog()).toEqual([
      expect.objectContaining({
        toolName: 'export_image_to_file',
        facet: 'write',
        decision: 'allow',
        outside: false,
        path: ws('exports/hero.png')
      })
    ])
  })

  test('deny 名单命中（workspace/.agents/**）→ deny / outside=false（非出界）', () => {
    const handler = makeHandler()
    handler({ toolName: 'write', input: { path: ws('.agents/skills/x/SKILL.md') } })
    expect(readLog()).toEqual([expect.objectContaining({ decision: 'deny', outside: false })])
  })
})

describe('缺省与跳过', () => {
  test('grep 缺省 path → 按 cwd（workspace）观测，allow', () => {
    const handler = makeHandler()
    handler({ toolName: 'grep', input: { pattern: 'x' } })
    expect(readLog()).toEqual([
      expect.objectContaining({
        toolName: 'grep',
        facet: 'read',
        decision: 'allow',
        outside: false,
        path: workspaceDir.replaceAll('\\', '/')
      })
    ])
  })

  test('export_image_to_file 省略 output_path → 跳过不落行（缺省落点恒 workspace 内）', () => {
    const handler = makeHandler()
    handler({ toolName: 'export_image_to_file', input: { format: 'PNG' } })
    expect(readLog()).toEqual([])
  })

  test('不观测工具（bash/find/ls/其他 custom）→ 不落行', () => {
    const handler = makeHandler()
    handler({ toolName: 'bash', input: { command: 'cat ~/.aws/credentials' } })
    handler({ toolName: 'find', input: { path: '/etc' } })
    handler({ toolName: 'ls', input: { path: '/etc' } })
    handler({ toolName: 'render', input: { path: ws('a.png') } })
    expect(readLog()).toEqual([])
  })
})

describe('异常静默吞与 JSONL 行格式', () => {
  test('落盘失败（rootDir 不存在 → append ENOENT）→ 不抛、返回 undefined、无文件', () => {
    const missingDir = join(rootDir, 'missing')
    const handler = makeHandler(missingDir)
    expect(handler({ toolName: 'read', input: { path: ws('a.png') } })).toBeUndefined()
    expect(existsSync(join(missingDir, 'broker-shadow.jsonl'))).toBe(false)
  })

  test('行格式：字段集恰好六件 + ts 为 ISO 时间 + append 多行', () => {
    const handler = makeHandler()
    handler({ toolName: 'read', input: { path: ws('a.png') } })
    handler({ toolName: 'read', input: { path: join(rootDir, 'b.png').replaceAll('\\', '/') } })
    const lines = readLog()
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual([
        'decision',
        'facet',
        'outside',
        'path',
        'toolName',
        'ts'
      ])
      expect(Number.isNaN(Date.parse(line.ts))).toBe(false)
      expect(line.ts).toBe(new Date(line.ts).toISOString())
    }
    expect(lines[0]?.decision).toBe('allow')
    expect(lines[1]).toEqual(expect.objectContaining({ decision: 'deny', outside: true }))
  })
})
