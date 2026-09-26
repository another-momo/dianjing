/**
 * T42 S1：中文网字计划全量目录构建管线（离线跑一次，产出入仓）。
 *
 * 运行：bun tools/cn-font-catalog/src/build.mjs
 *
 * 流程：
 * 1. npm search API 枚举 @chinese-fonts/ 作用域包（size=250 翻页至无新增）；
 * 2. 逐包探针（并发 8）：packument 取 latest version + license 原文 →
 *    jsdelivr dist/index.json 取子族目录 → 逐目录拉 result.css，
 *    正则提取每个 @font-face 的 font-family / font-weight（区间形态 → variable）；
 *    按 font-family 聚合出族（一包可出多族）；
 * 3. 排除：FONT_REGISTRY 已收录的包（精选层不动，清单见 REGISTRY_PACKAGES）、
 *    探针失败包（原因记 excluded.json）、家族名与注册表/前序条目冲突者；
 * 4. 合并 post-pass（merge.mjs）：同包内仅差字重后缀者并为一组，旧族名进
 *    LEGACY_CN_FAMILY_ALIAS，两函数查询自动跳别名指向合并条目；
 * 5. 产出 packages/core/src/text/font/cn-catalog.ts（generated）+ excluded.json。
 *
 * displayName 采收规则（四条全满足才填，避免歧义/错配）：
 * ① 该 dir 恰解析出 1 个 family；② 该 family 在本包内只来自这 1 个 dir；
 * ③ dir 名含 CJK 字符（/[\u4e00-\u9fff]/）；④ dir ≠ family。
 * 同 family 多候选取先见者。采收/跳过计数 stdout 打印。
 *
 * 已知边界：npm search 只覆盖搜索可见面的包（排名遗漏不进目录）。
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatArray, formatEntry, formatRecord, mergeWeightFamilies } from './merge.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const OUT_TS = join(REPO_ROOT, 'packages', 'core', 'src', 'text', 'font', 'cn-catalog.ts')
const OUT_EXCLUDED = join(REPO_ROOT, 'tools', 'cn-font-catalog', 'excluded.json')

const REGISTRY_PACKAGES = new Set([
  '@chinese-fonts/syst',
  '@chinese-fonts/lxgwwenkai',
  '@chinese-fonts/xiaolai',
  '@chinese-fonts/yozai',
  '@chinese-fonts/mksjh',
  '@chinese-fonts/hcqyt',
  '@chinese-fonts/zqfs',
  '@chinese-fonts/zqzmxs',
  '@chinese-fonts/cubic'
])
// 注册表精选家族名：catalog 条目与之冲突时注册表优先
const REGISTRY_FAMILIES = new Set([
  'Source Han Serif CN VF',
  'LXGW WenKai',
  'Xiaolai SC',
  'Yozai',
  'MaokenAssortedSans',
  '寒蝉全圆体',
  'Zhuque Fangsong (technical preview)',
  'Zhi Mang Xing',
  'Cubic 11'
])

// 授权风险永久剔除：官方口径限非商用（stdgt）、再分发权保留（hqzmt/qtbfsxt）、
// GPL+上游版权争议（yidianyan）、授权来源矛盾待核（hyqzp/jyhpws）、衍生使用需
// 取得授权码（cqscbbt，2026-09-26 owner 拍板剔除）——回归需逐包重核授权后拍板
const PRUNE_PACKAGES = new Set([
  '@chinese-fonts/stdgt',
  '@chinese-fonts/hqzmt',
  '@chinese-fonts/yidianyan',
  '@chinese-fonts/qtbfsxt',
  '@chinese-fonts/hyqzp',
  '@chinese-fonts/jyhpws',
  '@chinese-fonts/cqscbbt'
])

const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search'
const NPM_PACKUMENT = 'https://registry.npmjs.org'
const JSDELIVR = 'https://cdn.jsdelivr.net/npm'
const CONCURRENCY = 8
const FETCH_TIMEOUT_MS = 20000

async function fetchJSON(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchText(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function listCatalogPackages() {
  const names = new Set()
  let from = 0
  for (;;) {
    const data = await fetchJSON(`${NPM_SEARCH}?text=%40chinese-fonts&size=250&from=${from}`)
    if (!data || !Array.isArray(data.objects) || data.objects.length === 0) break
    let added = 0
    for (const object of data.objects) {
      const name = object?.package?.name
      if (typeof name === 'string' && name.startsWith('@chinese-fonts/') && !names.has(name)) {
        names.add(name)
        added++
      }
    }
    if (data.objects.length < 250 || added === 0) break
    from += 250
  }
  return [...names].sort()
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

/**
 * 逐目录探针：仅 jsdelivr（2026-09-06 复测其已支持非 ASCII 路径，unpkg
 * 回退探针移除；目录名按运行时同款原样拼接，不做 encodeURIComponent）。
 * bases 记账保留给未来可能的回退场景；当前 base 恒 undefined。
 *
 * 返回 families（family 聚合）+ dirToFamilies（dir → 该 dir 解析出的 family 集合，
 * 用于 displayName 采收：①dir 恰解 1 family 时候选）。
 */
