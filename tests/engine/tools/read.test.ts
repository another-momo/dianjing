import { describe, expect, test } from 'bun:test'

import { DEFAULT_FONT_FAMILY, FigmaAPI, fontManager } from '@open-pencil/core'

import { getTool, setupToolTest, type ALL_TOOLS, type ToolResult } from '#tests/helpers/tools'

describe('find_nodes', () => {
  test('finds by name', () => {
    const { figma } = setupToolTest()
    const rect = figma.createRectangle()
    rect.name = 'Button Primary'
    const text = figma.createText()
    text.name = 'Label'

    const tool = getTool('find_nodes')
    const result = tool.execute(figma, { name: 'button' }) as ToolResult
    expect(result.count).toBe(1)
    expect(result.nodes[0].name).toBe('Button Primary')
  })

  test('finds by type', () => {
    const { figma } = setupToolTest()
    figma.createRectangle()
    figma.createRectangle()
    figma.createText()

    const tool = getTool('find_nodes')
    const result = tool.execute(figma, { type: 'RECTANGLE' }) as ToolResult
    expect(result.count).toBe(2)
  })

  test('pages param accepts an id and returns matching page', () => {
    const { figma } = setupToolTest()
    const other = figma.createPage()
    other.name = 'Other'
    figma.currentPage = other
    const rect = figma.createRectangle()
    rect.name = 'OtherRect'

    const tool = getTool('find_nodes')
    const result = tool.execute(figma, { page: other.id }) as ToolResult
    expect(result.count).toBe(1)
    expect(result.nodes[0].name).toBe('OtherRect')
    expect(result.pageId).toBe(other.id)
    expect(result.page).toBe('Other')
  })

  test('pages param accepts an unambiguous page name', () => {
    const { figma } = setupToolTest()
    const other = figma.createPage()
    other.name = 'Slides'
    figma.currentPage = other
    const rect = figma.createRectangle()
    rect.name = 'Hero'

    const tool = getTool('find_nodes')
    const result = tool.execute(figma, { page: 'Slides' }) as ToolResult
    expect(result.count).toBe(1)
    expect(result.pageId).toBe(other.id)
  })

  test('pages param errors and lists candidates on duplicate name', () => {
    const { figma } = setupToolTest()
    const dup1 = figma.createPage()
    dup1.name = 'Cover'
    const dup2 = figma.createPage()
    dup2.name = 'Cover'

    const tool = getTool('find_nodes')
    const result = tool.execute(figma, { page: 'Cover' }) as {
      error: string
      candidates: Array<{ id: string; name: string }>
    }
    expect(result.error).toBeTruthy()
    expect(result.error).toContain('Multiple')
    const ids = result.candidates.map((c) => c.id)
    expect(ids).toContain(dup1.id)
    expect(ids).toContain(dup2.id)
  })

  test('pages param errors on unknown page name', () => {
    const { figma } = setupToolTest()
    const tool = getTool('find_nodes')
    const result = tool.execute(figma, { page: 'Nope' }) as {
      error: string
      candidates: Array<{ id: string; name: string }>
    }
    expect(result.error).toContain('not found')
    expect(result.candidates.length).toBeGreaterThanOrEqual(1)
  })

  test('pages param errors when id matches a non-page node', () => {
    const { figma } = setupToolTest()
    const rect = figma.createRectangle()
    rect.name = 'Decoy'

    const tool = getTool('find_nodes')
    const result = tool.execute(figma, { page: rect.id }) as { error: string }
    expect(result.error).toContain('not found')
  })
})

