#!/usr/bin/env node
/**
 * 现役 cn-catalog.ts license 纠正（LICENSE_OVERRIDES 真源消费方之二，一次性手术写入）。
 *
 * 为什么存在：license 纠正常驻真源是 license-overrides.mjs，build.mjs 重跑时自动消费；
 * 但现役生成文件等不到下次重建——本脚本对 cn-catalog.ts 做按行外科手术（不重排模板、
 * 不整文件重写，规避模板漂移），把覆盖条目的 license 字段与两处模板注释改成最新口径。
 *
 * 安全栏：锚点计数断言（每包命中条目数与 license 行一一对应）、死键即失败、
 * 改动行仅限 license 行 + 两行注释，其余字节不动。幂等：已是最新口径则跳过并报告。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LICENSE_OVERRIDES } from './license-overrides.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CATALOG_TS = join(REPO_ROOT, 'packages', 'core', 'src', 'text', 'font', 'cn-catalog.ts')

// 与 build.mjs 生成模板同口径的两处注释（同步纪律：改模板必同步本两处）
const OLD_HEADER =
  ' * catalog 族白名单语义 = 默认停用（opt-in，D-c）；授权以包内 license 原文为准，未审计（D-d）。'
const NEW_HEADER =
  ' * catalog 族白名单语义 = 默认停用（opt-in，D-c）；授权以包内 license 原文为准，未审计（D-d；\n * LICENSE_OVERRIDES 一手核条目为上游真值）。'
const OLD_FIELD = '  /** npm 包内 license 字段原文（未审计，展示用） */'
const NEW_FIELD =
  '  /** license 标注（展示用）：npm 包内字段原文（未审计）；LICENSE_OVERRIDES 一手核条目为上游真值 */'

const src = readFileSync(CATALOG_TS, 'utf8')
const lines = src.split('\n')
let patchedLicense = 0
let alreadyOk = 0

for (const [pkg, license] of LICENSE_OVERRIDES) {
  const anchor = `    package: '${pkg}',`
  let anchors = 0
  let replaced = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== anchor) continue
    anchors++
    // license 行在同条目 package 行之后（formatEntry 固定字段序），窗口 6 行内必命中
    const win = lines.slice(i + 1, i + 7)
    const li = win.findIndex((l) => l.startsWith('    license: '))
    if (li === -1) throw new Error(`${pkg} 条目缺 license 行（锚点行 ${i + 1}）`)
    const abs = i + 1 + li
    const m = lines[abs].match(/^    license: '(.*)',$/)
    if (!m) throw new Error(`${pkg} license 行形态异常：${lines[abs]}`)
    if (m[1] === license) {
      alreadyOk++
      continue
    }
    lines[abs] = `    license: '${license}',`
    replaced++
  }
  if (anchors === 0)
    throw new Error(`死键：${pkg} 在 cn-catalog.ts 无条目（晋升精选的包须先删覆盖条目）`)
  patchedLicense += replaced
  console.log(`${pkg}: ${anchors} 条目命中，license 改写 ${replaced} 行 → '${license}'`)
}

// 模板注释两行（幂等：旧新必居其一且各一处）
let text = lines.join('\n')
const count = (s, sub) => s.split(sub).length - 1
let patchedComments = 0
for (const [oldLine, newLine, label] of [
  [OLD_HEADER, NEW_HEADER, '头部授权口径注释'],
  [OLD_FIELD, NEW_FIELD, 'license 字段注释']
]) {
  const oldN = count(text, oldLine)
  const newN = count(text, newLine)
  if (oldN === 1 && newN === 0) {
    text = text.replace(oldLine, newLine)
    patchedComments++
    console.log(`${label}: 已改写`)
  } else if (oldN === 0 && newN === 1) {
    console.log(`${label}: 已是最新口径，跳过`)
  } else {
    throw new Error(`${label} 锚点计数异常：旧 ${oldN} 处 / 新 ${newN} 处`)
  }
}

if (patchedLicense === 0 && patchedComments === 0 && alreadyOk > 0) {
  console.log(`全部已是最新口径（${alreadyOk} 条目），文件未改动`)
} else {
  writeFileSync(CATALOG_TS, text)
  console.log(`写入 ${CATALOG_TS}：license ${patchedLicense} 行 + 注释 ${patchedComments} 行`)
}