async function probeFamilyDirs(name, version, dirs) {
  const families = new Map() // family → { weights:Set, variable, bases:Set }
  const dirToFamilies = new Map() // dir → Set<family>
  const dirFailures = []
  for (const dir of dirs) {
    const css = await fetchText(`${JSDELIVR}/${name}@${version}/dist/${dir}/result.css`)
    const base = undefined // undefined = jsdelivr（catalog 缺省）
    if (!css) {
      dirFailures.push(dir)
      continue
    }
    const dirFamilies = new Set()
    for (const [family, info] of parseResultCSSFamilies(css)) {
      dirFamilies.add(family)
      const entry = families.get(family) ?? {
        weights: new Set(),
        variable: false,
        bases: new Set()
      }
      for (const weight of info.weights) entry.weights.add(weight)
      entry.variable = entry.variable || info.variable
      entry.bases.add(base)
      families.set(family, entry)
    }
    dirToFamilies.set(dir, dirFamilies)
  }
  return { families, dirToFamilies, dirFailures }
}

async function probePackage(name) {
  const packument = await fetchJSON(`${NPM_PACKUMENT}/${name.replace('/', '%2f')}`)
  const version = packument?.['dist-tags']?.latest
  if (!version) return { excluded: 'packument 无 dist-tags.latest' }
  const licenseRaw = packument?.versions?.[version]?.license
  const license =
    typeof licenseRaw === 'string'
      ? licenseRaw
      : (licenseRaw?.type ?? '未标注（包内无 license 字段）')

  const dirs = await fetchJSON(`${JSDELIVR}/${name}@${version}/dist/index.json`)
  if (!Array.isArray(dirs) || dirs.length === 0 || dirs.some((d) => typeof d !== 'string')) {
    return { excluded: 'dist/index.json 不可达或非法' }
  }

  const { families, dirToFamilies, dirFailures } = await probeFamilyDirs(name, version, dirs)
  if (families.size === 0) {
    return { excluded: describeUnreachableFamilies(dirFailures, dirs.length) }
  }
  const displayNames = collectDisplayNames(dirToFamilies)
  return { version, license, families, dirFailures, displayNames }
}

/** 全部子族目录 result.css 不可达时，区分「全 404」与「未解析出 family」两种排除文案 */
function describeUnreachableFamilies(dirFailures, totalDirs) {
  if (dirFailures.length > 0) {
    return `全部子族目录 result.css 在 jsdelivr 均不可达（${dirFailures.length}/${totalDirs} 目录 404）`
  }
  return 'result.css 未解析出 font-family'
}

/** displayName 采收（见 build.mjs 头注释规则）；dirToFamilies = dir → 该 dir 解析出的 family 集合 */
function collectDisplayNames(dirToFamilies) {
  const familyToDirs = new Map() // family → Set<dir>
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
  const displayNames = new Map() // family → displayName
  for (const [dir, dirFamilies] of dirToFamilies) {
    if (dirFamilies.size !== 1) continue
    if (!/[\u4e00-\u9fff]/.test(dir)) continue
    const family = [...dirFamilies][0]
    if (dir === family) continue
    const allDirs = familyToDirs.get(family)
    if (!allDirs || allDirs.size !== 1) continue
    if (displayNames.has(family)) continue // 先见者优先
    displayNames.set(family, dir)
  }
  return displayNames
}

async function mapPool(items, worker) {
  const results = new Map()
  let cursor = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++]
        results.set(item, await worker(item))
      }
    })
  )
  return results
}

const today = new Date().toISOString().slice(0, 10)
console.log(`[cn-catalog] enumerating @chinese-fonts packages…`)
const packages = await listCatalogPackages()
console.log(`[cn-catalog] ${packages.length} packages discovered`)

const excluded = {}
const entries = []
const seenFamilies = new Set(REGISTRY_FAMILIES)
let displayNameAdopted = 0
const probed = await mapPool(
  packages.filter((name) => !REGISTRY_PACKAGES.has(name) && !PRUNE_PACKAGES.has(name)),
  probePackage
)

