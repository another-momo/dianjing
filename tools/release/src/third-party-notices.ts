/**
 * THIRD-PARTY-NOTICES 生成器（发版合规项）。
 *
 * 起点：根 package.json#workspaces 列出的 packages/* 的 dependencies（不含
 * devDependencies）+ 根 package.json 的 dependencies（也不含 dev）——这两组
 * 是随 Windows 安装包分发的 npm 闭包。spikes/* 不上包，desktop-electron/ 也
 * 不在 workspaces，但它有自家 package.json？——实测没有，所有 native externals
 * （photon-node / clipboard / yoga-layout）经由 @earendil-works/pi-coding-agent
 * 的 dependencies/optionalDependencies 或根 dependencies 的 npm alias 被拉进
 * 闭包，walk 会自动收录。
 *
 * 闭包 walk：每个包在 node_modules/<scope?>/<name>/package.json，落点按 bun
 * 提升策略 = 仓根 node_modules 优先，嵌套 node_modules 兜底。从包所在目录
 * 逐层向上爬到仓根 node_modules，逐层检查 <name>/package.json 是否存在；
 * 命中后递归解析其 dependencies/optionalDependencies。
 *
 * license 文件匹配 /^LICEN[SC]E|^COPYING|^NOTICE/i（可带 .md/.txt），
 * 多份取第一份（命中即停止）——多份时实现按字典序选第一份以保稳定输出。
 *
 * curated 段是 vendored 资产（不经 npm），全部由 OFL/BSD 持牌方直接供货；
 * 内嵌 OFL 1.1 canonical 全文以避免重复（很多字体都同 OFL，去重按 hash
 * 分组）。
 *
 * 输出：build/.generated/THIRD-PARTY-NOTICES.txt（gitignored 目录）。
 * 字节安全：全程 UTF-8 显式读写，不走 PowerShell。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..')
const outputDir = join(root, 'build', '.generated')
const outputFile = join(outputDir, 'THIRD-PARTY-NOTICES.txt')

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  workspaces?: string[]
}
const workspaceDirs = (rootPkg.workspaces ?? []).map((w) => resolve(root, w))

// 起点 = 根 dependencies + 各 workspace dependencies（union）。devDependencies
// 不随包分发，跳过。
const seedDeps = new Set<string>(Object.keys(rootPkg.dependencies ?? {}))
for (const wsDir of workspaceDirs) {
  const wsPkgPath = join(wsDir, 'package.json')
  if (!existsSync(wsPkgPath)) continue
  const wsPkg = JSON.parse(readFileSync(wsPkgPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const k of Object.keys(wsPkg.dependencies ?? {})) seedDeps.add(k)
}

// npm alias "npm:@scope/name@ver" —— 闭包 walk 落点是 @scope/name，
// 但 packaged 名为 @scope/name、声明名为根 package.json dependencies 的 key。
// 记录映射：声明名 → 真实包名。
const aliasRealName = new Map<string, string>()
for (const decl of seedDeps) {
  const spec = rootPkg.dependencies?.[decl] ?? ''
  const m = /^npm:(@?[^@]+)@/.exec(spec)
  if (m) aliasRealName.set(decl, m[1])
}

/** 从 (declName, versionRange) 出发在仓根 node_modules 找包目录。
 *  bun 提升策略：直挂包走 <root>/node_modules/<scope?>/<name>/，硬链接走
 *  <root>/node_modules/.bun/node_modules/<scope?>/<name>/（仓内也即在
 *  .bun/node_modules/ 下同名——只要先认 .bun 即可）。逐层向上爬 to handle
 *  nested deps。 */
