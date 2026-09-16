/**
 * T28（决策单 #2，owner 拍板 2026-08-25）：会话 GC——归档不删除。
 *
 * 触发点：铸新会话后（service.ts createSession 内调用）。规则：
 *  - 会话文件（*.jsonl）数 > maxSessions（env DIANJING_MAX_SESSIONS，默认 200）
 *    → 按 mtime 最老先归，直到不超阈值
 *  - mtime 老于 maxAgeDays（env DIANJING_SESSION_MAX_AGE_DAYS，默认 30）→ 归档
 * 归档 = 移动（rename，同卷）到 archiveDir（.dianjing/pi-sessions-archive/），
 * 保持文件名；index.json 同步移除对应条目；archive 目录不建索引。
 * listSessionFamily/readHistory 都经 index.json 解析——归档除条后自然不可见，
 * readHistory 对已归档 sessionId 走 index miss 返回空（既有语义，前端按无历史处理）。
 * GC 任何失败不阻断主流程（调用方 try/catch + warn）。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

type SessionIndex = Record<string, { file: string }>

export function runSessionGc({
  sessionsDir,
  archiveDir,
  maxSessions,
  maxAgeDays,
  readIndex,
  writeIndex
}: {
  sessionsDir: string
  archiveDir: string
  maxSessions: number
  maxAgeDays: number
  readIndex: () => SessionIndex
  writeIndex: (index: SessionIndex) => void
}): { archived: string[] } {
  if (!existsSync(sessionsDir)) return { archived: [] }

  const ageCutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const files = readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((name) => {
      const path = join(sessionsDir, name)
      return { name, path, mtimeMs: statSync(path).mtimeMs }
    })
    // 最老在前：超阈值时从头归
    .sort((a, b) => a.mtimeMs - b.mtimeMs)

  const toArchive = new Set<string>()
  for (const f of files) {
    if (f.mtimeMs < ageCutoffMs) toArchive.add(f.name)
  }
  let remaining = files.length - toArchive.size
  for (const f of files) {
    if (remaining <= maxSessions) break
    if (toArchive.has(f.name)) continue
    toArchive.add(f.name)
    remaining--
  }
  if (toArchive.size === 0) return { archived: [] }

  mkdirSync(archiveDir, { recursive: true })
  const archivedNames = new Set<string>()
  for (const name of toArchive) {
    try {
      renameSync(join(sessionsDir, name), join(archiveDir, name))
      archivedNames.add(name)
    } catch (error) {
      // 单个文件移动失败（占用/权限）不拖垮整批——留下次 GC 再试
      console.warn(
        `[pi-backend] session GC：归档 ${name} 失败（跳过）：` +
          (error instanceof Error ? error.message : String(error))
      )
    }
  }
  if (archivedNames.size === 0) return { archived: [] }

  // index 除条：按文件名匹配（index 存的绝对路径分隔符/大小写随写入方而异，
  // 文件名在 sessionsDir 内唯一，basename 匹配最稳）。
  // 重建对象而非 delete（oxlint no-dynamic-delete：动态 delete 破坏 V8 快属性）
  const index = readIndex()
  const kept: SessionIndex = {}
  let changed = false
  for (const [sessionId, entry] of Object.entries(index)) {
    if (archivedNames.has(basename(entry.file))) {
      changed = true
      continue
    }
    kept[sessionId] = entry
  }
  if (changed) writeIndex(kept)
  return { archived: [...archivedNames] }
}
