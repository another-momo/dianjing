import { expect, test } from 'bun:test'

import { REFERENCED_NODE_CONTEXT_MARKER, stripReferencedNodeContext } from '@/app/ai/fork/context'

// 引用块剥离（fork/presentation.ts 历史消息展示卫生）：marker 后段整段摘除，
// 无 marker 原文不动
test('removes appended references from visible message text', () => {
  const modelText =
    'Visible request' +
    REFERENCED_NODE_CONTEXT_MARKER +
    `- ${JSON.stringify({ id: '1:2', type: 'FRAME', name: 'Hero' })}`

  expect(stripReferencedNodeContext(modelText)).toBe('Visible request')
  expect(stripReferencedNodeContext('No references')).toBe('No references')
})
