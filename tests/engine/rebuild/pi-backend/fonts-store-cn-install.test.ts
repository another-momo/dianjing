/**
 * 字体商店中网分片集合（cn-fonts）端到端测试。
 *
 * 覆盖：
 *  - cn-fonts 内置预设 = preset:cn-fonts，kind=cn-fonts
 *  - cn-fonts 适配器目录合成（registry 撞名胜；VF 单 variable 条目；catalog 全量入）
 *  - 分片集合安装全链（fake 服 → 任务 done → manifest artifact='subset-collection'
 *    → 片文件落盘 + index.json 内容正确 + pieces/piece 端点可读）
 *  - 取消路径（慢服 → cancel → status cancelled；manifest 不写）
 *  - 坏片路径（fake 服返非字体字节 → 该 style 失败 + failures 记录）
 *  - 端点闸位：missing-family / bad-hash / piece-missing
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUILTIN_STORE_PRESETS,
  CN_FONTS_PRESET_ID
} from '@open-pencil/core/text/font/store/registry'

import { handleFontsRequest } from '@/app/ai/pi-backend/fonts/routes'
import { createFontsStore } from '@/app/ai/pi-backend/fonts/store'
import { handleFontsStoreRequest } from '@/app/ai/pi-backend/fonts/store-routes'
import { StoreTaskRegistry } from '@/app/ai/pi-backend/fonts/store-tasks'

import { startFakeFontServer, type FakeFontServer } from './fake-font-server'
import { makeFakeReq, makeFakeRes } from './fake-http'

interface FakeResExt {
  statusCode: number | undefined
  body: string
}

let server: FakeFontServer | null = null
let rootDir = ''
let store: ReturnType<typeof createFontsStore>
let tasks: StoreTaskRegistry

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'fonts-store-cn-'))
  store = createFontsStore({ rootDir })
  tasks = new StoreTaskRegistry()
})

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

function makeDeps() {
  return { store, rootDir, tasks }
}

async function waitForTask(
  taskId: string,
  predicate: (task: {
    status: string
    done: number
    failures: { style: string; reason: string }[]
  }) => boolean,
  timeoutMs = 8000
): Promise<{ status: string; done: number; failures: { style: string; reason: string }[] }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const list = tasks.list()
    const task = list.find((t) => t.id === taskId)
    if (task && predicate(task)) return task
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`task did not satisfy predicate within ${timeoutMs}ms`)
}

function postJson(path: string, body: unknown) {
  const req = makeFakeReq({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json' },
    chunks: [Buffer.from(JSON.stringify(body))]
  })
  const res = makeFakeRes() as unknown as FakeResExt
  return { req, res }
}

function getReq(path: string) {
  return makeFakeReq({ method: 'GET', url: path })
}

describe('cn-fonts 内置预设', () => {
  test('preset:cn-fonts 在 BUILTIN_STORE_PRESETS 中，kind=cn-fonts', () => {
    const cn = BUILTIN_STORE_PRESETS.find((s) => s.id === CN_FONTS_PRESET_ID)
    expect(cn).toBeDefined()
    expect(cn?.kind).toBe('cn-fonts')
    expect(cn?.builtin).toBe(true)
  })
})

describe('cn-fonts 适配器目录合成', () => {
  test('services list 内置含 preset:cn-fonts', async () => {
    const req = getReq('/api/pi/fonts/store/services')
    const res = makeFakeRes() as unknown as FakeResExt
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/services')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { services: Array<{ id: string; kind: string }> }
    const cn = body.services.find((s) => s.id === 'preset:cn-fonts')
    expect(cn).toBeDefined()
    expect(cn?.kind).toBe('cn-fonts')
  })

  test('catalog 端点返 cn-fonts 目录（LXGW WenKai 多 weight + piecesRef + fileURL 空串）', async () => {
    const req = getReq('/api/pi/fonts/store/catalog?service=preset:cn-fonts')
    const res = makeFakeRes() as unknown as FakeResExt
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/catalog')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as {
      families: Array<{
        family: string
        styles: Array<{
          style: string
          weight: number
          fileURL: string
          format: string
          piecesRef?: { package: string; version?: string }
        }>
      }>
    }
    const lxgw = body.families.find((f) => f.family === 'LXGW WenKai')
    expect(lxgw).toBeDefined()
    expect(lxgw!.styles.length).toBeGreaterThan(0)
    // 每条 style 都走 piecesRef 形态，fileURL 置空串（与 full artifact 区分）
    for (const style of lxgw!.styles) {
      expect(style.fileURL).toBe('')
      expect(style.format).toBe('woff2')
      expect(style.piecesRef).toBeDefined()
    }
    // registry 撞名胜：Source Han Serif CN VF 应只剩 variable 条目
    const shs = body.families.find((f) => f.family === 'Source Han Serif CN VF')
    expect(shs).toBeDefined()
    expect(shs!.styles.length).toBe(1)
  })
})

describe('cn-fonts 分片集合安装', () => {
  function installRequestBody(styles: string[] = ['Regular']) {
    return {
      service: 'preset:cn-fonts',
      family: 'LXGW WenKai',
      styles,
      piecesBaseURL: server?.baseURL ?? ''
    }
  }

  test('install 成功 → 任务 done + manifest subset-collection + index.json + 片', async () => {
    server = await startFakeFontServer({ mode: 'cn-install' })
    const { req, res } = postJson('/api/pi/fonts/store/install', installRequestBody())
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
    expect(res.statusCode).toBe(200)
    const start = JSON.parse(res.body) as { taskId: string; ok: boolean }
    expect(start.ok).toBe(true)

    const final = await waitForTask(start.taskId, (t) => t.status !== 'running')
    if (final.status !== 'done') {
      throw new Error(`install failed: ${JSON.stringify(final)}`)
    }
    expect(final.failures.length).toBe(0)

    // manifest 落地 + artifact=subset-collection
    const manifest = store.readManifest()
    const lxgw = manifest.families.find((f) => f.family === 'LXGW WenKai')
    expect(lxgw).toBeDefined()
    expect(lxgw!.styles.length).toBe(1)
    const style = lxgw!.styles[0]
    expect(style.artifact).toBe('subset-collection')
    expect(style.source).toBe('store')
    expect(style.key).toBe('Regular')

    // index.json 落盘 + 内容结构正确
    const index = store.readSubsetIndex('LXGW WenKai')
    expect(index).not.toBeNull()
    expect(index!.styles.length).toBeGreaterThan(0)
    for (const entry of index!.styles) {
      expect(typeof entry.hash).toBe('string')
      expect(entry.hash.length).toBe(32)
      expect(typeof entry.size).toBe('number')
      expect(entry.size).toBeGreaterThan(0)
      expect(Array.isArray(entry.ranges)).toBe(true)
      expect(entry.ranges.length).toBeGreaterThan(0)
    }

    // 片文件落盘（每条 index 都能读到字节）
    for (const entry of index!.styles) {
      const bytes = store.readSubsetPiece('LXGW WenKai', entry.hash)
      expect(bytes).not.toBeNull()
      expect(bytes!.byteLength).toBeGreaterThan(0)
    }
  })

  test('install 取消 → 任务 cancelled + manifest 不写', async () => {
    server = await startFakeFontServer({ mode: 'cn-install-cancel', pieceDelayMs: 1500 })
    const { req, res } = postJson('/api/pi/fonts/store/install', installRequestBody())
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
    const start = JSON.parse(res.body) as { taskId: string }
    await new Promise((r) => setTimeout(r, 50))
    const cancelReq = makeFakeReq({
      method: 'POST',
      url: '/api/pi/fonts/store/tasks/cancel',
      headers: { 'content-type': 'application/json' },
      chunks: [Buffer.from(JSON.stringify({ taskId: start.taskId }))]
    })
    const cancelRes = makeFakeRes() as unknown as FakeResExt
    await handleFontsStoreRequest(
      makeDeps(),
      cancelReq,
      cancelRes,
      '/api/pi/fonts/store/tasks/cancel'
    )
    expect(JSON.parse(cancelRes.body)).toEqual({ ok: true, taskId: start.taskId })

    const final = await waitForTask(start.taskId, (t) => t.status !== 'running', 4000)
    expect(final.status).toBe('cancelled')

    // manifest 不写
    const manifest = store.readManifest()
    expect(manifest.families.find((f) => f.family === 'LXGW WenKai')).toBeUndefined()
  })

  test('install 坏片 → 该 style 失败 + failures 带原因', async () => {
    server = await startFakeFontServer({ mode: 'cn-install-broken-piece' })
    const { req, res } = postJson('/api/pi/fonts/store/install', installRequestBody())
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
    const start = JSON.parse(res.body) as { taskId: string }
    const final = await waitForTask(start.taskId, (t) => t.status !== 'running', 6000)
    // 全 style 都坏 → 任务 failed（store-tasks 规则：failures.length === total）
    expect(final.status).toBe('failed')
    expect(final.failures.length).toBeGreaterThan(0)
    expect(final.failures[0].reason.length).toBeGreaterThan(0)
  })
})

describe('cn-fonts pieces / piece 端点', () => {
  async function installBefore(): Promise<void> {
    server = await startFakeFontServer({ mode: 'cn-install' })
    const { req, res } = postJson('/api/pi/fonts/store/install', {
      service: 'preset:cn-fonts',
      family: 'LXGW WenKai',
      styles: ['Regular'],
      piecesBaseURL: server.baseURL
    })
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
    const start = JSON.parse(res.body) as { taskId: string }
    await waitForTask(start.taskId, (t) => t.status !== 'running')
  }

  test('GET /pieces?family= → 200 SubsetIndex', async () => {
    await installBefore()
    const req = getReq('/api/pi/fonts/pieces?family=' + encodeURIComponent('LXGW WenKai'))
    const res = makeFakeRes() as unknown as FakeResExt
    await handleFontsRequest(makeDeps(), req, res, '/api/pi/fonts/pieces')
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { family: string; styles: unknown[] }
    expect(body.family).toBe('LXGW WenKai')
    expect(Array.isArray(body.styles)).toBe(true)
  })

  test('GET /pieces 缺 family → 400 missing-family', async () => {
    const req = getReq('/api/pi/fonts/pieces')
    const res = makeFakeRes() as unknown as FakeResExt
    await handleFontsRequest(makeDeps(), req, res, '/api/pi/fonts/pieces')
    expect(res.statusCode).toBe(400)
  })

  test('GET /pieces 不存在的族 → 404', async () => {
    const req = getReq('/api/pi/fonts/pieces?family=' + encodeURIComponent('Nonexistent'))
    const res = makeFakeRes() as unknown as FakeResExt
    await handleFontsRequest(makeDeps(), req, res, '/api/pi/fonts/pieces')
    expect(res.statusCode).toBe(404)
  })

  test('GET /piece?family=&hash= → 200 字节', async () => {
    await installBefore()
    const index = store.readSubsetIndex('LXGW WenKai')!
    const realHash = index.styles[0].hash
    const req = getReq(
      '/api/pi/fonts/piece?family=' + encodeURIComponent('LXGW WenKai') + '&hash=' + realHash
    )
    const res = makeFakeRes() as unknown as FakeResExt
    await handleFontsRequest(makeDeps(), req, res, '/api/pi/fonts/piece')
    expect(res.statusCode).toBe(200)
    expect(res.body.length).toBeGreaterThan(0)
  })

  test('GET /piece 非法 hash（路径穿防护）→ 400 bad-hash', async () => {
    const req = getReq(
      '/api/pi/fonts/piece?family=' + encodeURIComponent('LXGW WenKai') + '&hash=../../etc/passwd'
    )
    const res = makeFakeRes() as unknown as FakeResExt
    await handleFontsRequest(makeDeps(), req, res, '/api/pi/fonts/piece')
    expect(res.statusCode).toBe(400)
    expect((JSON.parse(res.body) as { code: string }).code).toBe('bad-hash')
  })

  test('GET /piece 不存在的 hash → 404 piece-missing', async () => {
    await installBefore()
    const req = getReq(
      '/api/pi/fonts/piece?family=' +
        encodeURIComponent('LXGW WenKai') +
        '&hash=00000000000000000000000000000000'
    )
    const res = makeFakeRes() as unknown as FakeResExt
    await handleFontsRequest(makeDeps(), req, res, '/api/pi/fonts/piece')
    expect(res.statusCode).toBe(404)
    expect((JSON.parse(res.body) as { code: string }).code).toBe('piece-missing')
  })
})

describe('cn-fonts pieces 落盘结构', () => {
  test('install 后族目录在 fontsRoot/<slug>/ 下 + index.json 存在', async () => {
    server = await startFakeFontServer({ mode: 'cn-install' })
    const { req, res } = postJson('/api/pi/fonts/store/install', {
      service: 'preset:cn-fonts',
      family: 'LXGW WenKai',
      styles: ['Regular'],
      piecesBaseURL: server.baseURL
    })
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
    const start = JSON.parse(res.body) as { taskId: string }
    await waitForTask(start.taskId, (t) => t.status !== 'running')
    const indexPath = join(store.fontsRoot, 'lxgw-wenkai', 'index.json')
    expect(existsSync(indexPath)).toBe(true)
  })
})
