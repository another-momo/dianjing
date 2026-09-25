/**
 * 字重聚合共享规则：build.mjs（重跑管线）与 merge-weight-families.mjs（一次性）
 * 复用同一份合并逻辑与别名推导，确保未来重跑直接出合并后形状。
 *
 * 规则：同 package 内、族名仅差一个词表字重后缀（空格/连字符分隔；词表长词优先匹配）者并为一组。
 * base = 去后缀名。合并条目 family=base、weights=并集升序、variable=任一为真、
 * displayName = base 自有 ?? 组成员首个有的。
 * 别名表 = 每个组里 family ≠ base 的成员（旧名 → base）。
 */

// 长词优先匹配（避免 ExtraLight 被 Light 先吞）。
export const WEIGHT_LEX = [
  'extralight',
  'ultralight',
  'semibold',
  'demibold',
  'extrabold',
  'ultrabold',
  'thin',
  'light',
  'regular',
  'normal',
  'medium',
  'bold',
  'black',
  'heavy'
]

/** 剥离族名末尾的字重后缀（大小写不敏感；分隔符 = 空格或连字符）。无后缀返回 null。 */
export function stripWeightSuffix(family) {
  for (const lex of WEIGHT_LEX) {
    if (family.length > lex.length + 1) {
      const tailLower = family.slice(-(lex.length + 1)).toLowerCase()
      if (tailLower === ' ' + lex || tailLower === '-' + lex) {
        return { base: family.slice(0, -(lex.length + 1)), lex }
      }
    }
  }
  return null
}

/**
 * 把 entries 按 (package, base) 合并，返回 { entries, aliases }。
 * entries 字典序（localeCompare）排好；aliases 字典序。
 */
export function mergeWeightFamilies(entries) {
  const groups = new Map() // key = package::base → { base, members[] }
  for (const entry of entries) {
    const stripped = stripWeightSuffix(entry.family)
    const base = stripped ? stripped.base : entry.family
    const key = `${entry.package}::${base}`
    let group = groups.get(key)
    if (!group) {
      group = { base, members: [] }
      groups.set(key, group)
    }
    group.members.push(entry)
  }

  const allEntries = []
  const aliases = new Map()
  for (const group of groups.values()) {
    if (group.members.length === 1) {
      const only = group.members[0]
      if (only.family !== group.base) {
        // 单成员改名组（family ≠ base）：displayName 若与新 family 同字则丢弃冗余。
        const renamed = { ...only, family: group.base }
        if (renamed.displayName === group.base) delete renamed.displayName
        allEntries.push(renamed)
        aliases.set(only.family, group.base)
      } else {
        allEntries.push(only)
      }
      continue
    }
    const allWeights = new Set()
    let variable = false
    let displayName
    for (const m of group.members) {
      for (const w of m.weights) allWeights.add(w)
      if (m.variable) variable = true
    }
    const baseMember = group.members.find((m) => m.family === group.base)
    if (baseMember?.displayName) displayName = baseMember.displayName
    if (!displayName) {
      for (const m of group.members) {
        if (m.displayName) {
          displayName = m.displayName
          break
        }
      }
    }
    const seed = baseMember ?? group.members[0]
    const merged = {
      family: group.base,
      package: seed.package,
      version: seed.version,
      license: seed.license,
      variable,
      weights: [...allWeights].sort((a, b) => a - b)
    }
    if (displayName && displayName !== group.base) merged.displayName = displayName
    if (seed.base) merged.base = seed.base
    allEntries.push(merged)
    for (const m of group.members) {
      if (m.family !== group.base) aliases.set(m.family, group.base)
    }
  }

  allEntries.sort((a, b) => a.family.localeCompare(b.family))
  const orderedAliases = Object.fromEntries(
    [...aliases.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  )
  return { entries: allEntries, aliases: orderedAliases }
}

/** TS 单引号字面量转义。 */
function escapeSingleQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * 渲染单条 catalog entry（沿用 build.mjs 模板惯例：family / package / version / license /
 * variable / weights / displayName? / base?）。
 */
export function formatEntry(entry) {
  const lines = ['  {']
  lines.push(`    family: '${escapeSingleQuoted(entry.family)}',`)
  lines.push(`    package: '${escapeSingleQuoted(entry.package)}',`)
  lines.push(`    version: '${escapeSingleQuoted(entry.version)}',`)
  lines.push(`    license: '${escapeSingleQuoted(entry.license)}',`)
  lines.push(`    variable: ${entry.variable},`)
  const weightsInline = `[${entry.weights.join(', ')}]`
  const tail = []
  if (entry.base !== undefined && entry.base !== null) {
    tail.push(`    base: '${escapeSingleQuoted(entry.base)}'`)
  }
  if (entry.displayName) {
    tail.push(`    displayName: '${escapeSingleQuoted(entry.displayName)}'`)
  }
  if (tail.length === 0) {
    lines.push(`    weights: ${weightsInline}`)
  } else {
    lines.push(`    weights: ${weightsInline},`)
    lines.push(...tail)
  }
  lines.push('  }')
  return lines.join('\n')
}

/** 渲染 array 字面量（[\n...\n]），每项之间 `,\n` 分隔。 */
export function formatArray(items, formatter) {
  if (items.length === 0) return '[]'
  return '[\n' + items.map(formatter).join(',\n') + '\n]'
}

/** 渲染 Record 字面量（{\n...\n}），每项之间 `,\n` 分隔。 */
export function formatRecord(entries, formatter) {
  if (entries.length === 0) return '{}'
  return '{\n' + entries.map(formatter).join(',\n') + '\n}'
}
