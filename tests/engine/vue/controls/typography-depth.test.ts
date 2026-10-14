import { describe, expect, test } from 'bun:test'

import { computed } from 'vue'

import { createEditor } from '@open-pencil/core/editor'

import { createTypographyActions } from '#vue/controls/typography/actions'
import { filterWeightsForFamily } from '#vue/controls/typography/use'

describe('typography depth actions', () => {
  test('restores nullable max lines and text style after preview undo', () => {
    const editor = createEditor()
    const text = editor.graph.createNode('TEXT', editor.state.currentPageId, {
      maxLines: null,
      textStyleId: '1:20'
    })
    const nodes = computed(() =>
      [editor.graph.getNode(text.id)].filter((node) => node !== undefined)
    )
    const actions = createTypographyActions({
      editor,
      nodes,
      activeFormatting: computed(() => []),
      options: {}
    })

    actions.updateProp('maxLines', 3)
    actions.commitProp('maxLines', 3, 1)
    expect(editor.graph.getNode(text.id)).toMatchObject({ maxLines: 3, textStyleId: '1:20' })

    editor.undo.undo()
    expect(editor.graph.getNode(text.id)).toMatchObject({ maxLines: null, textStyleId: '1:20' })
  })

  test('updates OpenType features and detaches text styles in one undo step', () => {
    const editor = createEditor()
    const text = editor.graph.createNode('TEXT', editor.state.currentPageId, {
      fontFeatures: [{ tag: 'kern', enabled: true }],
      textStyleId: '1:21'
    })
    const actions = createTypographyActions({
      editor,
      nodes: computed(() => [editor.graph.getNode(text.id)].filter((node) => node !== undefined)),
      activeFormatting: computed(() => []),
      options: {}
    })

    actions.setFontFeature('LIGA', false)
    expect(editor.graph.getNode(text.id)).toMatchObject({
      fontFeatures: [
        { tag: 'kern', enabled: true },
        { tag: 'LIGA', enabled: false }
      ],
      textStyleId: null
    })
    editor.undo.undo()
    expect(editor.graph.getNode(text.id)).toMatchObject({
      fontFeatures: [{ tag: 'kern', enabled: true }],
      textStyleId: '1:21'
    })
  })

  // Figma desktop 126 edits every selected text when several are selected.
  test('changes every text layer in one undo step', () => {
    const editor = createEditor()
    const pageId = editor.state.currentPageId
    const first = editor.graph.createNode('TEXT', pageId, { textCase: 'ORIGINAL' })
    const second = editor.graph.createNode('TEXT', pageId, { textCase: 'LOWER' })
    const actions = createTypographyActions({
      editor,
      nodes: computed(() =>
        [first.id, second.id]
          .map((id) => editor.graph.getNode(id))
          .filter((node) => node !== undefined)
      ),
      activeFormatting: computed(() => []),
      options: {}
    })

    actions.setTextCase('UPPER')
    expect([first.id, second.id].map((id) => editor.graph.getNode(id)?.textCase)).toEqual([
      'UPPER',
      'UPPER'
    ])
    editor.undo.undo()
    expect([first.id, second.id].map((id) => editor.graph.getNode(id)?.textCase)).toEqual([
      'ORIGINAL',
      'LOWER'
    ])
  })

  test('reports a failed weight pick per family via onMissingWeight', async () => {
    const editor = createEditor()
    const pageId = editor.state.currentPageId
    const text = editor.graph.createNode('TEXT', pageId, {
      fontFamily: 'Subset Sans',
      text: 'Hello'
    })
    const missing: Array<[string, number]> = []
    const actions = createTypographyActions({
      editor,
      nodes: computed(() => {
        const node = editor.graph.getNode(text.id)
        return node ? [node] : []
      }),
      activeFormatting: computed(() => []),
      options: {
        fontLoader: { load: async () => null },
        onMissingWeight: (family, weight) => missing.push([family, weight])
      }
    })

    await actions.setWeight(900)

    expect(missing).toEqual([['Subset Sans', 900]])
  })

  test('passes the node text to the loader for subset piece selection', async () => {
    const editor = createEditor()
    const pageId = editor.state.currentPageId
    const text = editor.graph.createNode('TEXT', pageId, {
      fontFamily: 'Subset Sans',
      text: '你好世界'
    })
    const loads: Array<{ family: string; style: string; characters?: string }> = []
    const actions = createTypographyActions({
      editor,
      nodes: computed(() => {
        const node = editor.graph.getNode(text.id)
        return node ? [node] : []
      }),
      activeFormatting: computed(() => []),
      options: {
        fontLoader: {
          load: async (family: string, style: string, characters?: string) => {
            loads.push({ family, style, characters })
            return new ArrayBuffer(8)
          }
        }
      }
    })

    await actions.setWeight(500)

    expect(loads).toEqual([{ family: 'Subset Sans', style: 'Medium', characters: '你好世界' }])
  })

  test('does not report a failed weight pick for an empty text node', async () => {
    const editor = createEditor()
    const pageId = editor.state.currentPageId
    const text = editor.graph.createNode('TEXT', pageId, { fontFamily: 'Subset Sans' })
    const missing: Array<[string, number]> = []
    const actions = createTypographyActions({
      editor,
      nodes: computed(() => {
        const node = editor.graph.getNode(text.id)
        return node ? [node] : []
      }),
      activeFormatting: computed(() => []),
      options: {
        fontLoader: { load: async () => null },
        onMissingWeight: (family, weight) => missing.push([family, weight])
      }
    })

    await actions.setWeight(900)

    expect(missing).toEqual([])
  })

  test('does not report when the weight face loads', async () => {
    const editor = createEditor()
    const pageId = editor.state.currentPageId
    const text = editor.graph.createNode('TEXT', pageId, { fontFamily: 'Full Sans' })
    const missing: Array<[string, number]> = []
    const actions = createTypographyActions({
      editor,
      nodes: computed(() => {
        const node = editor.graph.getNode(text.id)
        return node ? [node] : []
      }),
      activeFormatting: computed(() => []),
      options: {
        fontLoader: { load: async () => new ArrayBuffer(8) },
        onMissingWeight: (family, weight) => missing.push([family, weight])
      }
    })

    await actions.setWeight(700)

    expect(missing).toEqual([])
    expect(editor.graph.getNode(text.id)?.fontWeight).toBe(700)
  })
})

describe('filterWeightsForFamily', () => {
  test('filters the ladder to the registered styles of a static bundled family', () => {
    // Inter 注册五档（Regular/Medium/SemiBold/Bold/ExtraBold）
    expect(filterWeightsForFamily('Inter').map((entry) => entry.value)).toEqual([
      400, 500, 600, 700, 800
    ])
  })

  test('keeps the full ladder for variable and unknown families', () => {
    // Noto Sans SC 注册为 variable（未加载时 fvar 未嗅探，仍走注册表分支放行全梯）
    expect(filterWeightsForFamily('Noto Sans SC')).toHaveLength(9)
    expect(filterWeightsForFamily('Some User Installed Family')).toHaveLength(9)
    expect(filterWeightsForFamily('')).toHaveLength(9)
  })
})