describe('query_nodes', () => {
  test('finds all frames with //FRAME', async () => {
    const { figma } = setupToolTest()
    const f1 = figma.createFrame()
    f1.resize(200, 200)
    f1.name = 'Frame A'
    const f2 = figma.createFrame()
    f2.resize(300, 300)
    f2.name = 'Frame B'
    figma.createRectangle()

    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, { selector: '//FRAME' })) as ToolResult
    expect(result.count).toBe(2)
    expect(result.nodes?.every((n) => n.type === 'FRAME')).toBe(true)
  })

  test('finds by attribute //RECTANGLE[@width < 200]', async () => {
    const { figma } = setupToolTest()
    const small = figma.createRectangle()
    small.resize(100, 50)
    small.name = 'Small'
    const big = figma.createRectangle()
    big.resize(400, 400)
    big.name = 'Big'

    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, {
      selector: '//RECTANGLE[@width < 200]'
    })) as ToolResult
    expect(result.count).toBe(1)
    expect(result.nodes[0].name).toBe('Small')
  })

  test('finds by name with contains', async () => {
    const { figma } = setupToolTest()
    const t1 = figma.createText()
    t1.name = 'Label Primary'
    const t2 = figma.createText()
    t2.name = 'Title'
    const t3 = figma.createText()
    t3.name = 'Label Secondary'

    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, {
      selector: '//TEXT[contains(@name, "Label")]'
    })) as ToolResult
    expect(result.count).toBe(2)
    expect(result.nodes?.every((n) => n.name.includes('Label'))).toBe(true)
  })

  test('returns error for invalid xpath', async () => {
    const { figma } = setupToolTest()
    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, { selector: '///invalid[[[[' })) as ToolResult
    expect(result.error).toBeTruthy()
    expect(result.error).toContain('XPath error')
  })

  test('respects limit param', async () => {
    const { figma } = setupToolTest()
    for (let i = 0; i < 10; i++) {
      const r = figma.createRectangle()
      r.name = `Rect ${i}`
    }

    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, { selector: '//RECTANGLE', limit: 3 })) as ToolResult
    expect(result.count).toBe(3)
  })

  test('returns empty array when nothing matches', async () => {
    const { figma } = setupToolTest()
    figma.createRectangle()

    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, { selector: '//ELLIPSE' })) as ToolResult
    expect(result.count).toBe(0)
    expect(result.nodes).toEqual([])
  })

  test('pages param accepts an id and scopes results', async () => {
    const { figma } = setupToolTest()
    const other = figma.createPage()
    other.name = 'Slides'
    figma.currentPage = other
    const f1 = figma.createFrame()
    f1.name = 'OnlyOnSlides'
    f1.resize(100, 100)
    // back to the default first page and add a distractor
    const first = figma.root.children.find((p) => p.id !== other.id)
    if (first) {
      figma.currentPage = first
      const f2 = figma.createFrame()
      f2.name = 'OnFirst'
      f2.resize(100, 100)
    }

    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, {
      selector: '//FRAME',
      page: other.id
    })) as ToolResult
    expect(result.count).toBe(1)
    expect(result.nodes[0].name).toBe('OnlyOnSlides')
    expect(result.pageId).toBe(other.id)
  })

  test('pages param accepts an unambiguous page name', async () => {
    const { figma } = setupToolTest()
    const other = figma.createPage()
    other.name = 'Slides'
    figma.currentPage = other
    const f1 = figma.createFrame()
    f1.name = 'Hero'

    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, {
      selector: '//FRAME',
      page: 'Slides'
    })) as ToolResult
    expect(result.count).toBe(1)
    expect(result.pageId).toBe(other.id)
  })

  test('pages param errors and lists candidates on duplicate name', async () => {
    const { figma } = setupToolTest()
    const dup1 = figma.createPage()
    dup1.name = 'Cover'
    const dup2 = figma.createPage()
    dup2.name = 'Cover'

    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, {
      selector: '//FRAME',
      page: 'Cover'
    })) as { error: string; candidates: Array<{ id: string; name: string }> }
    expect(result.error).toContain('Multiple')
    const ids = result.candidates.map((c) => c.id)
    expect(ids).toContain(dup1.id)
    expect(ids).toContain(dup2.id)
  })

  test('pages param id scopes correctly even with duplicate page names', async () => {
    const { figma } = setupToolTest()
    const dup1 = figma.createPage()
    dup1.name = 'Cover'
    const dup2 = figma.createPage()
    dup2.name = 'Cover'
    figma.currentPage = dup1
    const f1 = figma.createFrame()
    f1.name = 'OnDup1'
    f1.resize(100, 100)
    figma.currentPage = dup2
    const f2 = figma.createFrame()
    f2.name = 'OnDup2'
    f2.resize(100, 100)

    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, {
      selector: '//FRAME',
      page: dup2.id
    })) as ToolResult
    // id 权威必须下穿到查询层：重名页不串台（只命中 dup2，不含 dup1 的 OnDup1）
    expect(result.count).toBe(1)
    expect(result.nodes[0].name).toBe('OnDup2')
    expect(result.pageId).toBe(dup2.id)
  })

  test('pages param errors on unknown page name', async () => {
    const { figma } = setupToolTest()
    const tool = getTool('query_nodes')
    const result = (await tool.execute(figma, {
      selector: '//FRAME',
      page: 'Nope'
    })) as { error: string; candidates: Array<{ id: string; name: string }> }
    expect(result.error).toContain('not found')
    expect(result.candidates.length).toBeGreaterThanOrEqual(1)
  })
})

