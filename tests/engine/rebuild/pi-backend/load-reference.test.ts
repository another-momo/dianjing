/**
 * T85（资产 references 按需读取机制，定谳 4）：load_reference 后端本地工具单测。
 * 形态参照 tests/engine/rebuild/marketing/ask-user-question.test.ts（pi 工具工厂经
 * 双参直调 execute 钉行为）。
 *
 * 验收映射（T85-plan §3.8）：允许 / 拒绝（未声明列出可读清单）/ 遍历拒绝（`..`
 * 与绝对路径运行期再拒，纵深防御）/ 50KB 截断（尾部注明）/ 读失败结构化错误 /
 * 请求侧反斜杠归一 / 回合外空集全拒。
 *
 * P2-3（2026-09-07）：read_reference → load_reference 工具名重命名；测试入口与
 * 描述同步。factory 与常量名同步迁移。
 *
 * P2-3a（2026-09-07）：references path 扩展名白名单放宽为 [.md,.txt,.json,.yaml,.csv]——
 * 工具运行侧路径拒止与工具描述同步放宽；新增合法扩展名钉扎。
 *
 * 2026-09-21 owner 拍板统一限定形寻址：测试 fixture 默认 allowed = 限定 key
 * （`base/<path>` / `workflow:<id>/<path>` / `profile:<id>/<path>`）；裸路径
 * 不再是合法寻址 key；近失检测三形态命中（陈旧裸路径 / `base/...` 误前缀 /
 * `base:base/...` 误抄 base 结巴形）。
 */

import { describe, expect, test } from 'bun:test'

import {
  createLoadReferenceTool,
  LOAD_REFERENCE_MAX_BYTES
} from '@/app/ai/pi-backend/load-reference'

const CONTENT = '# 图像决策纪律\n\n留白带只描述外观。\n'

/** 确定性文件存根：path → 内容（未命中抛 ENOENT 形态错误） */
function stubReadFile(files: Record<string, string>): (abs: string) => string {
  return (abs) => {
    if (!(abs in files)) throw new Error(`ENOENT: no such file or directory, open '${abs}'`)
    return files[abs]
  }
}

function makeTool(files: Record<string, string>, allowed?: ReadonlyMap<string, string>) {
  return createLoadReferenceTool({
    allowedPaths: () =>
      allowed ??
      new Map([['base/references/imagery.md', '/abs/editable-design/references/imagery.md']]),
    readFile: stubReadFile(files)
  })
}

describe('load_reference：允许与读取（限定形寻址）', () => {
  test('命中限定 key → 返回全文 + details 带 qualified key/bytes/truncated=false', async () => {
    const tool = makeTool({ '/abs/editable-design/references/imagery.md': CONTENT })
    const result = await tool.execute('call-1', { path: 'base/references/imagery.md' })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toBe(CONTENT)
    expect(result.details).toEqual({
      path: 'base/references/imagery.md',
      bytes: Buffer.byteLength(CONTENT, 'utf8'),
      truncated: false
    })
  })

  test('请求侧反斜杠归一命中（限定 key 含反斜杠 → 正斜杠）', async () => {
    const tool = makeTool({ '/abs/editable-design/references/imagery.md': CONTENT })
    const result = await tool.execute('call-1', { path: 'base\\references\\imagery.md' })
    const details = result.details as { path?: string }
    expect(details.path).toBe('base/references/imagery.md')
  })

  test('限定 key workflow:<id>/<path> 命中正确文件（与 base 桶同名 path 同存）', async () => {
    const allowed = new Map([
      ['base/references/imagery.md', '/abs/base/references/imagery.md'],
      ['workflow:longform/references/imagery.md', '/abs/workflow/longform/references/imagery.md']
    ])
    const tool = makeTool(
      {
        '/abs/base/references/imagery.md': CONTENT,
        '/abs/workflow/longform/references/imagery.md': '# workflow-only\n'
      },
      allowed
    )
    const result = await tool.execute('call-1', {
      path: 'workflow:longform/references/imagery.md'
    })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toBe('# workflow-only\n')
    expect((result.details as { path?: string }).path).toBe(
      'workflow:longform/references/imagery.md'
    )
  })

  test('限定 key base 桶特判：`base/<path>` 是正确前缀（不是 `base:base/<path>`）', async () => {
    const allowed = new Map([
      ['base/references/imagery.md', '/abs/base/references/imagery.md'],
      ['base:base/references/imagery.md', '/abs/base/references/imagery.md']
    ])
    const tool = makeTool({ '/abs/base/references/imagery.md': CONTENT }, allowed)
    // base 特判前缀 `base` 命中
    const r1 = await tool.execute('call-1', { path: 'base/references/imagery.md' })
    expect((r1.details as { error?: string }).error).toBeUndefined()
    // `base:base/...` 结巴形（限定 key 形态）仍登记为合法 key（types.ts 单源）
    const r2 = await tool.execute('call-2', { path: 'base:base/references/imagery.md' })
    expect((r2.details as { error?: string }).error).toBeUndefined()
  })
})

