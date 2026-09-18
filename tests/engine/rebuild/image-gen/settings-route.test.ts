/**
 * 图片本地留存 settings 路由钉扎（同 credentials 路由测试形态：
 * 真 HTTP server + fetch，不 mock req/res）——
 *
 * 覆盖：GET 形态（含 dir 字段 + 缺省 OFF）/ PUT 往返 / 非 boolean 400 JSON 信封 /
 * 方法白名单 / 鉴权失败 false（handler 收到非本面路径返回 false 由 caller 兜 404）。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createImageGenCredentialStore,
  type ImageGenCredentialStore
} from '@/app/ai/pi-backend/image-gen/credentials'
import { handleImageGenAdminRequest } from '@/app/ai/pi-backend/image-gen/routes'
import {
  createImageGenSettingsStore,
  type ImageGenSettingsStatus,
  type ImageGenSettingsStore
} from '@/app/ai/pi-backend/image-gen/settings'

function tempRoot(): { rootDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openpencil-imagegen-settings-route-'))
  // agentDir 必须存在（settings store 写盘前 mkdirSync 兜底，但 GET 路径不依赖落盘）
  return { rootDir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function withServer(
  args: { credentials: ImageGenCredentialStore; settings: ImageGenSettingsStore; rootDir: string },
  run: (baseURL: string) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void handleImageGenAdminRequest(args, req, res, url.pathname).then((handled) => {
      if (!handled) res.writeHead(404).end('Not Found')
      return undefined
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}

function putJSON(baseURL: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseURL}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('GET/PUT /api/pi/image-gen/settings', () => {
  test('GET 缺省 OFF：retainLocal:false + dir 为 <rootDir>/workspace/image-gen-output/（绝对路径）', async () => {
    const { rootDir, cleanup } = tempRoot()
    try {
      const credentials = createImageGenCredentialStore({ agentDir: join(rootDir, 'pi-agent') })
      const settings = createImageGenSettingsStore({ agentDir: join(rootDir, 'pi-agent') })
      await withServer({ credentials, settings, rootDir }, async (baseURL) => {
        const res = await fetch(`${baseURL}/api/pi/image-gen/settings`)
        expect(res.status).toBe(200)
        const body = (await res.json()) as ImageGenSettingsStatus
        expect(body.retainLocal).toBe(false)
        expect(body.dir.replaceAll('\\', '/')).toBe(
          join(rootDir, 'workspace', 'image-gen-output').replaceAll('\\', '/')
        )
        expect(body.dir.length).toBeGreaterThan(0)
      })
    } finally {
      cleanup()
    }
  })

  test('PUT true → 落盘；GET 回最新；PUT false 切回', async () => {
    const { rootDir, cleanup } = tempRoot()
    try {
      const credentials = createImageGenCredentialStore({ agentDir: join(rootDir, 'pi-agent') })
      const settings = createImageGenSettingsStore({ agentDir: join(rootDir, 'pi-agent') })
      await withServer({ credentials, settings, rootDir }, async (baseURL) => {
        const put1 = await putJSON(baseURL, '/api/pi/image-gen/settings', { retainLocal: true })
        expect(put1.status).toBe(200)
        const body1 = (await put1.json()) as ImageGenSettingsStatus
        expect(body1.retainLocal).toBe(true)
        expect(body1.dir).toBe(join(rootDir, 'workspace', 'image-gen-output'))

        // 后续 GET 跟随
        const get1 = await fetch(`${baseURL}/api/pi/image-gen/settings`)
        expect(((await get1.json()) as ImageGenSettingsStatus).retainLocal).toBe(true)

        const put2 = await putJSON(baseURL, '/api/pi/image-gen/settings', { retainLocal: false })
        expect(put2.status).toBe(200)
        const get2 = await fetch(`${baseURL}/api/pi/image-gen/settings`)
        expect(((await get2.json()) as ImageGenSettingsStatus).retainLocal).toBe(false)
      })
    } finally {
      cleanup()
    }
  })

  test('PUT 非 boolean → 400 JSON 信封（前端可解出原因文案）', async () => {
    const { rootDir, cleanup } = tempRoot()
    try {
      const credentials = createImageGenCredentialStore({ agentDir: join(rootDir, 'pi-agent') })
      const settings = createImageGenSettingsStore({ agentDir: join(rootDir, 'pi-agent') })
      await withServer({ credentials, settings, rootDir }, async (baseURL) => {
        for (const body of [{ retainLocal: 'yes' }, { retainLocal: 1 }, {}]) {
          const res = await putJSON(baseURL, '/api/pi/image-gen/settings', body)
          expect(res.status).toBe(400)
          const envelope = (await res.json()) as { error?: string }
          expect(typeof envelope.error).toBe('string')
          expect(envelope.error?.length ?? 0).toBeGreaterThan(0)
        }
        // 缺省仍为 OFF（PUT 校验失败不动落盘）
        const get = await fetch(`${baseURL}/api/pi/image-gen/settings`)
        expect(((await get.json()) as ImageGenSettingsStatus).retainLocal).toBe(false)
      })
    } finally {
      cleanup()
    }
  })

  test('GET / PUT 之外方法（POST/DELETE）→ 405', async () => {
    const { rootDir, cleanup } = tempRoot()
    try {
      const credentials = createImageGenCredentialStore({ agentDir: join(rootDir, 'pi-agent') })
      const settings = createImageGenSettingsStore({ agentDir: join(rootDir, 'pi-agent') })
      await withServer({ credentials, settings, rootDir }, async (baseURL) => {
        const post = await fetch(`${baseURL}/api/pi/image-gen/settings`, { method: 'POST' })
        expect(post.status).toBe(405)
        const del = await fetch(`${baseURL}/api/pi/image-gen/settings`, { method: 'DELETE' })
        expect(del.status).toBe(405)
      })
    } finally {
      cleanup()
    }
  })

  test('非本面路径 → handler false → 404（钉路径分派契约）', async () => {
    const { rootDir, cleanup } = tempRoot()
    try {
      const credentials = createImageGenCredentialStore({ agentDir: join(rootDir, 'pi-agent') })
      const settings = createImageGenSettingsStore({ agentDir: join(rootDir, 'pi-agent') })
      await withServer({ credentials, settings, rootDir }, async (baseURL) => {
        const res = await fetch(`${baseURL}/api/pi/image-gen/unknown`)
        expect(res.status).toBe(404)
      })
    } finally {
      cleanup()
    }
  })

  test('PUT 坏 JSON → 400（retainLocal 缺字段等同非 boolean）', async () => {
    const { rootDir, cleanup } = tempRoot()
    try {
      const credentials = createImageGenCredentialStore({ agentDir: join(rootDir, 'pi-agent') })
      const settings = createImageGenSettingsStore({ agentDir: join(rootDir, 'pi-agent') })
      await withServer({ credentials, settings, rootDir }, async (baseURL) => {
        const res = await fetch(`${baseURL}/api/pi/image-gen/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{not-json'
        })
        expect(res.status).toBe(400)
      })
    } finally {
      cleanup()
    }
  })
})
