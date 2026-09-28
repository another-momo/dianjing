/**
 * 字体选择器搜索匹配谓词：picker 缺省只按 css family 过滤，中文显示名不可
 * 检索——把 displayName 并入匹配面（family 子串优先，口径与 picker 缺省一致 =
 * 大小写不敏感包含）。registry 精选 / catalog 目录 / 专属字体服务（条目自带
 * displayName）三个来源的显示名同口径生效。
 */
import { fontFamilyDisplayName, type FontFamilyOption } from '@open-pencil/core/text'

export function matchFontFamilyOrDisplayName(
  option: FontFamilyOption,
  searchTerm: string
): boolean {
  const needle = searchTerm.toLowerCase()
  if (option.family.toLowerCase().includes(needle)) return true
  const displayName = option.displayName ?? fontFamilyDisplayName(option.family)
  return displayName ? displayName.toLowerCase().includes(needle) : false
}