describe('get_font_status', () => {
  test('returns font fidelity diagnostics for agents', () => {
    const { figma } = setupToolTest()
    const text = figma.createText()
    text.name = 'Missing label'
    text.fontName = { family: 'Unavailable Sans', style: 'Regular' }

    const tool = getTool('get_font_status')
    const result = tool.execute(figma, {}) as {
      faithful: boolean
      issues: Array<{
        family: string
        style: string
        status: string
        nodeIds: string[]
      }>
    }

    // The tool reads the process-wide font manager. A missing family is
    // 'unresolved' in a pristine process and 'substituted' by the default font
    // once any earlier suite in the shard has loaded it; both are issues.
    const defaultLoaded = fontManager.loadedFontSource(DEFAULT_FONT_FAMILY, 'Regular') !== null

    expect(result.faithful).toBe(false)
    expect(result.issues).toEqual([
      expect.objectContaining({
        family: 'Unavailable Sans',
        style: 'Regular',
        status: defaultLoaded ? 'substituted' : 'unresolved',
        substituteFamily: defaultLoaded ? DEFAULT_FONT_FAMILY : null,
        nodeIds: [text.id]
      })
    ])
  })
})

describe('get_node', () => {
  test('returns node details', () => {
    const { figma } = setupToolTest()
    const rect = figma.createRectangle()
    rect.name = 'Test Rect'
    rect.resize(100, 50)

    const tool = getTool('get_node')
    const result = tool.execute(figma, { id: rect.id }) as ToolResult
    expect(result.name).toBe('Test Rect')
    expect(result.width).toBe(100)
    expect(result.height).toBe(50)
  })
})

describe('page tools', () => {
  test('list_pages returns pages', () => {
    const { figma } = setupToolTest()
    const tool = getTool('list_pages')
    const result = tool.execute(figma, {}) as ToolResult
    expect(result.pages.length).toBeGreaterThanOrEqual(1)
  })

  test('switch_page changes page', () => {
    const { figma } = setupToolTest()
    const page2 = figma.createPage()
    page2.name = 'Page 2'

    const tool = getTool('switch_page')
    tool.execute(figma, { page: 'Page 2' })

    expect(figma.currentPage.name).toBe('Page 2')
  })

  test('switch_page persists across separate FigmaAPI instances (RPC simulation)', () => {
    const { graph } = setupToolTest()
    const switchPage = getTool('switch_page')
    const getCurrentPage = getTool('get_current_page')
    const createPage = getTool('create_page')

    let currentPageId = graph.getPages()[0].id

    function rpcCall(tool: (typeof ALL_TOOLS)[number], args: Record<string, unknown>) {
      const figma = new FigmaAPI(graph)
      figma.currentPage = figma.wrapNode(currentPageId)
      const result = tool.execute(figma, args)
      if (figma.currentPageId !== currentPageId) {
        currentPageId = figma.currentPageId
      }
      return result
    }

    rpcCall(createPage, { name: 'Second' })
    rpcCall(switchPage, { page: 'Second' })
    const result = rpcCall(getCurrentPage, {}) as { id: string; name: string }

    expect(result.name).toBe('Second')
  })
})

describe('eval', () => {
  test('executes code with figma api', async () => {
    const { figma } = setupToolTest()
    const tool = getTool('eval')
    const result = await tool.execute(figma, {
      code: 'const r = figma.createRectangle(); r.name = "FromEval"; return r.name;'
    })
    expect(result).toBe('FromEval')
  })
})
