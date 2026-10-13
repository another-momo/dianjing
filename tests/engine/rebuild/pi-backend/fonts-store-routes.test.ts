/**
 * 字体商店路由端到端测试。
 *
 * 覆盖：
 *  - 注册自定义服务（kind=standard）→ 持久化 + 列表含内置 Fontsource
 *  - 目录代理（fake 商店服 GET /catalog.json）→ families 直通
 *  - 安装（fake 服 GET /fonts/*.otf → tests/fixtures/fonts/NotoSansCJK-Test.otf）→ 任务跑通
 *  - 重复安装短路（同 family 任务 running → shortCircuited=true，同 taskId）
 *  - 坏字节族（fake 服供垃圾字节）→ 任务 failed + failures 带原因
 *  - 取消路径（fake 服慢响应 + cancel → 任务 cancelled）
 *  - 负面路径：同名 -2 后缀 / 删除往返 404 / styles 无匹配 400 / 上游 500 → 502 /
 *    catalog 超 8MB 截断 502 / cancel 不存在与已完成 404 / 删服务取消 running 任务 /
 *    并发上限 429 / services.json 损坏兜空
 *  - 闸位回归：handleFontsRequest 商店前缀委托 + 委托未命中 404 兜底 + 非商店路径交回
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StoreInstallTaskView } from '@/app/ai/pi-backend/client-fonts'
import { handleFontsRequest } from '@/app/ai/pi-backend/fonts/routes'
import {
  createCustomServicesStore,
  slugifyServiceName
} from '@/app/ai/pi-backend/fonts/services-store'
import { createFontsStore } from '@/app/ai/pi-backend/fonts/store'
import { handleFontsStoreRequest } from '@/app/ai/pi-backend/fonts/store-routes'
import { StoreTaskRegistry } from '@/app/ai/pi-backend/fonts/store-tasks'

import { startFakeFontServer, type FakeFontServer } from './fake-font-server'
import { makeFakeReq, makeFakeRes } from './fake-http'

interface FakeRes extends Awaited<ReturnType<typeof makeFakeRes>> {
  statusCode: number | undefined
  body: string
}

let server: FakeFontServer | null = null
let rootDir = ''
let store: ReturnType<typeof createFontsStore>
let customServices: ReturnType<typeof createCustomServicesStore>
let tasks: StoreTaskRegistry

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'fonts-store-routes-'))
  store = createFontsStore({ rootDir })
  customServices = createCustomServicesStore({ rootDir })
  tasks = new StoreTaskRegistry()
})

afterEach(async () => {
  if (server) {
    await server.close()
    server = null
  }
})

function makeDeps() {
  return {
    store,
    rootDir,
    tasks,
    customServices
  }
}

async function waitForTask(
  taskId: string,
  predicate: (task: StoreInstallTaskView) => boolean,
  timeoutMs = 5000
): Promise<StoreInstallTaskView> {
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
  const res = makeFakeRes()
  return { req, res }
}

describe('字体商店路由端到端', () => {
  test('注册自定义服务 → list 含内置 + 自定义 + 持久化', async () => {
    const { req, res } = postJson('/api/pi/fonts/store/services', {
      name: 'Local Test Service',
      baseURL: 'http://127.0.0.1:0',
      kind: 'standard'
    })
    const handled = await handleFontsStoreRequest(
      makeDeps(),
      req,
      res,
      '/api/pi/fonts/store/services'
    )
    expect(handled).toBe(true)
    const reg = JSON.parse(res.body) as {
      ok: boolean
      service: { id: string; name: string; builtin: boolean }
    }
    expect(reg.ok).toBe(true)
    expect(reg.service.builtin).toBe(false)
    expect(reg.service.id.startsWith('custom:')).toBe(true)
    expect(reg.service.name).toBe('Local Test Service')

    // 持久化文件存在
    const persisted = JSON.parse(readFileSync(customServices.path, 'utf8')) as {
      services: Array<{ id: string }>
    }
    expect(persisted.services.some((s) => s.id === reg.service.id)).toBe(true)

    // list 含内置 + 自定义
    const listReq = makeFakeReq({ method: 'GET', url: '/api/pi/fonts/store/services' })
    const listRes = makeFakeRes()
    await handleFontsStoreRequest(makeDeps(), listReq, listRes, '/api/pi/fonts/store/services')
    const list = JSON.parse(listRes.body) as {
      services: Array<{ id: string; builtin: boolean }>
    }
    expect(list.services.some((s) => s.id === 'preset:fontsource' && s.builtin === true)).toBe(true)
    expect(list.services.some((s) => s.id === reg.service.id)).toBe(true)
  })

  test('注册入参校验：kind 不在白名单 / baseURL 非 http(s) → 400', async () => {
    const { req, res } = postJson('/api/pi/fonts/store/services', {
      name: 'Bad',
      baseURL: 'file:///etc/passwd',
      kind: 'fontsource'
    })
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/services')
    expect(res.statusCode).toBe(400)
  })

  test('删内置服务 → 400 builtin', async () => {
    const { req, res } = postJson('/api/pi/fonts/store/services/delete', {
      id: 'preset:fontsource'
    })
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/services/delete')
    expect(res.statusCode).toBe(400)
  })

  test('目录代理：fake 服务响应直传', async () => {
    server = await startFakeFontServer({ mode: 'catalog' })
    const serviceId = slugifyServiceName('Catalog Test')
    customServices.add({
      id: serviceId,
      name: 'Catalog Test',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const req = makeFakeReq({
      method: 'GET',
      url: `/api/pi/fonts/store/catalog?service=${encodeURIComponent(serviceId)}`
    })
    const res = makeFakeRes()
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/catalog')
    const body = JSON.parse(res.body) as {
      families: Array<{ family: string; styles: Array<{ style: string }> }>
    }
    expect(body.families.length).toBeGreaterThan(0)
    const familyNames = body.families.map((f) => f.family)
    expect(familyNames).toContain('Noto Sans CJK Test')
  })

  test('install：成功跑通 → 任务 done + manifest 落盘 + 字节可读', async () => {
    server = await startFakeFontServer({ mode: 'install' })
    const serviceId = slugifyServiceName('Install Test')
    customServices.add({
      id: serviceId,
      name: 'Install Test',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const { req, res } = postJson('/api/pi/fonts/store/install', {
      service: serviceId,
      family: 'Noto Sans CJK Test'
    })
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
    const start = JSON.parse(res.body) as { ok: boolean; taskId: string; shortCircuited: boolean }
    expect(start.ok).toBe(true)
    expect(start.shortCircuited).toBe(false)

    const final = await waitForTask(start.taskId, (t) => t.status !== 'running')
    expect(final.status).toBe('done')
    expect(final.failures.length).toBe(0)

    // manifest 落盘且字节可读（family 来自 validateFontBytes 的 name 表 = 'Noto Sans CJK SC'）
    const manifest = store.readManifest()
    const family = manifest.families.find((f) => f.family === 'Noto Sans CJK SC')
    expect(family).toBeDefined()
    expect(family!.styles.length).toBeGreaterThan(0)
    const firstStyle = family!.styles[0]
    expect(firstStyle.source).toBe('store')
    const bytes = store.readBytes(firstStyle.hash, firstStyle.ext ?? 'ttf')
    expect(bytes).not.toBeNull()
    expect(bytes!.byteLength).toBeGreaterThan(0)
  })

  test('install：重复 install 同 family 短路（同 taskId + shortCircuited=true）', async () => {
    server = await startFakeFontServer({ mode: 'install', delayMs: 200 })
    const serviceId = slugifyServiceName('Shortcut Test')
    customServices.add({
      id: serviceId,
      name: 'Shortcut Test',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })

    const first = postJson('/api/pi/fonts/store/install', {
      service: serviceId,
      family: 'Noto Sans CJK Test'
    })
    await handleFontsStoreRequest(makeDeps(), first.req, first.res, '/api/pi/fonts/store/install')
    const firstBody = JSON.parse(first.res.body) as { taskId: string; shortCircuited: boolean }
    expect(firstBody.shortCircuited).toBe(false)

    // 第二个请求在任务 running 期间触发
    const second = postJson('/api/pi/fonts/store/install', {
      service: serviceId,
      family: 'Noto Sans CJK Test'
    })
    await handleFontsStoreRequest(makeDeps(), second.req, second.res, '/api/pi/fonts/store/install')
    const secondBody = JSON.parse(second.res.body) as { taskId: string; shortCircuited: boolean }
    expect(secondBody.shortCircuited).toBe(true)
    expect(secondBody.taskId).toBe(firstBody.taskId)

    // 等任务跑完清理
    await waitForTask(firstBody.taskId, (t) => t.status !== 'running')
  })

  test('install：坏字节族 → 任务 failed + failures 带原因', async () => {
    server = await startFakeFontServer({ mode: 'broken' })
    const serviceId = slugifyServiceName('Broken Test')
    customServices.add({
      id: serviceId,
      name: 'Broken Test',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const { req, res } = postJson('/api/pi/fonts/store/install', {
      service: serviceId,
      family: 'Garbage Font'
    })
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
    const start = JSON.parse(res.body) as { taskId: string }
    const final = await waitForTask(start.taskId, (t) => t.status !== 'running', 5000)
    expect(final.status).toBe('failed')
    expect(final.failures.length).toBeGreaterThan(0)
    expect(final.failures[0].reason.length).toBeGreaterThan(0)
  })

  test('cancel：取消路径 → 任务 cancelled', async () => {
    server = await startFakeFontServer({ mode: 'install', delayMs: 1500 })
    const serviceId = slugifyServiceName('Cancel Test')
    customServices.add({
      id: serviceId,
      name: 'Cancel Test',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const { req, res } = postJson('/api/pi/fonts/store/install', {
      service: serviceId,
      family: 'Noto Sans CJK Test'
    })
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
    const start = JSON.parse(res.body) as { taskId: string }

    // 任务在跑后立刻 cancel
    await new Promise((r) => setTimeout(r, 50))
    const cancelReq = makeFakeReq({
      method: 'POST',
      url: '/api/pi/fonts/store/tasks/cancel',
      headers: { 'content-type': 'application/json' },
      chunks: [Buffer.from(JSON.stringify({ taskId: start.taskId }))]
    })
    const cancelRes = makeFakeRes()
    await handleFontsStoreRequest(
      makeDeps(),
      cancelReq,
      cancelRes,
      '/api/pi/fonts/store/tasks/cancel'
    )
    expect(JSON.parse(cancelRes.body)).toEqual({ ok: true, taskId: start.taskId })

    const final = await waitForTask(start.taskId, (t) => t.status !== 'running', 3000)
    expect(final.status).toBe('cancelled')
  })

  test('catalog：service 不存在 → 404', async () => {
    const req = makeFakeReq({
      method: 'GET',
      url: '/api/pi/fonts/store/catalog?service=custom:nonexistent'
    })
    const res = makeFakeRes()
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/catalog')
    expect(res.statusCode).toBe(404)
  })
})

describe('handleFontsRequest 商店委托（闸位回归）', () => {
  test('商店前缀委托 storeRouter；委托未命中兜底 404；非商店未知路径交回调用方', async () => {
    // 委托到达（server.ts 闸位放行 /api/pi/fonts/store/ 前缀后走这里）
    let delegated: string | null = null
    const res1 = makeFakeRes()
    const handled1 = await handleFontsRequest(
      {
        store,
        storeRouter: (_req, _res, pathname) => {
          delegated = pathname
          return Promise.resolve(true)
        }
      },
      makeFakeReq({ method: 'GET', url: '/api/pi/fonts/store/services' }),
      res1,
      '/api/pi/fonts/store/services'
    )
    expect(handled1).toBe(true)
    expect(delegated).toBe('/api/pi/fonts/store/services')

    // 委托未命中的商店子路径必须兜底 404——server.ts 已 return，不写响应即挂起
    const res2 = makeFakeRes()
    const handled2 = await handleFontsRequest(
      { store, storeRouter: () => Promise.resolve(false) },
      makeFakeReq({ method: 'GET', url: '/api/pi/fonts/store/nope' }),
      res2,
      '/api/pi/fonts/store/nope'
    )
    expect(handled2).toBe(true)
    expect(res2.statusCode).toBe(404)

    // 非商店未知路径 → false 交回调用方
    const res3 = makeFakeRes()
    const handled3 = await handleFontsRequest(
      { store },
      makeFakeReq({ method: 'GET', url: '/api/pi/fonts/unknown' }),
      res3,
      '/api/pi/fonts/unknown'
    )
    expect(handled3).toBe(false)
  })
})

describe('负面路径与边界', () => {
  test('同名服务注册两次 → 第二次 id 加 -2 后缀', async () => {
    const first = postJson('/api/pi/fonts/store/services', {
      name: 'Dup Service',
      baseURL: 'http://127.0.0.1:0',
      kind: 'standard'
    })
    await handleFontsStoreRequest(makeDeps(), first.req, first.res, '/api/pi/fonts/store/services')
    const firstId = (JSON.parse(first.res.body) as { service: { id: string } }).service.id

    const second = postJson('/api/pi/fonts/store/services', {
      name: 'Dup Service',
      baseURL: 'http://127.0.0.1:0',
      kind: 'standard'
    })
    await handleFontsStoreRequest(
      makeDeps(),
      second.req,
      second.res,
      '/api/pi/fonts/store/services'
    )
    const secondId = (JSON.parse(second.res.body) as { service: { id: string } }).service.id
    expect(secondId).toBe(`${firstId}-2`)
  })

  test('删除自定义服务 → 200 + list 不再含；删不存在 → 404', async () => {
    const reg = postJson('/api/pi/fonts/store/services', {
      name: 'Deletable',
      baseURL: 'http://127.0.0.1:0',
      kind: 'standard'
    })
    await handleFontsStoreRequest(makeDeps(), reg.req, reg.res, '/api/pi/fonts/store/services')
    const serviceId = (JSON.parse(reg.res.body) as { service: { id: string } }).service.id

    const del = postJson('/api/pi/fonts/store/services/delete', { id: serviceId })
    await handleFontsStoreRequest(
      makeDeps(),
      del.req,
      del.res,
      '/api/pi/fonts/store/services/delete'
    )
    expect(del.res.statusCode).toBe(200)

    const listReq = makeFakeReq({ method: 'GET', url: '/api/pi/fonts/store/services' })
    const listRes = makeFakeRes()
    await handleFontsStoreRequest(makeDeps(), listReq, listRes, '/api/pi/fonts/store/services')
    const list = JSON.parse(listRes.body) as { services: Array<{ id: string }> }
    expect(list.services.some((x) => x.id === serviceId)).toBe(false)

    const delAgain = postJson('/api/pi/fonts/store/services/delete', { id: serviceId })
    await handleFontsStoreRequest(
      makeDeps(),
      delAgain.req,
      delAgain.res,
      '/api/pi/fonts/store/services/delete'
    )
    expect(delAgain.res.statusCode).toBe(404)
  })

  test('install styles 过滤无匹配 → 400 no-styles', async () => {
    server = await startFakeFontServer({ mode: 'catalog' })
    const serviceId = slugifyServiceName('NoStyles Test')
    customServices.add({
      id: serviceId,
      name: 'NoStyles Test',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const { req, res } = postJson('/api/pi/fonts/store/install', {
      service: serviceId,
      family: 'Noto Sans CJK Test',
      styles: ['No Such Style']
    })
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
    expect(res.statusCode).toBe(400)
    expect((JSON.parse(res.body) as { code: string }).code).toBe('no-styles')
  })

  test('catalog 上游 500 → 502 catalog-fetch-failed', async () => {
    server = await startFakeFontServer({ mode: 'catalog-500' })
    const serviceId = slugifyServiceName('Upstream500')
    customServices.add({
      id: serviceId,
      name: 'Upstream500',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const req = makeFakeReq({
      method: 'GET',
      url: `/api/pi/fonts/store/catalog?service=${encodeURIComponent(serviceId)}`
    })
    const res = makeFakeRes()
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/catalog')
    expect(res.statusCode).toBe(502)
    expect((JSON.parse(res.body) as { code: string }).code).toBe('catalog-fetch-failed')
  })

  test('catalog 响应超 8MB 上限 → 502（流式截断兜底接线回归）', async () => {
    server = await startFakeFontServer({ mode: 'huge-catalog' })
    const serviceId = slugifyServiceName('HugeCatalog')
    customServices.add({
      id: serviceId,
      name: 'HugeCatalog',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const req = makeFakeReq({
      method: 'GET',
      url: `/api/pi/fonts/store/catalog?service=${encodeURIComponent(serviceId)}`
    })
    const res = makeFakeRes()
    await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/catalog')
    expect(res.statusCode).toBe(502)
    const body = JSON.parse(res.body) as { code: string; error: string }
    expect(body.code).toBe('catalog-fetch-failed')
    expect(body.error).toContain('exceeds')
  }, 15_000)

  test('cancel 不存在 / 已完成 taskId → 404', async () => {
    const missing = postJson('/api/pi/fonts/store/tasks/cancel', { taskId: 'no-such-task' })
    await handleFontsStoreRequest(
      makeDeps(),
      missing.req,
      missing.res,
      '/api/pi/fonts/store/tasks/cancel'
    )
    expect(missing.res.statusCode).toBe(404)

    server = await startFakeFontServer({ mode: 'install' })
    const serviceId = slugifyServiceName('CancelDone')
    customServices.add({
      id: serviceId,
      name: 'CancelDone',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const install = postJson('/api/pi/fonts/store/install', {
      service: serviceId,
      family: 'Noto Sans CJK Test'
    })
    await handleFontsStoreRequest(
      makeDeps(),
      install.req,
      install.res,
      '/api/pi/fonts/store/install'
    )
    const { taskId } = JSON.parse(install.res.body) as { taskId: string }
    await waitForTask(taskId, (t) => t.status === 'done')
    const done = postJson('/api/pi/fonts/store/tasks/cancel', { taskId })
    await handleFontsStoreRequest(
      makeDeps(),
      done.req,
      done.res,
      '/api/pi/fonts/store/tasks/cancel'
    )
    expect(done.res.statusCode).toBe(404)
  })

  test('删除服务 → 其名下 running 安装任务被主动取消（防幽灵来源）', async () => {
    server = await startFakeFontServer({ mode: 'install', delayMs: 300 })
    const serviceId = slugifyServiceName('DeleteCancels')
    customServices.add({
      id: serviceId,
      name: 'DeleteCancels',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const install = postJson('/api/pi/fonts/store/install', {
      service: serviceId,
      family: 'Noto Sans CJK Test'
    })
    await handleFontsStoreRequest(
      makeDeps(),
      install.req,
      install.res,
      '/api/pi/fonts/store/install'
    )
    const { taskId } = JSON.parse(install.res.body) as { taskId: string }

    const del = postJson('/api/pi/fonts/store/services/delete', { id: serviceId })
    await handleFontsStoreRequest(
      makeDeps(),
      del.req,
      del.res,
      '/api/pi/fonts/store/services/delete'
    )
    expect(del.res.statusCode).toBe(200)

    const final = await waitForTask(taskId, (t) => t.status !== 'running', 3000)
    expect(final.status).toBe('cancelled')
  })

  test('并发上限：8 个 running 后再装 → 429 busy', async () => {
    server = await startFakeFontServer({ mode: 'install', delayMs: 300 })
    for (let i = 0; i < 8; i++) {
      const id = `custom:busy-${i}`
      customServices.add({
        id,
        name: `Busy ${i}`,
        kind: 'standard',
        baseURL: server.baseURL,
        builtin: false
      })
      const { req, res } = postJson('/api/pi/fonts/store/install', {
        service: id,
        family: 'Noto Sans CJK Test'
      })
      await handleFontsStoreRequest(makeDeps(), req, res, '/api/pi/fonts/store/install')
      expect(res.statusCode).toBe(200)
    }
    expect(tasks.countRunning()).toBe(8)

    const ninthId = 'custom:busy-8'
    customServices.add({
      id: ninthId,
      name: 'Busy 8',
      kind: 'standard',
      baseURL: server.baseURL,
      builtin: false
    })
    const ninth = postJson('/api/pi/fonts/store/install', {
      service: ninthId,
      family: 'Noto Sans CJK Test'
    })
    await handleFontsStoreRequest(makeDeps(), ninth.req, ninth.res, '/api/pi/fonts/store/install')
    expect(ninth.res.statusCode).toBe(429)
    expect((JSON.parse(ninth.res.body) as { code: string }).code).toBe('busy')
  }, 15_000)

  test('services.json 损坏 → list 兜空（内置仍在，不阻断）', async () => {
    mkdirSync(join(rootDir, 'fonts'), { recursive: true })
    writeFileSync(customServices.path, '{not valid json', 'utf8')
    // 损坏读容错发生在新实例首次读（既有实例有缓存）——新建实例模拟重启后读取
    const fresh = createCustomServicesStore({ rootDir })
    const listReq = makeFakeReq({ method: 'GET', url: '/api/pi/fonts/store/services' })
    const listRes = makeFakeRes()
    await handleFontsStoreRequest(
      { store, rootDir, tasks, customServices: fresh },
      listReq,
      listRes,
      '/api/pi/fonts/store/services'
    )
    expect(listRes.statusCode).toBe(200)
    const list = JSON.parse(listRes.body) as { services: Array<{ id: string; builtin: boolean }> }
    // 内置预设：fontsource + cn-fonts（批 4b 新增）
    expect(list.services.length).toBeGreaterThanOrEqual(1)
    expect(list.services.some((s) => s.id === 'preset:fontsource')).toBe(true)
  })
})

// Re-export fake-http helper path for runtime resolution
export {}
