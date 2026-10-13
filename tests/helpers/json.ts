/**
 * JSON/unknown 收窄 helper（测试与工具共享）。
 *
 * 背景：no-unvalidated-json-parse 要求 JSON 解析产物只能断言为 unknown 再收窄。
 * 本模块提供谓词式收窄原语——不走 as 断言，shape 不符由调用方决定 throw 或断言失败。
 */

/** 断言 unknown 为 JSON 对象（谓词收窄，非 as 断言） */
export function isJSONObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 断言值存在（替代非空断言）；缺失即 throw ——测试语境下即测试失败 */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected value to exist')
  return value
}
