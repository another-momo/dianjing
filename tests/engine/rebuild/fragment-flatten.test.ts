import { describe, expect, it } from 'bun:test'

import { renderJSX } from '@open-pencil/core'

import { childIdAt, expectDefined, getNodeOrThrow } from '#tests/helpers/assert'
import { makeSceneGraph } from '#tests/helpers/scene'

describe('nested fragment flattening', () => {
  it('flattens a single-level fragment into its parent Frame', async () => {
    const g = makeSceneGraph()
    const [result] = await renderJSX(
      g,
      `<Frame name="Card" flex="col">
        <>
          <Text name="First" text="one" color="#000" />
          <Text name="Second" text="two" color="#000" />
        </>
      </Frame>`
    )
    const frame = getNodeOrThrow(g, result.id)
    expect(frame.childIds.length).toBe(2)
    expect(getNodeOrThrow(g, childIdAt(frame, 0)).name).toBe('First')
    expect(getNodeOrThrow(g, childIdAt(frame, 1)).name).toBe('Second')
  })

  it('flattens fragments nested inside fragments', async () => {
    const g = makeSceneGraph()
    const [result] = await renderJSX(
      g,
      `<Frame name="Deep">
        <>
          <>
            <Text name="Inner" text="deep" color="#000" />
          </>
        </>
      </Frame>`
    )
    const frame = getNodeOrThrow(g, result.id)
    expect(frame.childIds.length).toBe(1)
    expect(getNodeOrThrow(g, childIdAt(frame, 0)).name).toBe('Inner')
  })

  it('skips null and false children inside fragments', async () => {
    const g = makeSceneGraph()
    const [result] = await renderJSX(
      g,
      `<Frame name="Conditional">
        <>
          {null}
          {false}
          <Text name="Only" text="here" color="#000" />
        </>
      </Frame>`
    )
    const frame = getNodeOrThrow(g, result.id)
    expect(frame.childIds.length).toBe(1)
    expect(getNodeOrThrow(g, childIdAt(frame, 0)).name).toBe('Only')
  })

  it('merges text children of fragments in order', async () => {
    const g = makeSceneGraph()
    const [result] = await renderJSX(
      g,
      `<Text name="Label" size={14} color="#000"><>Hello, </>World</Text>`
    )
    const node = getNodeOrThrow(g, result.id)
    expect(node.text).toBe('Hello, World')
    expect(node.childIds.length).toBe(0)
  })

  it('flattens mapped arrays inside fragments', async () => {
    const g = makeSceneGraph()
    const [result] = await renderJSX(
      g,
      `<Frame name="List" flex="col">
        <>
          {[1, 2, 3].map((n) => (
            <Text name={'Item' + n} text={String(n)} color="#000" />
          ))}
        </>
      </Frame>`
    )
    const frame = getNodeOrThrow(g, result.id)
    expect(frame.childIds.length).toBe(3)
    expect(getNodeOrThrow(g, childIdAt(frame, 2)).name).toBe('Item3')
  })

  it('flattens fragments inside svg so paths render', async () => {
    const g = makeSceneGraph()
    const [result] = await renderJSX(
      g,
      `<svg viewBox="0 0 24 24" size={24}><><path d="M2 12 L22 12" stroke="#000" fill="none" /></></svg>`
    )
    const icon = getNodeOrThrow(g, result.id)
    expect(icon.childIds.length).toBe(1)
    const vec = getNodeOrThrow(g, childIdAt(icon, 0))
    expect(vec.type).toBe('VECTOR')
    const network = expectDefined(vec.vectorNetwork, 'vector network')
    expect(network.vertices.length).toBeGreaterThan(0)
  })

  it('renders an empty fragment without error', async () => {
    const g = makeSceneGraph()
    const [result] = await renderJSX(g, `<Frame name="Empty"><></></Frame>`)
    const frame = getNodeOrThrow(g, result.id)
    expect(frame.childIds.length).toBe(0)
  })

  it('keeps top-level fragment multi-root behavior unchanged', async () => {
    const g = makeSceneGraph()
    const results = await renderJSX(
      g,
      `<>
        <Frame name="RootA" w={50} h={50} />
        <Frame name="RootB" w={50} h={50} />
      </>`
    )
    expect(results.length).toBe(2)
    expect(results[0]?.name).toBe('RootA')
    expect(results[1]?.name).toBe('RootB')
  })

  it('preserves order when a fragment sits between string and node children', async () => {
    const g = makeSceneGraph()
    const [result] = await renderJSX(
      g,
      `<Frame name="Seq" flex="col">
        <Text name="Before" text="before" color="#000" />
        <>
          <Text name="Middle" text="middle" color="#000" />
        </>
        <Text name="After" text="after" color="#000" />
      </Frame>`
    )
    const frame = getNodeOrThrow(g, result.id)
    expect(frame.childIds.length).toBe(3)
    expect(getNodeOrThrow(g, childIdAt(frame, 0)).name).toBe('Before')
    expect(getNodeOrThrow(g, childIdAt(frame, 1)).name).toBe('Middle')
    expect(getNodeOrThrow(g, childIdAt(frame, 2)).name).toBe('After')
  })

  it('throws the teaching error for a bare empty fragment at the top level', async () => {
    const g = makeSceneGraph()
    await expect(renderJSX(g, '<></>')).rejects.toThrow('A fragment cannot be rendered directly')
  })

  it('flattens a fragment returned by a function component inside a Frame', async () => {
    const g = makeSceneGraph()
    const [result] = await renderJSX(
      g,
      `<Frame name="Host" flex="col">
        {(() => {
          const Badge = () => (
            <>
              <Text name="BadgeA" text="a" color="#000" />
              <Text name="BadgeB" text="b" color="#000" />
            </>
          )
          return <Badge />
        })()}
      </Frame>`
    )
    const frame = getNodeOrThrow(g, result.id)
    expect(frame.childIds.length).toBe(2)
    expect(getNodeOrThrow(g, childIdAt(frame, 0)).name).toBe('BadgeA')
    expect(getNodeOrThrow(g, childIdAt(frame, 1)).name).toBe('BadgeB')
  })
})
