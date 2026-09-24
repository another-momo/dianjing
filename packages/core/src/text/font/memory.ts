/**
 * 字体字节预算与 LRU 逐出账本（T40 S1，OOM 防线）。
 *
 * 设计边界：
 * - 账本只做「键 → 字节数 + lastAccess」记账与 LRU 受害者挑选，不持有字体数据本体；
 *   字节的增删由 FontManager 在 registerAndCache/registerSupplemental 后调用 set() 重述，
 *   避免增量记账与 primary/supplemental 互换（registerAndCache 会把旧 primary 降级为
 *   补充片）造成的漂移。
 * - 逐出语义 = 释放 JS 引用（13 册 §3 策略 A）：CanvasKit 无法注销已注册 typeface，
 *   WASM 侧残留 2-10MB 属预期；浏览器侧 document.fonts 的 FontFace 由 FontManager 自行
 *   跟踪并在逐出时 delete（账本不感知 DOM）。
 * - lastAccess 用单调计数器而非 Date.now()：同毫秒内的 touch 也有全序，测试可确定性断言。
 */

export interface FontMemoryStats {
  budgetBytes: number
  loadedBytes: number
  entries: number
  evictions: number
  /** 检查时点的超预算键快照（鲸键按 LRU 序参与逐出，本字段仅作诊断观察点） */
  overBudgetKeys: string[]
}

export class FontMemoryLedger {
  private readonly lastAccessByKey = new Map<string, number>()
  private readonly bytesByKey = new Map<string, number>()
  private clock = 0

  set(key: string, bytes: number): void {
    this.bytesByKey.set(key, bytes)
    this.touch(key)
  }

  touch(key: string): void {
    if (!this.bytesByKey.has(key)) return
    this.lastAccessByKey.set(key, ++this.clock)
  }

  remove(key: string): void {
    this.bytesByKey.delete(key)
    this.lastAccessByKey.delete(key)
  }

  clear(): void {
    this.bytesByKey.clear()
    this.lastAccessByKey.clear()
  }

  bytes(key: string): number {
    return this.bytesByKey.get(key) ?? 0
  }

  totalBytes(): number {
    let total = 0
    for (const bytes of this.bytesByKey.values()) total += bytes
    return total
  }

  size(): number {
    return this.bytesByKey.size
  }

  /**
   * 按 LRU 序挑选受害者，直到累计释放 >= bytesToFree。exclude 中的键跳过
   * （调用方刚入账的键不应立刻被逐出）；无单条目豁免——鲸键豁免会把超预算键
   * 永久留在账上累积（复测轮实证 sup 泄漏主因），鲸键按 LRU 序正常参与逐出。
   */
  lruVictims(bytesToFree: number, exclude: ReadonlySet<string>, _budgetBytes: number): string[] {
    if (bytesToFree <= 0) return []
    const candidates = [...this.bytesByKey.entries()]
      .filter(([key]) => !exclude.has(key))
      .sort((a, b) => (this.lastAccessByKey.get(a[0]) ?? 0) - (this.lastAccessByKey.get(b[0]) ?? 0))
    const victims: string[] = []
    let freed = 0
    for (const [key, bytes] of candidates) {
      if (freed >= bytesToFree) break
      victims.push(key)
      freed += bytes
    }
    return victims
  }

  overBudgetKeys(budgetBytes: number): string[] {
    return [...this.bytesByKey.entries()]
      .filter(([, bytes]) => bytes > budgetBytes)
      .map(([key]) => key)
  }
}
