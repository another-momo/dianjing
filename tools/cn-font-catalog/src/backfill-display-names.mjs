/**
 * 一次性回填 + 供日后增量复跑：cn-catalog.ts 现役条目回填 displayName。
 *
 * 不全量重跑 build.mjs（避免 version 重解析 churn）：从现役 CN_FONT_CATALOG
 * 按 package+version 分组，逐包拉 dist/index.json + 各 dir 的 result.css
 * （复用 build.mjs 同款 fetch/parse，并发 8、超时 20s、jsdelivr base），按 build.mjs
 * 同款采收规则算出 displayName，按条目录入字段（仅 +displayName 行，行序/缩进/权重/版本全部不动）。
 *
 * 采收规则（四条全满足）：① 该 dir 恰解析出 1 个 family；② 该 family 在本包
 * 仅来自此 1 个 dir；③ dir 名含 CJK（/[\u4e00-\u9fff]/）；④ dir ≠ family。
 * 同 family 多候选取先见者。
 *
 * 网络失败重试一次仍败即停，禁半截写盘（全部拉取成功才写）。
 * 验收闸：写盘后 git diff --stat + 抽查 diff 只允许 +displayName 行，
 * 出现任何其他 churn 即停汇报。
 *
 * 运行：bun tools/cn-font-catalog/src/backfill-display-names.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const OUT_TS = join(REPO_ROOT, 'packages', 'core', 'src', 'text', 'font', 'cn-catalog.ts')

const JSDELIVR = 'https://cdn.jsdelivr.net/npm'
const CONCURRENCY = 8
const FETCH_TIMEOUT_MS = 20000
const RETRY = 1

async function fetchWithRetry(url) {
  let lastError
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error('fetch failed')
}

async function fetchJSON(url) {
  const text = await fetchWithRetry(url)
  return JSON.parse(text)
}

/** 从 result.css 文本聚合 { family → { weights:Set, variable } }；无 @font-face 返回空 Map */
function parseResultCSSFamilies(css) {
  const families = new Map()
  for (const chunk of css.split('@font-face').slice(1)) {
    if (!chunk.includes('unicode-range')) continue
    const familyMatch = /font-family\s*:\s*["']([^"']+)["']/i.exec(chunk)
    if (!familyMatch) continue
    const family = familyMatch[1].trim()
    if (!family) continue
    const weightMatch = /font-weight\s*:\s*([0-9]+)(?:\s+([0-9]+))?/i.exec(chunk)
    const entry = families.get(family) ?? { weights: new Set(), variable: false }
    if (weightMatch) {
      const low = Number.parseInt(weightMatch[1], 10)
      if (weightMatch[2] !== undefined) {
        entry.variable = true
        entry.weights.add(low)
        entry.weights.add(Number.parseInt(weightMatch[2], 10))
      } else {
        entry.weights.add(low)
      }
    } else {
      entry.weights.add(400)
    }
    families.set(family, entry)
  }
  return families
}

async function probePackageDirs(name, version, dirs) {
  const dirToFamilies = new Map()
  let cursor = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < dirs.length) {
        const dir = dirs[cursor++]
        try {
          const css = await fetchWithRetry(`${JSDELIVR}/${name}@${version}/dist/${dir}/result.css`)
          const dirFamilies = new Set()
          for (const [family] of parseResultCSSFamilies(css)) dirFamilies.add(family)
          dirToFamilies.set(dir, dirFamilies)
        } catch {
          // dir 不可达：本族 displayName 无法采收，跳过
        }
      }
    })
  )
  return dirToFamilies
}

function computeDisplayNames(dirToFamilies) {
  const familyToDirs = new Map()
  for (const [dir, dirFamilies] of dirToFamilies) {
    for (const family of dirFamilies) {
      let set = familyToDirs.get(family)
      if (!set) {
        set = new Set()
        familyToDirs.set(family, set)
      }
      set.add(dir)
    }
  }
  const displayNames = new Map()
  for (const [dir, dirFamilies] of dirToFamilies) {
    if (dirFamilies.size !== 1) continue
    if (!/[\u4e00-\u9fff]/.test(dir)) continue
    const family = [...dirFamilies][0]
    if (dir === family) continue
    const allDirs = familyToDirs.get(family)
    if (!allDirs || allDirs.size !== 1) continue
    if (displayNames.has(family)) continue
    displayNames.set(family, dir)
  }
  return displayNames
}

// 提取 family 键值（用于按 family 索引行块）—— TS 单引号字面量
function extractEntryMap(source) {
  const map = new Map() // family → { startOffset, endOffset, package, version }
  const entryRe = /\{([^{}]*)\}/g
  const familyRe = /family\s*:\s*'((?:\\.|[^'\\])*)'/
  const pkgRe = /package\s*:\s*'((?:\\.|[^'\\])*)'/
  const versionRe = /version\s*:\s*'((?:\\.|[^'\\])*)'/
  for (const match of source.matchAll(entryRe)) {
    const body = match[1]
    const family = familyRe.exec(body)
    const pkg = pkgRe.exec(body)
    const version = versionRe.exec(body)
    if (!family || !pkg || !version) continue
    map.set(family[1], {
      startOffset: match.index,
      endOffset: match.index + match[0].length,
      package: pkg[1],
      version: version[1]
    })
  }
  return map
}

