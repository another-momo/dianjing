/**
 * 字体选择器搜索匹配谓词：picker 缺省只按 css family 过滤，中文显示名不可
 * 检索——把 displayName 并入匹配面（family 子串优先，口径与 picker 缺省一致 =
 * 大小写不敏感包含）。registry 精选与 catalog 目录的 displayName 同口径生效。
 */
import { fontFamilyDisplayName, type FontFamilyOption } from '@open-pencil/core/text'

export function matchFontFamilyOrDisplayName(
  option: FontFamilyOption,
  searchTerm: string
): boolean {
  const needle = searchTerm.toLowerCase()
  if (option.family.toLowerCase().includes(needle)) return true
  const displayName = fontFamilyDisplayName(option.family)
  return displayName ? displayName.toLowerCase().includes(needle) : false
}