function findPackageDir(name: string, fromDir: string): string | null {
  const segments = name.split('/')
  let cur = fromDir
  while (true) {
    for (const suffix of [
      join('node_modules', ...segments),
      join('node_modules', '.bun', 'node_modules', ...segments)
    ]) {
      const candidate = join(cur, suffix, 'package.json')
      if (existsSync(candidate)) return dirname(candidate)
    }
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

interface ClosureEntry {
  /** 声明名（root deps key；alias 时 = alias 左侧） */
  declName: string
  /** 实际包名（package.json#name） */
  name: string
  version: string
  license: string
  author: string
  /** license 全文（去尾随空行）；多包同 SPDX 但内容可能不同——按内容 hash 去重 */
  licenseText: string
  /** license 全文 SHA-256 hex */
  licenseHash: string
  /** license 文件相对仓根路径（仅当非 OFL 内嵌常量时） */
  licenseFile: string | null
}

const visited = new Set<string>()
const closure: ClosureEntry[] = []
const missing: string[] = []

function readLicenseFromPkgDir(pkgDir: string): { text: string; file: string | null } {
  const files = readdirSync(pkgDir)
  // 稳定顺序：按文件名字典序，先无扩展版本优先，再 .md/.txt/.other
  const candidates = files
    .filter((f) => /^LICEN[SC]E|^COPYING|^NOTICE/i.test(f))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  for (const f of candidates) {
    const full = join(pkgDir, f)
    // 跳过非文件（目录、symlink 等）；罕见但 .git/HEAD 这种不是 license
    try {
      const stat = statSync(full)
      if (!stat.isFile()) continue
    } catch {
      continue
    }
    return { text: readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trimEnd(), file: f }
  }
  return { text: '', file: null }
}

function walk(name: string, fromDir: string) {
  const key = `${name}@${fromDir}`
  if (visited.has(key)) return
  visited.add(key)
  const pkgDir = findPackageDir(name, fromDir)
  if (!pkgDir) {
    missing.push(name)
    return
  }
  const pkgPath = join(pkgDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name: string
    version: string
    license?: string
    licenses?: string | { type: string }[]
    author?: string | { name?: string }
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  // 跳过 workspace 内部自指——仅当此 package.json 物理落在仓内 packages/* 下
  // （仓根 packages/ 路径前缀）才算 fork 自有包；npm 上同样以 @open-pencil/
  // 开头的复刻包（如 yoga-layout 的 npm alias @open-pencil/yoga-layout）物理
  // 落在 node_modules/，不算 workspace 内部、不跳过。
  const rel = relative(root, pkgDir).split(sep).join('/')
  if (rel.startsWith('packages/') && pkg.name.startsWith('@open-pencil/')) return
  // peer 也要走（如 pi-coding-agent 的 photon 是 dep 不是 peer；保留 peer 兜底）
  const subDeps = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies
  }
  let license = pkg.license ?? ''
  if (!license && Array.isArray(pkg.licenses)) {
    license = pkg.licenses
      .map((l) => (typeof l === 'string' ? l : l.type))
      .filter(Boolean)
      .join(' OR ')
  }
  let author = ''
  if (typeof pkg.author === 'string') author = pkg.author
  else if (pkg.author?.name) author = pkg.author.name
  const { text, file } = readLicenseFromPkgDir(pkgDir)
  const hash = createHash('sha256').update(text).digest('hex')
  closure.push({
    declName: name,
    name: pkg.name,
    version: pkg.version,
    license: license || 'UNKNOWN',
    author,
    licenseText: text,
    licenseHash: hash,
    licenseFile: file ? relative(root, join(pkgDir, file)).split(sep).join('/') : null
  })
  for (const subName of Object.keys(subDeps)) {
    walk(subName, pkgDir)
  }
}

// 从仓根 node_modules 起步递归
for (const decl of seedDeps) {
  walk(decl, root)
}

// 闭包去重：visited 键是 name@fromDir，同一 name@version 经多个父包到达会
// 重复入座（组件清单里同一名@版本印多次）；按 name@version 去重，同名不同
// 版本（嵌套解析出的多版本）保留各自条目
const seenPkgKeys = new Set<string>()
const uniqueClosure = closure.filter((e) => {
  const k = `${e.name}@${e.version}`
  if (seenPkgKeys.has(k)) return false
  seenPkgKeys.add(k)
  return true
})

// === curated 段 ============================================================
// OFL 1.1 canonical 全文（标准 SIL OPEN FONT LICENSE Version 1.1）——多个
// 字体家族共用，去重后只印一次；分组标题列各家族。
const OFL_1_1_TEXT = `SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license, and which are clearly identified as such.
This may include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components
as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name
as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, OR CONSEQUENTIAL DAMAGES,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.`

interface CuratedFontEntry {
  name: string
  files: string[]
  copyright: string
}

const curatedFonts: CuratedFontEntry[] = [
  {
    name: 'Alibaba PuHuiTi',
    files: [
      'public/AlibabaPuHuiTi-Thin.ttf',
      'public/AlibabaPuHuiTi-Light.ttf',
      'public/AlibabaPuHuiTi-Regular.ttf',
      'public/AlibabaPuHuiTi-Medium.ttf',
      'public/AlibabaPuHuiTi-SemiBold.ttf',
      'public/AlibabaPuHuiTi-Bold.ttf',
      'public/AlibabaPuHuiTi-ExtraBold.ttf',
      'public/AlibabaPuHuiTi-Heavy.ttf',
      'public/AlibabaPuHuiTi-Black.ttf'
    ],
    copyright: 'Copyright (c) Alibaba'
  },
  {
    name: 'Inter',
    files: [
      'public/Inter-Regular.ttf',
      'public/Inter-Medium.ttf',
      'public/Inter-SemiBold.ttf',
      'public/Inter-Bold.ttf',
      'public/Inter-ExtraBold.ttf'
    ],
    copyright: 'Copyright (c) The Inter Project Authors (rsms)'
  },
  {
    name: 'Noto Naskh Arabic',
    files: ['public/NotoNaskhArabic-Regular.ttf'],
    copyright: 'Copyright (c) The Noto Project Authors (Google)'
  }
]

// canvaskit.wasm vendored + canvaskit-wasm npm 同版权 BSD-3-Clause——
// npm 包 canvaskit-wasm 已在闭包，curated 段只在闭包未含 canvaskit-wasm 时
// 才补 vendored wasm 声明（任务规格 §1c）。
const curatedCanvaskitWasm = {
  name: 'canvaskit.wasm',
  file: 'public/canvaskit.wasm',
  copyright: 'Copyright (c) Google LLC'
}

// === 输出 ================================================================
mkdirSync(outputDir, { recursive: true })

const lines: string[] = []
lines.push('THIRD-PARTY NOTICES')
lines.push('==================')
lines.push('')
lines.push('Dianjing incorporates third-party components listed below.')
lines.push('The Dianjing source code itself is released under the MIT License')
lines.push('(see LICENSE in the project root for the full text).')
lines.push('')
lines.push('Each component is licensed under the terms described in this file.')
lines.push('Where multiple components share the same license text, the text is')
lines.push('printed once under a grouped section header listing all components.')
lines.push('')
lines.push('='.repeat(78))
lines.push('')

// 1) npm 闭包：按 license text hash 分组 → 每组内所有包名@version 列出 → 全文一次
type Group = { hash: string; text: string; entries: ClosureEntry[] }
const groups = new Map<string, Group>()
for (const e of uniqueClosure) {
  if (!e.licenseText) continue
  let g = groups.get(e.licenseHash)
  if (!g) {
    g = { hash: e.licenseHash, text: e.licenseText, entries: [] }
    groups.set(e.licenseHash, g)
  }
  g.entries.push(e)
}

// 已分组 hash
const seenHashes = new Set<string>()

// 字母序遍历 closure，每条第一次出现 hash 时印分组标题 + 全文，后续同 hash 仅记包名
// 排序键：按 package name 字母序，相同按 version 字典序
const sortedClosure = [...uniqueClosure].sort((a, b) => {
  const c = a.name.localeCompare(b.name)
  return c !== 0 ? c : a.version.localeCompare(b.version)
})

let npmEntryCount = 0
for (const e of sortedClosure) {
  if (!e.licenseText) {
    // 全文缺失：单独段（少见）
    lines.push(`Component: ${e.name}@${e.version}`)
    lines.push(`License: ${e.license}`)
    if (e.author) lines.push(`Copyright: ${e.author}`)
    lines.push(`Source: node_modules/${e.declName}/`)
    if (e.licenseFile) lines.push(`License file: ${e.licenseFile}`)
    lines.push('')
    lines.push('License text not bundled (UNKNOWN or package ships only')
    lines.push('license metadata; refer to upstream for full text).')
    lines.push('')
    lines.push('='.repeat(78))
    lines.push('')
    npmEntryCount++
    continue
  }
  const first = !seenHashes.has(e.licenseHash)
  if (first) {
    seenHashes.add(e.licenseHash)
    // 收齐同 hash 全部包名版本（按字母序）
    const peers = sortedClosure
      .filter((x) => x.licenseHash === e.licenseHash)
      .map((x) => `${x.name}@${x.version}`)
    lines.push('Components sharing the following license text:')
    for (const p of peers) lines.push(`  - ${p}`)
    lines.push('')
    lines.push(e.licenseText)
    lines.push('')
    lines.push('='.repeat(78))
    lines.push('')
    npmEntryCount += peers.length
  }
}

// 2) curated OFL 分组——单独段，开头列出三个字体家族；OFL 全文印一次
lines.push('Vendored fonts (curated)')
lines.push('------------------------')
lines.push('')
lines.push('The following font families are bundled directly in public/ (not via npm).')
lines.push('All are released under the SIL Open Font License v1.1; the full text')
lines.push('is printed once below.')
lines.push('')
for (const f of curatedFonts) {
  lines.push(`  - ${f.name} (${f.files.length} weights)`)
  for (const file of f.files) lines.push(`      ${file}`)
  lines.push(`    Copyright: ${f.copyright}`)
  lines.push('')
}
lines.push('License (OFL 1.1):')
lines.push('')
lines.push(OFL_1_1_TEXT)
lines.push('')
lines.push('='.repeat(78))
lines.push('')

// 3) canvaskit.wasm vendored 段
const canvaskitInClosure = uniqueClosure.some((e) => e.name === 'canvaskit-wasm')
lines.push('Vendored wasm asset')
lines.push('-------------------')
lines.push('')
if (canvaskitInClosure) {
  lines.push(`  - ${curatedCanvaskitWasm.name} (${curatedCanvaskitWasm.file})`)
  lines.push(`    Copyright: ${curatedCanvaskitWasm.copyright}`)
  lines.push(`    License: BSD-3-Clause (same as npm package canvaskit-wasm listed above)`)
} else {
  lines.push(`  - ${curatedCanvaskitWasm.name} (${curatedCanvaskitWasm.file})`)
  lines.push(`    Copyright: ${curatedCanvaskitWasm.copyright}`)
  lines.push(`    License: BSD-3-Clause`)
  lines.push('')
  lines.push('Copyright (c) Google LLC. All rights reserved.')
  lines.push('')
  lines.push('Redistribution and use in source and binary forms, with or without')
  lines.push('modification, are permitted provided that the following conditions are met:')
  lines.push('')
  lines.push('1. Redistributions of source code must retain the above copyright notice,')
  lines.push('   this list of conditions and the following disclaimer.')
  lines.push('')
  lines.push('2. Redistributions in binary form must reproduce the above copyright')
  lines.push('   notice, this list of conditions and the following disclaimer in the')
  lines.push('   documentation and/or other materials provided with the distribution.')
  lines.push('')
  lines.push('3. Neither the name of the copyright holder nor the names of its')
  lines.push('   contributors may be used to endorse or promote products derived from')
  lines.push('   this software without specific prior written permission.')
  lines.push('')
  lines.push('THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"')
  lines.push('AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE')
  lines.push('IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE')
  lines.push('ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY')
  lines.push('DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES')
  lines.push('(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;')
  lines.push('LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND')
  lines.push('ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT')
  lines.push('(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS')
  lines.push('SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.')
}
lines.push('')

writeFileSync(outputFile, lines.join('\n'), 'utf8')

// 汇报（stdout）
const totalBytes = readFileSync(outputFile, 'utf8').length
const closureCount = uniqueClosure.length
const groupedHashes = groups.size
const curatedFontCount = curatedFonts.reduce((n, f) => n + f.files.length, 0)
console.log(`[notices] wrote ${outputFile}`)
console.log(`[notices] closure packages: ${closureCount}`)
console.log(`[notices] grouped license hashes: ${groupedHashes}`)
console.log(`[notices] vendored font files: ${curatedFontCount}`)
console.log(`[notices] output bytes: ${totalBytes}`)
console.log(`[notices] output lines: ${lines.length}`)
if (missing.length) {
  console.log(`[notices] WARNING: missing packages (${missing.length}):`)
  for (const m of missing) console.log(`  - ${m}`)
}