for (const [name, result] of [...probed.entries()].sort()) {
  if (result.excluded) {
    excluded[name] = result.excluded
    continue
  }
  for (const [family, info] of [...result.families.entries()].sort()) {
    if (seenFamilies.has(family)) {
      excluded[`${name} → ${family}`] = '家族名与注册表/前序 catalog 条目冲突（前者优先）'
      continue
    }
    if (info.bases.size > 1) {
      excluded[`${name} → ${family}`] = '子族目录跨 CDN 分裂，运行时无法取一致片源'
      continue
    }
    seenFamilies.add(family)
    const base = [...info.bases][0]
    const displayName = result.displayNames?.get(family)
    if (displayName) displayNameAdopted++
    const entry = {
      family,
      package: name,
      version: result.version,
      license: result.license,
      variable: info.variable,
      weights: [...info.weights].sort((a, b) => a - b)
    }
    if (displayName) entry.displayName = displayName
    if (base) entry.base = base
    entries.push(entry)
  }
  if (result.dirFailures?.length > 0) {
    excluded[`${name}（部分目录）`] =
      `${result.dirFailures.length} 个目录 result.css 404：${result.dirFailures.join(', ')}`
  }
}

entries.sort((a, b) => a.family.localeCompare(b.family))

// post-pass：字重聚合（同包内、族名仅差词表字重后缀者并为一组）。
const { entries: mergedEntries, aliases } = mergeWeightFamilies(entries)
const aliasEntries = Object.entries(aliases)

const ts = `/**
 * GENERATED by tools/cn-font-catalog/src/build.mjs — 请勿手改，重跑管线更新。
 * 构建日期：${today} | 目录规模：${packages.length} 包探针 → 合并后 ${mergedEntries.length} 族收录 / ${aliasEntries.length} 条字重拆族别名
 *
 * T42 S1：中文网字计划全量目录（registry 精选之外的 @chinese-fonts/* 包）。
 * catalog 族白名单语义 = 默认停用（opt-in，D-c）；授权以包内 license 原文为准，未审计（D-d）。
 *
 * 字重聚合：同包内、族名仅差一个词表字重后缀（空格/连字符分隔；词表 =
 * extralight/ultralight/semibold/demibold/extrabold/ultrabold/thin/light/regular
 * /normal/medium/bold/black/heavy，长词优先匹配）者并为一组，base = 去后缀名。
 * 旧族名以 LEGACY_CN_FAMILY_ALIAS 兜底（picker 持久化恢复兼容），两函数查询
 * 自动跳别名指向合并条目。
 */

export interface CnFontCatalogEntry {
  family: string
  /** 中文显示名（采自 dist 子族目录名，四条全满足才填：①dir 恰解 1 family；②该 family 在本包仅来自此 dir；③dir 含 CJK；④dir ≠ family）。展示用，family 身份不变 */
  displayName?: string
  package: string
  /** 构建时实解版本（钉扎可重现 + piece 缓存键稳定，D-g） */
  version: string
  /** npm 包内 license 字段原文（未审计，展示用） */
  license: string
  variable: boolean
  /** result.css 实见字重（静态档集合；VF 为区间端点） */
  weights: number[]
  /** CDN base 覆盖（缺省 = jsdelivr）；运行时透传 descriptor.baseURL。2026-09-06 复测 jsdelivr 已支持非 ASCII 路径（37/37 族全绿），全量目录零回退 */
  base?: string
}

export const CN_FONT_CATALOG: CnFontCatalogEntry[] = ${formatArray(mergedEntries, formatEntry)}

export const LEGACY_CN_FAMILY_ALIAS: Record<string, string> = ${formatRecord(
  aliasEntries,
  ([from, to]) =>
    `  '${from.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}': '${to.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
)}

const catalogByFamily = new Map(CN_FONT_CATALOG.map((entry) => [entry.family, entry]))

export function cnCatalogEntry(family: string): CnFontCatalogEntry | undefined {
  const direct = catalogByFamily.get(family)
  if (direct) return direct
  const aliased = LEGACY_CN_FAMILY_ALIAS[family]
  return aliased ? catalogByFamily.get(aliased) : undefined
}

export function isCnCatalogFamily(family: string): boolean {
  if (catalogByFamily.has(family)) return true
  const aliased = LEGACY_CN_FAMILY_ALIAS[family]
  return aliased ? catalogByFamily.has(aliased) : false
}
`

writeFileSync(OUT_TS, ts)
writeFileSync(OUT_EXCLUDED, JSON.stringify(excluded, null, 2) + '\n')
console.log(
  `[cn-catalog] ${entries.length} raw → ${mergedEntries.length} merged 族 / ${aliasEntries.length} 别名 → ${OUT_TS}`
)
console.log(`[cn-catalog] ${Object.keys(excluded).length} exclusions → ${OUT_EXCLUDED}`)
console.log(
  `[cn-catalog] displayName 采收 ${displayNameAdopted}/${entries.length}（跳过 ${entries.length - displayNameAdopted}）`
)
