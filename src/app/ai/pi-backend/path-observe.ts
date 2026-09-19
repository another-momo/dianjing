/**
 * 2026-09-19 broker P0-2 shadow 观测（仓外
 * docs/202609181745-agent-permission-broker-design.md §10-P0-2）——tool_call
 * 只记录不拦截：对路径类工具调 decidePath（./path-decision.ts 判定单源）
 * 拿判定，append-only JSONL 落盘（rootDir/broker-shadow.jsonl），供界外
 * 读/写频率与路径分布观测 1–2 周 → 校准敏感名单（P0-3 之后续批扩面依据）。
 *
 * 与 key-guard 同构：handler 与 extension 分离导出，测试直钉 handler
 * （免 ExtensionAPI 桩件）。
 *
 * 纪律（设计稿拍板口径）：
 *  - 永不 block（handler 恒返回 undefined）；一切异常 try/catch 静默吞——
 *    观测永不能打断工具执行（emitToolCall 链上 handler throw 会被
 *    agent-session 转成 block 整次调用）。
 *  - 观测面 = key-guard 放行后的调用：emitToolCall 遇 block 短路返回，
 *    本 extension 注册序在 key-guard 之后（session/assembly.ts）——被
 *    guard 拦下的调用不进日志（凭据/敏感名单命中已有 guard reason 兜底，
 *    观测价值在 guard 不拦的界外流量）。
 *  - find / ls / bash / 其他 custom 不观测（find/ls 输出仅文件名，存在性
 *    非机密；bash 无路径参数、走命令规则面）。
 *  - export_image_to_file 省略 output_path 时跳过：缺省落点恒为 workspace
 *    内日期桶，无界外信号。
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { InlineExtension } from '@earendil-works/pi-coding-agent'

import { decidePath, type PathFacet } from './path-decision'

/**
 * 观测对象六件的路径参数与 facet 映射（schema 实证：内建 read/write/edit
 * input.path 必填、grep input.path 可选缺省搜 cwd——dist/core/tools/*.d.ts；
 * load_image input.file_path；export_image_to_file input.output_path 可选）。
 * whenMissing：'cwd' = 路径参数缺省按 cwd 观测（grep）；'skip' = 缺省不观测。
 */
type ObservedToolSpec = {
  facet: PathFacet
  pathKey: string
  whenMissing: 'cwd' | 'skip'
}

const OBSERVED_TOOLS: ReadonlyMap<string, ObservedToolSpec> = new Map([
  ['read', { facet: 'read', pathKey: 'path', whenMissing: 'skip' }],
  ['write', { facet: 'write', pathKey: 'path', whenMissing: 'skip' }],
  ['edit', { facet: 'write', pathKey: 'path', whenMissing: 'skip' }],
  ['grep', { facet: 'read', pathKey: 'path', whenMissing: 'cwd' }],
  ['load_image', { facet: 'read', pathKey: 'file_path', whenMissing: 'skip' }],
  ['export_image_to_file', { facet: 'write', pathKey: 'output_path', whenMissing: 'skip' }]
])

/** shadow 日志行（broker-shadow.jsonl 一行一件，append-only） */
interface ShadowRecord {
  ts: string
  toolName: string
  facet: PathFacet
  decision: 'allow' | 'deny'
  /** 非 workspace 子树且非 deny 名单命中（= decidePath denyCause 'outside'） */
  outside: boolean
  /** 归一化绝对路径（大小写保留形态） */
  path: string
}

/** 观测装配宽参（handler 与 extension 共用；与 key-guard inline opts 同形语义） */
export interface PathObserveOptions {
  rootDir: string
  /** session cwd（= rootDir/workspace；grep 缺省 path 的观测基点） */
  cwd: string
  homeDir?: string
}

/**
 * shadow 观测 handler——永不 block、永不抛（观测不能打断工具执行）。
 * 暴露单独函数便于测试直钉（与 createKeyGuardHandler 同构）。
 */
export function createPathObserveHandler(
  opts: PathObserveOptions
): (event: { toolName: string; input: Record<string, unknown> }) => undefined {
  const homeDir = opts.homeDir ?? homedir()
  const logFile = join(opts.rootDir, 'broker-shadow.jsonl')
  return (event) => {
    try {
      const spec = OBSERVED_TOOLS.get(event.toolName)
      if (!spec) return undefined
      const raw = event.input[spec.pathKey]
      let pathInput: string | undefined
      if (typeof raw === 'string') {
        pathInput = raw
      } else if (spec.whenMissing === 'cwd') {
        pathInput = opts.cwd
      }
      if (pathInput === undefined) return undefined
      const verdict = decidePath(pathInput, {
        facet: spec.facet,
        rootDir: opts.rootDir,
        cwd: opts.cwd,
        homeDir
      })
      const record: ShadowRecord = {
        ts: new Date().toISOString(),
        toolName: event.toolName,
        facet: spec.facet,
        decision: verdict.ok ? 'allow' : 'deny',
        outside: !verdict.ok && verdict.denyCause === 'outside',
        path: verdict.absolutePath
      }
      appendFileSync(logFile, JSON.stringify(record) + '\n')
    } catch {
      // 观测永不能打断工具执行——落盘失败等一切异常静默吞
    }
    return undefined
  }
}

/** shadow 观测的 inline extension 装配形态——session/assembly.ts 注入 extensionFactories */
export function createPathObserveExtension(opts: PathObserveOptions): InlineExtension {
  const handler = createPathObserveHandler(opts)
  return (pi) => {
    pi.on('tool_call', handler)
  }
}
