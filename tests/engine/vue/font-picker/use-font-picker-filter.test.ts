/**
 * picker 搜索匹配面钉扎：缺省 = css family 子串（大小写不敏感），中文
 * displayName 不在缺省匹配面；注入 matchFontFamilyOrDisplayName 后 catalog
 * 中文显示名可检索，family 子串命中不回归。
 */
import { describe, expect, test } from 'bun:test'

import { nextTick, ref } from 'vue'

import type { FontFamilyOption } from '@open-pencil/core/text'

import { matchFontFamilyOrDisplayName } from '@/components/font-picker/font-option-filter'

import { useFontPicker } from '#vue/primitives/FontPicker/useFontPicker'

const CATALOG_OPTION: FontFamilyOption = { family: 'bailubangbangshouxieti', source: 'cdn' }
const BUNDLED_OPTION: FontFamilyOption = { family: 'Inter', source: 'bundled' }

async function openAndLoad(picker: ReturnType<typeof useFontPicker>): Promise<void> {
  picker.open.value = true
  await nextTick()
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
  await nextTick()
}

describe('useFontPicker 搜索过滤', () => {
  test('缺省过滤：family 子串大小写不敏感；中文显示名不在缺省匹配面', async () => {
    const picker = useFontPicker({
      modelValue: ref(''),
      listFamilies: async () => [CATALOG_OPTION, BUNDLED_OPTION]
    })
    await openAndLoad(picker)

    picker.searchTerm.value = 'inter'
    expect(picker.filtered.value.map((option) => option.family)).toEqual(['Inter'])

    picker.searchTerm.value = 'bailu'
    expect(picker.filtered.value.map((option) => option.family)).toEqual(['bailubangbangshouxieti'])

    picker.searchTerm.value = '白路'
    expect(picker.filtered.value).toEqual([])
  })

  test('注入 matchFontFamilyOrDisplayName：catalog 中文显示名可检索，原匹配面不回归', async () => {
    const picker = useFontPicker({
      modelValue: ref(''),
      listFamilies: async () => [CATALOG_OPTION, BUNDLED_OPTION],
      filterOption: matchFontFamilyOrDisplayName
    })
    await openAndLoad(picker)

    picker.searchTerm.value = '白路'
    expect(picker.filtered.value.map((option) => option.family)).toEqual(['bailubangbangshouxieti'])

    picker.searchTerm.value = 'bailu'
    expect(picker.filtered.value.map((option) => option.family)).toEqual(['bailubangbangshouxieti'])

    picker.searchTerm.value = 'inter'
    expect(picker.filtered.value.map((option) => option.family)).toEqual(['Inter'])
  })
})
