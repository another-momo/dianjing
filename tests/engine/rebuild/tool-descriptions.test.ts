import { describe, expect, test } from 'bun:test'

import { ALL_TOOLS } from '#tests/helpers/tools'

function findTool(name: string) {
  const tool = ALL_TOOLS.find((t) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not found in ALL_TOOLS`)
  return tool
}

describe('tool descriptions', () => {
  test('eval description surfaces the three technical constraints', () => {
    const desc = findTool('eval').description
    // the three technical constraints: sync API surface, no-op font loading, counter ≠ confirmation
    // （eval 已移出 agent 面、仅宿主桥探针保留——description 仍是探针消费面的契约）
    expect(desc).toContain('sync API surface')
    expect(desc).toContain('no-op font loading')
    expect(desc).toMatch(/counter\s*≠\s*confirmation/)
    // belt-and-braces: the three concrete operational rules
    expect(desc).toContain('getNodeByIdAsync')
    expect(desc).toContain('loadFontAsync')
    expect(desc).toContain('describe')
  })

  test('stock_photo forbids eval-drawn gradient fallback on failure', () => {
    const desc = findTool('stock_photo').description
    // explicit no-fallback guidance: do not silently substitute fake images
    expect(desc.toLowerCase()).toContain('do not fall back')
    expect(desc.toLowerCase()).toContain('eval')
    expect(desc.toLowerCase()).toMatch(/gradient|rectangle/)
  })

  test('set_font marks font_family as update_node-unique and gives routing分工', () => {
    const desc = findTool('set_font').description
    // set_font is the only entry point for font_family
    expect(desc).toContain('font_family')
    expect(desc.toLowerCase()).toMatch(/only.*update_node|sole entry point/)
    // routing hint: update_node covers font_size / font_weight
    expect(desc).toContain('font_size')
    expect(desc).toContain('font_weight')
    expect(desc).toContain('update_node')
    // no batch font tool exists — make this explicit so callers do not look for one
    expect(desc.toLowerCase()).toContain('no bulk font-change tool')
  })

  test('set_text_resize gives routing advice for auto-resize vs fixed size', () => {
    const desc = findTool('set_text_resize').description
    // the mode enum must be named in the description
    expect(desc).toContain('NONE')
    expect(desc).toContain('WIDTH_AND_HEIGHT')
    expect(desc).toContain('HEIGHT')
    expect(desc).toContain('TRUNCATE')
    // routing: update_node handles fixed-size text; set_text_properties handles broader text layout
    expect(desc).toContain('update_node')
    expect(desc).toContain('set_text_properties')
  })
})