describe('load_reference：拒绝面', () => {
  test('陈旧裸路径（非合法 key）→ reference_not_allowed + 近失检测点名正确 key', async () => {
    const tool = makeTool({}, new Map([['base/references/imagery.md', '/abs/x.md']]))
    const result = await tool.execute('call-1', { path: 'references/imagery.md' })
    const details = result.details as { error?: string; message?: string; available?: string[] }
    expect(details.error).toBe('reference_not_allowed')
    expect(details.available).toEqual(['base/references/imagery.md'])
    // 近失检测：剥首段命中唯一候选
    expect(details.message).toContain('你是不是要读「base/references/imagery.md」')
  })

  test('未声明限定 key → reference_not_allowed + 列出本回合可读清单', async () => {
    const tool = makeTool({}, new Map([['base/references/imagery.md', '/abs/x.md']]))
    const result = await tool.execute('call-1', { path: 'workflow:longform/references/x.md' })
    const details = result.details as { error?: string; available?: string[] }
    expect(details.error).toBe('reference_not_allowed')
    expect(details.available).toEqual(['base/references/imagery.md'])
  })

  test('回合外空集（宿主 finalizeTurn 复位后）→ 全拒 + available 空 + 近失检测无候选', async () => {
    const tool = makeTool({}, new Map())
    const result = await tool.execute('call-1', { path: 'base/references/imagery.md' })
    const details = result.details as { error?: string; available?: string[] }
    expect(details.error).toBe('reference_not_allowed')
    expect(details.available).toEqual([])
  })

  test('`..` 上跳与绝对路径运行期再拒（reference_path_rejected，不查文件）', async () => {
    let reads = 0
    const tool = createLoadReferenceTool({
      allowedPaths: () => new Map([['base/references/imagery.md', '/abs/x.md']]),
      readFile: () => {
        reads++
        return CONTENT
      }
    })
    for (const path of [
      '../secret.md',
      'base/references/../../secret.md',
      '/etc/passwd',
      'C:\\key.env'
    ]) {
      const result = await tool.execute('call-1', { path })
      const details = result.details as { error?: string; available?: string[] }
      expect(details.error).toBe('reference_path_rejected')
      expect(details.available).toEqual(['base/references/imagery.md'])
    }
    expect(reads).toBe(0)
  })

  // P2-3a：非白名单扩展名（.html）运行期再拒
  test('P2-3a：非白名单扩展名（.html）→ reference_path_rejected', async () => {
    const tool = makeTool({}, new Map([['base/references/imagery.html', '/abs/x.html']]))
    const result = await tool.execute('call-1', { path: 'base/references/imagery.html' })
    const details = result.details as { error?: string; message?: string }
    expect(details.error).toBe('reference_path_rejected')
    expect(details.message).toContain('扩展名')
  })

  test('空 path → reference_path_rejected', async () => {
    const tool = makeTool({})
    const result = await tool.execute('call-1', { path: '  ' })
    expect((result.details as { error?: string }).error).toBe('reference_path_rejected')
  })

  test('加载后文件被移走 → reference_read_failed 结构化错误', async () => {
    const tool = makeTool({}) // 存根无此文件 → 抛 ENOENT
    const result = await tool.execute('call-1', { path: 'base/references/imagery.md' })
    const details = result.details as { error?: string; message?: string }
    expect(details.error).toBe('reference_read_failed')
    expect(details.message).toContain('ENOENT')
  })
})

describe('load_reference：50KB 截断', () => {
  test('超出上限 → 按字节截断 + 尾部注明 + details.truncated=true', async () => {
    // 构造 60KB 文本（ASCII 计字节即字符）
    const big = '密'.repeat(20 * 1024) // 3 字节/字 → 60KB
    const tool = makeTool({ '/abs/editable-design/references/imagery.md': big })
    const result = await tool.execute('call-1', { path: 'base/references/imagery.md' })
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    const details = result.details as { bytes?: number; truncated?: boolean }
    expect(details.truncated).toBe(true)
    expect(details.bytes).toBe(Buffer.byteLength(big, 'utf8'))
    expect(text).toContain('[已截断')
    // 截断体 ≤ 上限（尾部注记另加）
    expect(Buffer.byteLength(text.split('[已截断')[0], 'utf8')).toBeLessThanOrEqual(
      LOAD_REFERENCE_MAX_BYTES
    )
  })

  test('恰在上限内 → 不截断', async () => {
    const ok = 'a'.repeat(LOAD_REFERENCE_MAX_BYTES - 10)
    const tool = makeTool({ '/abs/editable-design/references/imagery.md': ok })
    const result = await tool.execute('call-1', { path: 'base/references/imagery.md' })
    expect((result.details as { truncated?: boolean }).truncated).toBe(false)
  })
})

// ── 2026-09-21 owner 拍板同批：近失检测三形态命中（确定性段边界匹配）──────────────

