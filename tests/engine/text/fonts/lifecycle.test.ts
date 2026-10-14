import { describe, expect, test } from 'bun:test'

import type { CanvasKit, TypefaceFontProvider } from 'canvaskit-wasm'

import { FontManager, fontManager } from '@open-pencil/core/text'
import { SceneGraph } from '@open-pencil/scene-graph'

import { isTextPictureCurrent } from '#core/canvas/renderer/fonts'
import { nodeFontReadiness } from '#core/canvas/text'
import { fontFaceDemand, fontResolver } from '#core/text/resolver'

function pageId(graph: SceneGraph): string {
  return graph.getPages()[0].id
}

describe('font lifecycle', () => {
  test('advances generation only for provider epochs and unique registrations', () => {
    const manager = new FontManager()
    const registrations: string[] = []
    const provider = {
      registerFont(_data: ArrayBuffer, family: string) {
        registrations.push(family)
      }
    } as TypefaceFontProvider
    const data = new ArrayBuffer(12)

    expect(manager.generation()).toBe(0)
    manager.attachProvider({} as CanvasKit, provider)
    const providerGeneration = manager.generation()
    manager.markLoaded('Generation Test', 'Regular', data)
    const registrationGeneration = manager.generation()
    manager.markLoaded('Generation Test', 'Regular', data)

    expect(providerGeneration).toBeGreaterThan(0)
    expect(registrationGeneration).toBeGreaterThan(providerGeneration)
    expect(manager.generation()).toBe(registrationGeneration)
    expect(registrations).toEqual(['Generation Test'])
  })

  test('keeps cumulative subset registrations under the source family', () => {
    const manager = new FontManager()
    const registrations: string[] = []
    const provider = {
      registerFont(_data: ArrayBuffer, family: string) {
        registrations.push(family)
      }
    } as TypefaceFontProvider

    manager.attachProvider({} as CanvasKit, provider)
    manager.markLoaded('Subset Font', 'Regular', new ArrayBuffer(8))
    const firstGeneration = manager.generation()
    manager.markLoaded('Subset Font', 'Regular', new ArrayBuffer(12))

    expect(manager.renderFamily('Subset Font', 'Regular')).toBe('Subset Font')
    expect(manager.generation()).toBeGreaterThan(firstGeneration)
    expect(registrations).toEqual(['Subset Font', 'Subset Font'])
  })

  test('refuses to cache bytes that every attached provider rejects', () => {
    const manager = new FontManager()
    const provider = {
      registerFont() {
        throw new Error('not a font')
      }
    } as TypefaceFontProvider
    manager.attachProvider({} as CanvasKit, provider)

    // CanvasKit 拒收的字节入账会缓存「已加载」假象——demand 链短路、画布静默 tofu
    manager.markLoaded('Broken Sans', 'Regular', new ArrayBuffer(64))

    expect(manager.isLoaded('Broken Sans')).toBe(false)
    expect(manager.loadedData('Broken Sans', 'Regular')).toBeNull()
    expect(manager.loadedFontSource('Broken Sans', 'Regular')).toBeNull()
  })

  test('tracks nodes gated by pre-render font resolution', () => {
    const manager = new FontManager()
    manager.blockNodesUntilFontsResolve(['first', 'second'])
    expect(manager.isNodeBlocked('first')).toBe(true)
    expect(manager.isNodeBlocked('second')).toBe(true)
    manager.unblockNodes(['first'])
    expect(manager.isNodeBlocked('first')).toBe(false)
    expect(manager.isNodeBlocked('second')).toBe(true)
  })

  test('installed variable family resolves any requested weight to its variable style entry', async () => {
    const readKeys: string[] = []
    const manager = new FontManager()
    manager.setUserFontProvider({
      async list() {
        return [
          {
            family: 'Installed VF',
            styles: [
              // 安装清单对 VF 只登记一条条目（weight 恒 400）——区间内其余档
              // 的解析依赖 variable 条目回退匹配
              {
                key: 'Variable',
                weight: 400,
                italic: false,
                variable: true,
                artifact: 'full' as const
              }
            ]
          }
        ]
      },
      async read(_family, key) {
        readKeys.push(key)
        return new ArrayBuffer(8)
      }
    })

    expect(await manager.loadFont('Installed VF', 'Black')).toBeTruthy()
    expect(readKeys).toEqual(['Variable'])

    // 斜体不放宽：正立体 VF 不应承接 italic 请求
    expect(await manager.loadFont('Installed VF', 'Bold Italic')).toBeNull()
    expect(readKeys).toEqual(['Variable'])
  })

  test('subset-collection 族按 list artifact 跳过 read 探测直走分片；full 族仍先 read', async () => {
    const readCalls: string[] = []
    const subsetPieceCalls: string[] = []
    const manager = new FontManager()
    manager.setUserFontProvider({
      async list() {
        return [
          {
            family: 'Subset Fam',
            styles: [
              {
                key: 'Regular',
                weight: 400,
                italic: false,
                variable: false,
                artifact: 'subset-collection' as const
              }
            ]
          },
          {
            family: 'Full Fam',
            styles: [
              {
                key: 'Regular',
                weight: 400,
                italic: false,
                variable: false,
                artifact: 'full' as const
              }
            ]
          }
        ]
      },
      async read(family) {
        readCalls.push(family)
        return new ArrayBuffer(8)
      },
      async readSubsetPieces(args) {
        subsetPieceCalls.push(args.family)
        return null
      }
    })

    await manager.loadFont('Subset Fam', 'Regular', '你')
    expect(readCalls).not.toContain('Subset Fam')
    expect(subsetPieceCalls).toEqual(['Subset Fam'])

    await manager.loadFont('Full Fam', 'Regular', '你')
    expect(readCalls).toEqual(['Full Fam'])
    expect(subsetPieceCalls).toEqual(['Subset Fam'])
  })

  test('rejects a text picture observed before the font generation changed', () => {
    const graph = new SceneGraph()
    const node = graph.createNode('TEXT', pageId(graph), {
      name: 'Cached fallback',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      text: 'Hello',
      textPicture: new Uint8Array([1, 2, 3])
    })
    const renderer = {
      fontGeneration: 1,
      textPictureGenerations: new Map<string, { data: Uint8Array; generation: number }>()
    }

    expect(isTextPictureCurrent(renderer, node)).toBe(true)
    renderer.fontGeneration = 2
    expect(isTextPictureCurrent(renderer, node)).toBe(false)
  })

  test('keeps text visible when an unavailable italic face can use a loaded family face', () => {
    const family = 'Missing Italic Regression'
    const demand = fontFaceDemand(family, 'Regular Italic', 'Hello')
    fontResolver.reset(demand)
    fontResolver.exhaust(demand)
    fontManager.markLoaded(family, 'Regular', new ArrayBuffer(12))

    const graph = new SceneGraph()
    const node = graph.createNode('TEXT', pageId(graph), {
      name: 'Synthetic italic',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      text: 'Hello',
      fontFamily: family,
      italic: true
    })

    expect(nodeFontReadiness({}, node)).toBe('ready')
    fontResolver.reset(demand)
  })
})