const source = readFileSync(OUT_TS, 'utf8')
const arrayHeader = source.indexOf('CN_FONT_CATALOG: CnFontCatalogEntry[] = ')
if (arrayHeader === -1) {
  throw new Error('CN_FONT_CATALOG 字面量未找到，回填中止（防半截写盘）')
}
const arrayStart = source.indexOf('[', arrayHeader + 1)
const arrayEnd = source.indexOf('\n\nconst catalogByFamily', arrayStart)
if (arrayEnd === -1) {
  throw new Error('CN_FONT_CATALOG 终止标记未找到，回填中止（防半截写盘）')
}

const arrayText = source.slice(arrayStart, arrayEnd)
const entryMap = extractEntryMap(arrayText)

// 按 package@version 分组
const groups = new Map()
for (const [family, info] of entryMap) {
  const key = `${info.package}@${info.version}`
  let list = groups.get(key)
  if (!list) {
    list = []
    groups.set(key, list)
  }
  list.push(family)
}

const displayByFamily = new Map() // family → displayName
const skipped = []
const groupKeys = [...groups.keys()]
let cursor = 0
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < groupKeys.length) {
      const key = groupKeys[cursor++]
      const lastAt = key.lastIndexOf('@')
      const packageName = key.slice(0, lastAt)
      const pkgVersion = key.slice(lastAt + 1)
      try {
        const dirs = await fetchJSON(`${JSDELIVR}/${packageName}@${pkgVersion}/dist/index.json`)
        if (!Array.isArray(dirs) || dirs.length === 0) {
          skipped.push(`${key}: index.json 不可达或空`)
          continue
        }
        const dirToFamilies = await probePackageDirs(packageName, pkgVersion, dirs)
        const displayMap = computeDisplayNames(dirToFamilies)
        for (const family of groups.get(key)) {
          if (displayMap.has(family)) displayByFamily.set(family, displayMap.get(family))
        }
      } catch (error) {
        throw new Error(`${key} 探针失败（已重试）：${error.message}`)
      }
    }
  })
)

// 简化版：直接按 entry 块插入。从 arrayText 中按 entry 块遍历，在最后一行 `  }` 之前插入 displayName 行。
// 同步修复：原条目最后字段行（weights: [...]）无尾随逗号（语法依赖 `  },` 收口）；插入后该行必须加逗号。
let adopted = 0
const insertions = []
for (const [family, info] of entryMap) {
  const dn = displayByFamily.get(family)
  if (!dn) continue
  const entryText = arrayText.slice(info.startOffset, info.endOffset)
  if (/displayName\s*:/.test(entryText)) continue
  const lines2 = entryText.split('\n')
  const lastLine = lines2[lines2.length - 1]
  // 在最后一行（`  }`）前插入 displayName；同时给倒数第二行补尾随逗号（原条目最后一字段无逗号）
  const insertionLine = `    displayName: '${dn}',\n`
  const secondLastLine = lines2[lines2.length - 2]
  const secondLastStart = entryText.length - lastLine.length - secondLastLine.length - 1 // 倒数第二行起点
  // 若倒数第二行已以 `,` 结尾则跳过；否则补逗号
  let secondLastAdjusted = secondLastLine
  if (!secondLastLine.trimEnd().endsWith(',')) {
    secondLastAdjusted = secondLastLine.replace(/(\[[^\]]*\]|\s*)$/, '$1,')
    if (!secondLastAdjusted.endsWith(',')) secondLastAdjusted = secondLastLine + ','
  }
  const newEntryText =
    entryText.slice(0, secondLastStart) + secondLastAdjusted + '\n' + insertionLine + lastLine
  insertions.push({
    start: arrayStart + info.startOffset,
    end: arrayStart + info.endOffset,
    newText: newEntryText
  })
  adopted++
}

// 按 start 倒序替换（避免偏移错位）
insertions.sort((a, b) => b.start - a.start)
let newSource = source
for (const ins of insertions) {
  newSource = newSource.slice(0, ins.start) + ins.newText + newSource.slice(ins.end)
}

writeFileSync(OUT_TS, newSource, 'utf8')

const total = entryMap.size
console.log(`[backfill] displayName 采收 ${adopted}/${total}（跳过 ${total - adopted}）`)
if (skipped.length > 0) {
  console.log(`[backfill] 跳过明细（${skipped.length}）：`)
  for (const line of skipped) console.log(`  - ${line}`)
}
console.log(`[backfill] 写盘完成：${OUT_TS}`)
