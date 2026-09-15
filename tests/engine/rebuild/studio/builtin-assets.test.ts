/**
 * T44（S4 W1 / T-A2）内置 studio 资产集钉扎测试——真目录加载。
 *
 * 把「内置资产过 T43 校验面」钉成永久门禁：W3 内容填充（T-C2/C3）或后续
 * 资产改动写坏文件即红。用户目录以 tmp 空目录隔离，只测内置集。
 *
 * T46（S4 W1 / T-A5）：base.md 已落位——failures 断言按预约收为零，并加
 * base 注册钉扎（免 label schema：frontmatter 仅 `id: base` 即注册成功）。
 *
 * T49（2026-08-31，owner 指令）：base.md 已回归纯转写（frontmatter + 双源头注 +
 * 119 行逐字转写，不承载显式纪律段），原纪律段内容钉扎断言随之撤除。
 *
 * P1-6（2026-09-08）：base 拆分——general.md 落位为第四个 workflow，装配无特判；
 * modes[0].source 仍标 'general' 保历史语义。
 *
 * 2026-09-15（owner 裁决）：prompt 资产多轮迭代期——形状钉扎（stepBudget 值 /
 * sizes 预设 / references 清单与数量 / body 内容子串 / profile modes / modes
 * 全序投影）全部撤除，只留最小承重断言：failures 零（写坏文件/缺 reference 即红）
 * + base 注册 + general 首位 + source 标记。资产内容迭代不再需要同批改测试。
 */

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadStudioFromDirs } from '@/app/ai/pi-backend/studio'

const BUILTIN_DIR = join(import.meta.dir, '../../../../src/app/ai/pi-backend/studio')

test('内置资产集过校验面：failures 零、base 注册、general 首位 + source 标记', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'studio-user-empty-'))
  try {
    const r = loadStudioFromDirs(BUILTIN_DIR, userDir)

    // T46 收零：base.md 落位后内置集零失败成永久门禁——frontmatter 病态、
    // references 声明文件缺失、id 与目录名不符等资产写坏即红（loader 校验面兜底）
    expect(r.failures).toEqual([])

    // base 唯一槽位注册（D-e 免 label schema：内置 base.md 无 label 字段）
    if (!r.base) throw new Error('base 未注册')
    expect(r.base.id).toBe('base')
    expect(r.base.origin).toBe('builtin')

    // modes 投影：general 恒首位（general 保留态语义），其 source 标 'general'；
    // 其余 workflow 派生 mode 的 source 标 'workflow'——形状钉扎按 2026-09-15
    // owner 裁决撤除，只保此承重结构
    if (r.modes.length === 0) throw new Error('modes 投影为空')
    expect(r.modes[0].id).toBe('general')
    expect(r.modes[0].source).toBe('general')
    for (const m of r.modes.slice(1)) {
      expect(m.source).toBe('workflow')
    }
  } finally {
    rmSync(userDir, { recursive: true, force: true })
  }
})
