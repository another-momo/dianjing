/**
 * T66（P0/P1）：generate_image 凭证 HTTP 面钉扎（真 HTTP server + fetch，
 * 同 tests/engine/mcp/stdio/auth.test.ts 先例——不 mock req/res）——
 * POST 四键（providerType/baseUrl/model/apiKey）校验与空 key 清除分派。
 * T71：POST /test 连接探针端点移除（owner 裁决 2026-09-01：并非所有
 * provider 实现 /models 端点）——补钉 4xx 一律 JSON 信封（前端只解 JSON）。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createImageGenCredentialStore,
  type ImageGenCredentialStatus,
  type ImageGenCredentialStore
} from '@/app/ai/pi-backend/image-gen/credentials'
import { handleImageGenAdminRequest } from '@/app/ai/pi-backend/image-gen/routes'
import {
  createImageGenSettingsStore,
  type ImageGenSettingsStore
} from '@/app/ai/pi-backend/image-gen/settings'

const VALID_BODY = {
  providerType: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-image-1',
  apiKey: 'sk-route-test'
}

function tempAgentDir(): { agentDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openpencil-imagegen-routes-'))
  return { agentDir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 挂 handler 起真 server；handler 返回 false 时落 404（钉路径分派契约） */
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

function postJSON(baseURL: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseURL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('POST /api/pi/image-gen/credentials（四键）', () => {
  test('四键齐全 → set 落盘；GET status 回 providerType/baseUrl/model 且不回 key', async () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      const settings = createImageGenSettingsStore({ agentDir })
      await withServer({ credentials: store, settings, rootDir: agentDir }, async (baseURL) => {
        const saved = await postJSON(baseURL, '/api/pi/image-gen/credentials', VALID_BODY)
        expect(saved.status).toBe(200)
        expect(store.get()?.model).toBe('gpt-image-1')

        const statusResponse = await fetch(`${baseURL}/api/pi/image-gen/credentials`)
        const status = (await statusResponse.json()) as ImageGenCredentialStatus
        expect(status.configured).toBe(true)
        expect(status.providerType).toBe('openai-compatible')
        expect(status.baseUrl).toBe('https://api.example.com/v1')
        expect(JSON.stringify(status)).not.toContain('sk-route-test')
      })
    } finally {
      cleanup()
    }
  })

  test('缺字段 → 400 JSON 信封（前端可解出原因文案，不再只有「HTTP 400」）', async () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      const settings = createImageGenSettingsStore({ agentDir })
      await withServer({ credentials: store, settings, rootDir: agentDir }, async (baseURL) => {
        for (const body of [
          { apiKey: 'sk-x' },
          { providerType: 'openai-compatible', apiKey: 'sk-x' },
          { providerType: 'openai-compatible', baseUrl: 'https://a.com/v1', apiKey: 'sk-x' },
          { ...VALID_BODY, providerType: 'unknown-protocol' }
        ]) {
          const response = await postJSON(baseURL, '/api/pi/image-gen/credentials', body)
          expect(response.status).toBe(400)
          const envelope = (await response.json()) as { error?: string }
          expect(typeof envelope.error).toBe('string')
          expect(envelope.error?.length ?? 0).toBeGreaterThan(0)
        }
        expect(store.get()).toBeNull()
      })
    } finally {
      cleanup()
    }
  })

  test('空 apiKey = 清除（00 #7；其余字段不校验）', async () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      const settings = createImageGenSettingsStore({ agentDir })
      store.set(VALID_BODY)
      await withServer({ credentials: store, settings, rootDir: agentDir }, async (baseURL) => {
        const response = await postJSON(baseURL, '/api/pi/image-gen/credentials', {
          apiKey: '  '
        })
        expect(response.status).toBe(200)
        expect(store.get()).toBeNull()
      })
    } finally {
      cleanup()
    }
  })

  test('DELETE → clear；非本面路径 → handler false → 404', async () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      const settings = createImageGenSettingsStore({ agentDir })
      store.set(VALID_BODY)
      await withServer({ credentials: store, settings, rootDir: agentDir }, async (baseURL) => {
        const deleted = await fetch(`${baseURL}/api/pi/image-gen/credentials`, {
          method: 'DELETE'
        })
        expect(deleted.status).toBe(200)
        expect(store.get()).toBeNull()
        const other = await fetch(`${baseURL}/api/pi/other`)
        expect(other.status).toBe(404)
      })
    } finally {
      cleanup()
    }
  })

  test('T71：/test 探针端点已移除 → handler false → 404', async () => {
    const { agentDir, cleanup } = tempAgentDir()
    try {
      const store = createImageGenCredentialStore({ agentDir })
      const settings = createImageGenSettingsStore({ agentDir })
      await withServer({ credentials: store, settings, rootDir: agentDir }, async (baseURL) => {
        const response = await postJSON(baseURL, '/api/pi/image-gen/test', {
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-x'
        })
        expect(response.status).toBe(404)
      })
    } finally {
      cleanup()
    }
  })
})
