import { createHash } from 'node:crypto'
/**
 * fake 字体商店服务器（测试用）。
 *
 * 模式：
 *  - catalog:   GET /catalog.json → { families: [...] }（含两族小目录）
 *  - install:   GET /catalog.json + GET /fonts/*.otf → 返回 fixtures 字节
 *  - broken:    GET /catalog.json（仅一族 garbage）+ GET /fonts/*.otf → 垃圾字节
 *  - catalog-500:   GET /catalog.json → 500（目录拉取失败路径）
 *  - huge-catalog:  GET /catalog.json → 9MB 响应（触发端点侧 8MB 上限拒收）
 *  - cn-install: 模拟中文网字计划 npm 包路径——/npm/<pkg>@<ver>/dist/index.json、
 *    /dist/{dir}/result.css、/dist/{dir}/{hash}.woff2。片字节复用 NotoSansCJK
 *    fixture（OTF 容器，validateFontBytes 接受）；转码路径内容嗅探 woff2 →
 *    fixture 实际为 OTF，端点侧 detectContainer 走 OTF 分支不调转码（与真实
 *    cn-font-split 行为差异：fixture 不验转码路径但验 validate + 落盘 + 索引
 *    + 端点 + 选片全链）。
 *
 * bind 0 端口 → 由 OS 分配可用端口；baseURL 即对外可访问根。
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, normalize } from 'node:path'

export type FakeFontServerMode =
  | 'catalog'
  | 'install'
  | 'broken'
  | 'catalog-500'
  | 'huge-catalog'
  | 'cn-install'
  | 'cn-install-cancel'
  | 'cn-install-broken-piece'

export interface FakeFontServer {
  baseURL: string
  close(): Promise<void>
}

interface StartOpts {
  mode: FakeFontServerMode
  /** install 模式：单族每个 style 拉取前先 sleep（用于 cancel 测试） */
  delayMs?: number
  /** cn-install 模式：单片拉取前先 sleep（用于 cancel 测试） */
  pieceDelayMs?: number
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

/** cn-install 模式：使用 registry 内真实存在的非 VF 族（LXGW WenKai），
 *  package='@chinese-fonts/lxgwwenkai'，weights=['Light','Regular','Medium']。
 * 测试选 Regular 一条 style 装入；fake 路径前缀 '/<pkg>@<ver>/' 与 cn-fonts
 * 安装管线 baseURL='' 拼出的路径完全一致。 */
const CN_PACKAGE = '@chinese-fonts/lxgwwenkai'
const CN_VERSION = 'latest'
const CN_DIR = 'LXGWWenKai-Regular'
const CN_PIECE_HASHES = ['aaaa1111aaaa1111aaaa1111aaaa1111', 'bbbb2222bbbb2222bbbb2222bbbb2222']

function cnResultCSS(dir: string, weight: number, hashes: string[]): string {
  // 每片一条 @font-face，unicode-range 覆盖 U+4E00-4FFF（基本汉字 A 区）。
  // selectCnFontPieces 对"中"字（U+4E2D）命中——0x4E2D ∈ [0x4E00, 0x4FFF]。
  return `@font-face {
  font-family: '${dir}';
  font-weight: ${weight};
  font-style: normal;
  src: url('./${hashes[0]}.woff2') format('woff2');
  unicode-range: U+4E00-4E7F;
}
@font-face {
  font-family: '${dir}';
  font-weight: ${weight};
  font-style: normal;
  src: url('./${hashes[1]}.woff2') format('woff2');
  unicode-range: U+4E80-4FFF;
}`
}

export async function startFakeFontServer(opts: StartOpts): Promise<FakeFontServer> {
  let resolvedBaseURL = ''
  let fixtureBytes: Buffer | null = null
  function loadFixture(): Buffer {
    if (fixtureBytes === null) {
      fixtureBytes = readFileSync(FIXTURE_PATH)
    }
    return fixtureBytes
  }
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
        const bytes = loadFixture()
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
    // cn-install 模式：模拟 npm 包路径（cn-fonts 安装管线
    // baseURL='' 时拼 /<pkg>@<ver>/dist/...；测试用 baseURL='http://host/npm'
    // 拼 /npm/<pkg>@<ver>/dist/...。两种都用 cnPrefix 兼容）
    if (
      opts.mode === 'cn-install' ||
      opts.mode === 'cn-install-cancel' ||
      opts.mode === 'cn-install-broken-piece'
    ) {
      // 路径形如 /<pkg>@<ver>/dist/index.json（baseURL=''）
      // 或 /npm/<pkg>@<ver>/dist/index.json（baseURL='/npm'）
      const cnPrefixes = [`/npm/${CN_PACKAGE}@${CN_VERSION}/`, `/${CN_PACKAGE}@${CN_VERSION}/`]
      for (const cnPrefix of cnPrefixes) {
        if (url.startsWith(cnPrefix)) {
          const sub = url.slice(cnPrefix.length)
          if (sub === 'dist/index.json') {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify([`${CN_DIR}-Regular`, `${CN_DIR}-Bold`]))
            return
          }
          if (sub === `dist/${CN_DIR}-Regular/result.css`) {
            res.writeHead(200, { 'content-type': 'text/css' })
            res.end(cnResultCSS(`${CN_DIR}-Regular`, 400, CN_PIECE_HASHES))
            return
          }
          if (sub === `dist/${CN_DIR}-Bold/result.css`) {
            res.writeHead(200, { 'content-type': 'text/css' })
            res.end(cnResultCSS(`${CN_DIR}-Bold`, 700, CN_PIECE_HASHES))
            return
          }
          const pieceMatch = sub.match(/^dist\/.+\/([0-9a-f]{32})\.woff2$/)
          if (pieceMatch) {
            if (opts.pieceDelayMs && opts.pieceDelayMs > 0) {
              await new Promise((r) => setTimeout(r, opts.pieceDelayMs))
            }
            if (opts.mode === 'cn-install-broken-piece') {
              // 故意返回 4 字节非字体魔数（仅首个片触发即可）
              res.writeHead(200, { 'content-type': 'font/woff2' })
              res.end(Buffer.from([0xde, 0xad, 0xbe, 0xef]))
              return
            }
            // 复用 OTF fixture——内容嗅探 detectContainer 走 OTF 分支不调转码
            const bytes = loadFixture()
            res.writeHead(200, {
              'content-type': 'font/woff2',
              'content-length': String(bytes.byteLength)
            })
            res.end(bytes)
            return
          }
          res.writeHead(404).end('not found in cn package')
          return
        }
      }
      res.writeHead(404).end('not found')
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

// 公开 cn 包元信息——测试断言用
export const CN_FAKE_PACKAGE = CN_PACKAGE
export const CN_FAKE_VERSION = CN_VERSION
export const CN_FAKE_DIR = CN_DIR
export const CN_FAKE_PIECE_HASHES = CN_PIECE_HASHES
