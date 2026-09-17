import { describe, expect, test } from 'bun:test'

import { analyze, EXCLUDE, type Schema } from '../src/check'

// 极小 schema 夹具——便于测试聚焦三清单双向校验逻辑。
// 元素含一个 EXCLUDE 项（Component），验证 EXCLUDE 生效。
const fixtureSchema: Schema = {
  elements: [
    { name: 'Frame' },
    { name: 'Icon' },
    { name: 'View' }, // alias 类——也走 schema→md 校验
    { name: 'Component' } // EXCLUDE 项
  ],
  helpers: [
    { name: 'solid' },
    { name: 'gradient' },
    { name: 'designVar' } // EXCLUDE 项
  ],
  properties: ['w', 'h', 'flex', 'bind'] // bind 是 EXCLUDE 项
}

const happyPathMd = `# render JSX

## Elements

Content: \`Frame\`, \`Icon\`. Aliases: \`View\` = Frame.

Component system — \`Component\` exists in the renderer but is **not taught yet** (pending verification); do not author them.

Paint/effect helpers usable inside JSX: \`solid\`, \`gradient\`.

## Props reference

w={N}, h={N}, flex="row".
`

const schemaExtraMd = `# render JSX

## Elements

Content: \`Frame\`, \`Icon\`.

Paint/effect helpers usable inside JSX: \`solid\`, \`gradient\`.

## Props reference

w={N}, h={N}, flex="row".
`

const mdExtraMd = `# render JSX

## Elements

Content: \`Frame\`, \`Icon\`, \`Doomsday\`.

Paint/effect helpers usable inside JSX: \`solid\`, \`gradient\`, \`bananaPeel\`.

## Props reference

w={N}, h={N}, flex="row".
`

describe('design-jsx-doc check', () => {
  test('happy path: schema and md in sync', () => {
    const drifts = analyze(fixtureSchema, happyPathMd)
    expect(drifts).toEqual([])
  })

  test('schema→md drift: schema property missing in md is reported', () => {
    // fixtureSchema has 'bind' (EXCLUDE) and 'w/h/flex'. If md omits w/h/flex,
    // all three should be reported. Use schema with an extra property to confirm.
    const schema: Schema = {
      elements: [{ name: 'Frame' }, { name: 'Icon' }],
      helpers: [{ name: 'solid' }],
      // 'mystery' is in schema but not in md — drift expected.
      properties: ['w', 'h', 'flex', 'mystery']
    }
    const md = `# render JSX

## Elements

Content: \`Frame\`, \`Icon\`.

Paint/effect helpers usable inside JSX: \`solid\`.

## Props reference

w={N}, h={N}, flex="row".
`
    const drifts = analyze(schema, md)
    expect(drifts).toContainEqual({
      kind: 'property',
      name: 'mystery',
      direction: 'schema->md'
    })
  })

  test('md→schema drift: md token not in schema is reported', () => {
    // happyPathMd minus w/h/flex, plus `mystery` element & `bananaPeel` helper — drift.
    const md = `# render JSX

## Elements

Content: \`Frame\`, \`Icon\`, \`Mystery\`.

Paint/effect helpers usable inside JSX: \`solid\`, \`gradient\`, \`bananaPeel\`.

## Props reference

`
    const drifts = analyze(fixtureSchema, md)
    expect(drifts).toContainEqual({
      kind: 'element',
      name: 'Mystery',
      direction: 'md->schema'
    })
    expect(drifts).toContainEqual({
      kind: 'helper',
      name: 'bananaPeel',
      direction: 'md->schema'
    })
  })

  test('EXCLUDE items do not cause false positives in either direction', () => {
    // Schema includes `Component` element, `designVar` helper, `bind` property.
    // Md lists all of them in their respective enumeration lines + mentions
    // them in policy text. EXCLUDE must mask every direction.
    const md = `# render JSX

## Elements

Content: \`Frame\`, \`Icon\`. Aliases: \`View\` = Frame.

Component system — \`Component\`, \`ComponentSet\`, \`Instance\` exist in the renderer but are **not taught yet**; do not author them.

Paint/effect helpers usable inside JSX: \`solid\`, \`gradient\`, \`designVar\`, \`defineVars\`.

## Props reference

w={N}, h={N}, flex="row", of="x", component="y", componentId="z", properties={[]}, propertyRefs={[]}, bind="q".
`
    // 1) 不应有 md→schema drift（Mystery/bananaPeel 等虚构 token 不在）
    // 2) 不应有 schema→md drift（w/h/flex 已提，EXCLUDE 项不论在哪都不计）
    const drifts = analyze(fixtureSchema, md)
    // 过滤掉一切 name 含 EXCLUDE 项的 drift → 必为空集
    const excludeHits = drifts.filter((d) => EXCLUDE.has(d.name))
    expect(excludeHits).toEqual([])
    // 全部 drift 应该为空（happy path，EXCLUDE 屏蔽全部噪音）
    expect(drifts).toEqual([])
  })

  test('EXCLUDE list covers policy items verbatim', () => {
    // 防止 EXCLUDE 表被人改窄——元素/属性/helper 三类的政策项必须逐字在内。
    expect(EXCLUDE.has('Component')).toBe(true)
    expect(EXCLUDE.has('ComponentSet')).toBe(true)
    expect(EXCLUDE.has('Instance')).toBe(true)
    expect(EXCLUDE.has('designVar')).toBe(true)
    expect(EXCLUDE.has('defineVars')).toBe(true)
    expect(EXCLUDE.has('of')).toBe(true)
    expect(EXCLUDE.has('component')).toBe(true)
    expect(EXCLUDE.has('componentId')).toBe(true)
    expect(EXCLUDE.has('properties')).toBe(true)
    expect(EXCLUDE.has('propertyRefs')).toBe(true)
    expect(EXCLUDE.has('bind')).toBe(true)
  })

  test('md with all schema names but missing section reports structured drift', () => {
    // md 缺 ## Elements 节本身 → 报告 <missing ## Elements section>
    const md = `# render JSX

## Props reference

w={N}.
`
    const drifts = analyze(fixtureSchema, md)
    expect(drifts).toContainEqual({
      kind: 'element',
      name: '<missing ## Elements section>',
      direction: 'md->schema'
    })
  })
})
