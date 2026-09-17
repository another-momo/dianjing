/**
 * T43 studio 机制——frontmatter 切分。
 *
 * 不引 gray-matter：手写 `---` 块切分 + yaml 包 parse（根依赖 ^2.9.0，零新增依赖）。
 * 切分/解析失败不抛出——返回 error 判别联合，由 registry 记入 failures（S2 §8：
 * 单文件失败不影响其余文件）。
 *
 * P2-6（2026-09-07）：移除 `sections` 字段（小节索引 `Record<标题, 内容>`）——
 * 唯一消费方 PROFILE_REQUIRED_SECTIONS 已随 P2-5 删除，AI 读 body 全文，代码
 * 不再需要按标题拆分查找。`indexSections` 函数一并删除（保留 splitFrontmatter 与
 * isAssetId）。
 */

import { parse as parseYaml } from 'yaml'

export type ParsedAsset =
  | {
      ok: true
      frontmatter: Record<string, unknown>
      body: string
    }
  | { ok: false; reason: string; hint: string }

const ASSET_ID_RE = /^[a-z0-9]+([_-][a-z0-9]+)*$/

/** 机读 id 校验：小写字母/数字起头，连字符/下划线分段（S2 示例实为 snake_case 与 kebab 混用） */
export function isAssetId(id: string): boolean {
  return ASSET_ID_RE.test(id)
}

/** frontmatter map 与清单条目（validate.ts sizes 条目）共用的 record 判定 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 切分 frontmatter 与正文。文件首行必须是 `---`，其后到下一个独占行 `---` 为
 * YAML frontmatter（必须解析为 map），再往后为 markdown 正文。
 *
 * 行尾归一（2026-09-17）：剥 BOM 后立即把 `\r\n` 与孤立 `\r` 归一为 `\n`。
 * 必修背景——split 按 `\n` 切不剥 `\r`，CRLF 文件的 frontmatter 末行会残留孤立 `\r`
 * 在 YAML 文本 EOF 处，被 yaml 库并进最后一个标量。实测 `version: 2\r` 解析成字符串
 * `"2\r"`（typeof !== number），validate.ts parseVersion 拒绝，整条 profile 静默不
 * 注册。CI windows runner checkout（autocrlf 默认 true）把内置 studio md 资产转成
 * CRLF 打进安装包 → v0.1.0-ci.4 安装版 profile 全灭；用户在 Windows 上编辑
 * `%APPDATA%` 下的自定义资产同样撞。归一也连带把 body 从 CRLF 变 LF——可接受
 * （prompt 文本，按行处理即可）。
 */
export function splitFrontmatter(raw: string): ParsedAsset {
  const normalized = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines[0]?.trim() !== '---') {
    return {
      ok: false,
      reason: '缺 frontmatter：文件首行不是 `---`',
      hint: '在文件顶部加 `---` 包裹的 YAML frontmatter（至少含 id 与 label），再写正文'
    }
  }
  let closeIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIndex = i
      break
    }
  }
  if (closeIndex === -1) {
    return {
      ok: false,
      reason: 'frontmatter 未闭合：找不到第二个独占行 `---`',
      hint: '检查 frontmatter 块是否以独占一行 `---` 结束'
    }
  }
  const yamlText = lines.slice(1, closeIndex).join('\n')
  let doc: unknown
  try {
    doc = parseYaml(yamlText)
  } catch (e) {
    return {
      ok: false,
      reason: `frontmatter YAML 语法错误：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      hint: '用 YAML 校验器检查 frontmatter 块（常见坑：冒号后缺空格、未转义的引号）'
    }
  }
  if (!isRecord(doc)) {
    return {
      ok: false,
      reason: 'frontmatter 不是键值 map',
      hint: 'frontmatter 必须是 `key: value` 形式的 YAML map'
    }
  }
  const body = lines.slice(closeIndex + 1).join('\n')
  return { ok: true, frontmatter: doc, body }
}
