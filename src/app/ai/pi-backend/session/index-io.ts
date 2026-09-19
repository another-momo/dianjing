/**
 * 2026-09-19 broker A线尾单件4：session index（index.json）持久化 IO 自
 * service.ts 拆出（service.ts 越 max-lines 600 上限回压）——原位搬迁，
 * 行为零变化。
 *
 * index.json = sessionId → 会话 JSONL 文件路径（SessionManager 持久化的
 * 索引面，sessionsDir 下），支持 dev server 重启后恢复。写侧走 tmp + 同
 * 目录 rename 原子替换（T27：防进程崩溃把 index.json 截成半个 JSON）；
 * 读侧 ENOENT（首跑尚无索引）属正常静默，文件在但读/解析失败 warn 并按
 * 空索引处理（只报路径与错误类型，不打印文件内容）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** index.json 形态：sessionId → 会话 JSONL 文件路径 */
export type SessionIndex = Record<string, { file: string }>

export function createSessionIndexIO(sessionsDir: string): {
  readIndex(): SessionIndex
  writeIndex(index: SessionIndex): void
} {
  const indexPath = join(sessionsDir, 'index.json')

  function readIndex(): SessionIndex {
    try {
      return JSON.parse(readFileSync(indexPath, 'utf8')) as SessionIndex
    } catch (error) {
      // T27：ENOENT（首跑尚无索引）属正常静默；文件在但读/解析失败必须出声
      // （只报路径与错误类型，不打印文件内容）
      if (existsSync(indexPath)) {
        console.warn(
          `[pi-backend] session index 读取失败，按空索引处理（${indexPath}）：` +
            (error instanceof Error ? error.message : String(error))
        )
      }
      return {}
    }
  }

  function writeIndex(index: SessionIndex): void {
    mkdirSync(sessionsDir, { recursive: true })
    // T27：tmp + 同目录 rename 原子替换，防进程崩溃把 index.json 截成半个 JSON
    const tmpPath = `${indexPath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(index, null, 2))
    renameSync(tmpPath, indexPath)
  }

  return { readIndex, writeIndex }
}
