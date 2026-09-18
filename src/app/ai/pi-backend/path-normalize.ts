/**
 * 2026-09-18 CI 修红（run 35372599440，jscpd 阈值 0）：路径归一化算法
 * 单一真源——key-guard normalizePath 与 load-image normalizePathDual 原
 * 为两处同形重述（口径漂移风险曾钉在测试里），抽共享后 key-guard 只留
 * compare 薄壳。
 *
 * 红线：算法逐字节不变（key-guard.test.ts 全绿为证）——guard 类路径/字符
 * 串匹配器禁依赖 node 平台语义 API，本算法纯字符串操作。
 *
 * 算法：~ 展开 → 分隔符统一 → 绝对判定（前导 '/' 或盘符）→ resolve(cwd, p)
 * → 小写（compare 形态）→ 去尾部分隔符（根 '/' 须保留）。
 *
 * 先统一分隔符再做绝对判定——判定口径跨平台一致：Win 形态（反斜杠/盘符）
 * 在 POSIX 上也按同一形态归一（guard 是字符串匹配器，对不会在宿主机解析
 * 成功的拼法过挡属 fail-safe；2026-09-16 CI 34999312845 实证：isAbsolute
 * 平台语义致反斜杠用例在 Linux 漏挡）。
 *
 * compare 形态全小写 = 目标平台 Win/mac 文件系统均大小写不敏感；对大小写
 * 敏感 FS 是 fail-safe 过挡（凭据邻名宁可错挡）。absolute 形态大小写保留
 * 供真实 IO——小写化路径在大小写敏感 FS 上会写错位置。
 */

import { resolve } from 'node:path'

/**
 * 双形态归一化：compare（全小写，供名单比对）与 absolute（大小写保留，
 * 供真实 IO）。算法步骤与红线见头注。
 */
export function normalizePathDual(
  input: string,
  cwd: string,
  homeDir: string
): { compare: string; absolute: string } {
  // ~ 展开：仅首字符 ~ 且后跟分隔符或串尾
  const expanded =
    input.startsWith('~') && (input.length === 1 || input[1] === '/' || input[1] === '\\')
      ? homeDir + input.slice(1)
      : input
  const unifiedInput = expanded.replaceAll('\\', '/')
  const isAbs = unifiedInput.startsWith('/') || /^[a-zA-Z]:\//.test(unifiedInput)
  const absolute = isAbs ? unifiedInput : resolve(cwd, unifiedInput).replaceAll('\\', '/')
  // 去尾部分隔符：根 '/' 须保留
  const trim = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
  return { compare: trim(absolute.toLowerCase()), absolute: trim(absolute) }
}
