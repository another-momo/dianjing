/**
 * 字体选择器搜索匹配谓词：picker 缺省只按 css family 过滤，catalog 中文
 * 显示名不可检索——把 displayName 并入匹配面（family 子串优先，口径与
 * picker 缺省一致 = 大小写不敏感包含）。
 */
import { cnCatalogEntry, type FontFamilyOption } from '@open-pencil/core/text'

export function matchFontFamilyOrDisplayName(
  option: FontFamilyOption,
  searchTerm: string
): boolean {
  const needle = searchTerm.toLowerCase()
  if (option.family.toLowerCase().includes(needle)) return true
  const displayName = cnCatalogEntry(option.family)?.displayName
  return displayName ? displayName.toLowerCase().includes(needle) : false
}
