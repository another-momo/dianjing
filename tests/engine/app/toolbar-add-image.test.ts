import { describe, expect, test } from 'bun:test'

import { resolveAddImageFeedback } from '@/app/editor/clipboard/image-feedback'

// 2026-09-19 件 2/4：添加图片失败 toast 分文案判定——全败 error 取首条
// 原因、部分成功降级 warning、零失败不提示
describe('resolveAddImageFeedback', () => {
  test('stays silent when nothing failed', () => {
    expect(resolveAddImageFeedback({ placed: 1, failures: [] })).toBeNull()
    expect(resolveAddImageFeedback({ placed: 0, failures: [] })).toBeNull()
  })

  test('maps each failure reason to its copy key', () => {
    const cases = [
      ['empty', 'addImageFailedEmpty'],
      ['unsupported', 'addImageFailedUnsupported'],
      ['corrupted', 'addImageFailedCorrupt'],
      ['engine-not-ready', 'addImageFailedEngineNotReady']
    ] as const
    for (const [reason, key] of cases) {
      expect(resolveAddImageFeedback({ placed: 0, failures: [{ name: 'a.png', reason }] })).toEqual(
        { variant: 'error', key }
      )
    }
  })

  test('uses the first failure reason when several files failed', () => {
    expect(
      resolveAddImageFeedback({
        placed: 0,
        failures: [
          { name: 'a.txt', reason: 'unsupported' },
          { name: 'b.png', reason: 'corrupted' }
        ]
      })
    ).toEqual({ variant: 'error', key: 'addImageFailedUnsupported' })
  })

  test('downgrades to warning on partial success', () => {
    expect(
      resolveAddImageFeedback({
        placed: 2,
        failures: [{ name: 'a.txt', reason: 'unsupported' }]
      })
    ).toEqual({ variant: 'warning', key: 'addImageFailedUnsupported' })
  })
})
