/**
 * fake 字体商店服务器（测试用）。
 *
 * 模式：
 *  - catalog:   GET /catalog.json → { families: [...] }（含两族小目录）
 *  - install:   GET /catalog.json + GET /fonts/*.otf → 返回 fixtures 字节
 *  - broken:    GET /catalog.json（仅一族 garbage）+ GET /fonts/*.otf → 垃圾字节
 *  - catalog-500:   GET /catalog.json → 500（目录拉取失败路径）
 *  - huge-catalog:  GET /catalog.json → 9MB 响应（触发端点侧 8MB 上限拒收）
 *
 * bind 0 端口 → 由 OS 分配可用端口；baseURL 即对外可访问根。
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, normalize } from 'node:path'

export type FakeFontServerMode = 'catalog' | 'install' | 'broken' | 'catalog-500' | 'huge-catalog'

export interface FakeFontServer {
  baseURL: string
  close(): Promise<void>
}

interface StartOpts {
  mode: FakeFontServerMode
  /** install 模式：单族每个 style 拉取前先 sleep（用于 cancel 测试） */
  delayMs?: number
}

const CATALOG_TEMPLATE = {
  families: [
    {
      family: 'Noto Sans CJK Test',
      displayName: 'Noto Sans CJK Test',
      license: 'OFL-1.1',
      version: '1.0',
      styles: [
        {
          style: 'Regular',
          weight: 400,
          italic: false,
          fileURL: '/fonts/NotoSansCJK-Test.otf',
          format: 'otf' as const
        }
      ]
    },
    {
      family: 'Secondary Family',
      styles: [
        {
          style: 'Regular',
          weight: 400,
          italic: false,
          fileURL: '/fonts/NotoSansCJK-Test.otf',
          format: 'otf' as const
        }
      ]
    }
  ]
}

const BROKEN_CATALOG_TEMPLATE = {
  families: [
    {
      family: 'Garbage Font',
      styles: [
        {
          style: 'Regular',
          weight: 400,
          italic: false,
          fileURL: '/fonts/garbage.bin',
          format: 'otf' as const
        }
      ]
    }
  ]
}

/** 给定 baseURL，把模板里的相对 fileURL 拼成绝对 URL（拷贝，不改原模板） */
function buildCatalog(template: typeof CATALOG_TEMPLATE, baseURL: string): typeof CATALOG_TEMPLATE {
  return {
    families: template.families.map((family) => ({
      ...family,
      styles: family.styles.map((style) => ({
        ...style,
        fileURL: `${baseURL}${style.fileURL}`
      }))
    }))
  }
}

const FIXTURE_PATH = normalize(
  join(import.meta.dir, '../../../fixtures/fonts/NotoSansCJK-Test.otf')
)

export async function startFakeFontServer(opts: StartOpts): Promise<FakeFontServer> {
  let resolvedBaseURL = ''
  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'
    if (url === '/catalog.json') {
      if (opts.mode === 'catalog-500') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'upstream boom' }))
        return
      }
      if (opts.mode === 'huge-catalog') {
        // 9MB JSON——触发端点侧 8MB 上限（流式截断）
        const pad = 'x'.repeat(9 * 1024 * 1024)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(`{"families":[],"pad":"${pad}"}`)
        return
      }
      const template = opts.mode === 'broken' ? BROKEN_CATALOG_TEMPLATE : CATALOG_TEMPLATE
      const payload = buildCatalog(template, resolvedBaseURL)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
      return
    }
    if (url.startsWith('/fonts/')) {
      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs))
      }
      if (opts.mode === 'broken') {
        // 垃圾字节：4 字节非字体魔数 → validateFontBytes 应拒
        res.writeHead(200, { 'content-type': 'font/otf' })
        res.end(Buffer.from([0xde, 0xad, 0xbe, 0xef]))
        return
      }
      try {
        const bytes = readFileSync(FIXTURE_PATH)
        res.writeHead(200, {
          'content-type': 'font/otf',
          'content-length': String(bytes.byteLength)
        })
        res.end(bytes)
      } catch (error) {
        res.writeHead(500).end((error as Error).message)
      }
      return
    }
    res.writeHead(404).end('not found')
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  resolvedBaseURL = `http://127.0.0.1:${address.port}`
  return {
    baseURL: resolvedBaseURL,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}