describe('load_reference：近失检测（near-miss candidates）', () => {
  /** 允许集：base + workflow 各一条独立 path（用于覆盖三类已知误拼） */
  function nearMissAllowed(): Map<string, string> {
    return new Map([
      ['base/references/render-jsx.md', '/abs/base/references/render-jsx.md'],
      [
        'workflow:longform/references/render-jsx.md',
        '/abs/workflow/longform/references/render-jsx.md'
      ]
    ])
  }

  test('形态①：陈旧裸路径 `references/render-jsx.md` → 剥首段命中两个候选', async () => {
    const tool = makeTool({}, nearMissAllowed())
    const result = await tool.execute('call-1', { path: 'references/render-jsx.md' })
    const details = result.details as { error?: string; message?: string; available?: string[] }
    expect(details.error).toBe('reference_not_allowed')
    // 多候选 → 列出（跨桶同名各条都列在索引里）
    expect(details.message).toContain('base/references/render-jsx.md')
    expect(details.message).toContain('workflow:longform/references/render-jsx.md')
    expect(details.message).toContain('同名跨桶')
  })

  test('形态①：纯文件名 `render-jsx.md` → 剥两段命中两个候选（段边界锚保证不误中 `jsx.md` 之类）', async () => {
    const tool = makeTool({}, nearMissAllowed())
    const result = await tool.execute('call-1', { path: 'render-jsx.md' })
    const details = result.details as { error?: string; message?: string }
    expect(details.error).toBe('reference_not_allowed')
    // 全部命中（两桶同名同 path），列出来给 agent 选
    expect(details.message).toContain('base/references/render-jsx.md')
    expect(details.message).toContain('workflow:longform/references/render-jsx.md')
  })

  test('形态②：`base/...` 误前缀（实际是 workflow）→ 剥首段命中 workflow 候选', async () => {
    // 只装 workflow 一条同名 path；base 不装
    const tool = makeTool(
      {},
      new Map([
        [
          'workflow:longform/references/render-jsx.md',
          '/abs/workflow/longform/references/render-jsx.md'
        ]
      ])
    )
    const result = await tool.execute('call-1', {
      path: 'base/references/render-jsx.md'
    })
    const details = result.details as { error?: string; message?: string }
    expect(details.error).toBe('reference_not_allowed')
    expect(details.message).toContain('你是不是要读「workflow:longform/references/render-jsx.md」')
  })

  test('形态③：base 桶结巴形 `base:base/references/render-jsx.md` → 全等匹配命中', async () => {
    // 允许集同时登记 `base/<path>`（特判）与 `base:base/<path>`（结巴限定形）两种合法 key
    const tool = makeTool(
      { '/abs/base/references/render-jsx.md': CONTENT },
      new Map([
        ['base/references/render-jsx.md', '/abs/base/references/render-jsx.md'],
        ['base:base/references/render-jsx.md', '/abs/base/references/render-jsx.md']
      ])
    )
    const result = await tool.execute('call-1', {
      path: 'base:base/references/render-jsx.md'
    })
    expect((result.details as { error?: string }).error).toBeUndefined()
    const text = result.content[0].type === 'text' ? result.content[0].text : ''
    expect(text).toBe(CONTENT)
  })

  test('形态③变体：base 结巴形但允许集仅 `base/<path>`（结巴形非合法）→ 近失点名 `base/<path>`', async () => {
    const tool = makeTool(
      {},
      new Map([['base/references/render-jsx.md', '/abs/base/references/render-jsx.md']])
    )
    const result = await tool.execute('call-1', {
      path: 'base:base/references/render-jsx.md'
    })
    const details = result.details as { error?: string; message?: string }
    expect(details.error).toBe('reference_not_allowed')
    // 剥首段 `base:base` → `references/render-jsx.md` → 再剥 → `render-jsx.md`
    // 命中 `base/references/render-jsx.md`（endsWith `/render-jsx.md`）
    expect(details.message).toContain('你是不是要读「base/references/render-jsx.md」')
  })

  test('段边界锚：`jsx.md` 不会误中 `render-jsx.md`（段边界 `/`）', async () => {
    const tool = makeTool({}, nearMissAllowed())
    const result = await tool.execute('call-1', { path: 'jsx.md' })
    const details = result.details as { error?: string; message?: string }
    expect(details.error).toBe('reference_not_allowed')
    // 零候选 → 维持现文案（回显 available + skill 尾句），不加近失提示
    expect(details.message).not.toContain('你是不是要读')
    expect(details.message).toContain('仅可读：')
  })

  test('完全无关路径（形态合法但零候选）→ 维持现文案', async () => {
    const tool = makeTool({}, nearMissAllowed())
    // 形态校验先于 not_allowed（无白名单扩展名在 reference_path_rejected 即拒），
    // 故「无关但形态合法」才能走到近失检测零候选分支
    const result = await tool.execute('call-1', { path: 'references/totally-unrelated.md' })
    const details = result.details as { error?: string; message?: string }
    expect(details.error).toBe('reference_not_allowed')
    expect(details.message).not.toContain('你是不是要读')
    expect(details.message).toContain('仅可读：')
  })
})
