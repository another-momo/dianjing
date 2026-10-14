/**
 * Phase 3 SP-c 探针：canvaskit-wasm 0.41.1 断行禁则（CJK 避头尾）能力实证。
 *
 * 问题（S4 §2 SP-c，13/14 册提醒）：SkParagraph 的 ICU 断行器是否自动执行
 * 中文排版避头尾规则——行首禁则字符（。，！？；：」』】》等）不出现在行首、
 * 行尾禁则字符（「『【（《等）不出现在行尾？
 * 若成立 → 避头尾自动排印，长图 workflow 可承诺专业中文排版；
 * 若不成立 → 退化为 prompt 软约束（让 AI 写文案规避），价值减半。
 *
 * 方法：
 * 1. 注册本地内置子集字体（packages/core/assets/NotoSansSC-VF.ttf，
 *    已核覆盖全部测试字符，无网络依赖）；
 * 2. 三个夹具 × 宽度扫描（fontSize=100，宽度 250..1050 步进 25 ≈ 2.5em~10.5em）：
 *    A 行首禁则「中中中中。中中中中中中中中」——违规 = 非首行以 。开头；
 *    B 行尾禁则「中中中中「中中中中中」中中中」——违规 = 非末行以 「 结尾；
 *    C 拉丁对照「lorem ipsum, dolor sit amet」——ICU 通用规则下逗号也不上行首（参考）；
 * 3. getLineMetrics 取每行起止索引核验首/尾字符。
 *
 * 判定：A/B 两夹具全扫描宽度 0 违规 → 避头尾自动排印成立；任何违规 → 证伪。
 *
 * 运行：bun spikes/probes/sp/c-kinsoku.mjs
 */

import { readFileSync } from 'node:fs'

import CanvasKitInit from 'canvaskit-wasm'

const FONT_PATH = 'packages/core/assets/NotoSansSC-VF.ttf'

/** 行首禁则字符（不得出现在行首） */
const NO_START = new Set([...'。，、！？；：％」』】）》—…·'])
/** 行尾禁则字符（不得出现在行尾） */
const NO_END = new Set([...'「『【（《‘“'])

const FIXTURES = [
  { id: 'A-line-start', text: '中中中中。中中中中中中中中', watch: '。' },
  { id: 'B-line-end', text: '中中中中「中中中中中」中中中', watch: '「' },
  { id: 'C-latin-control', text: 'lorem ipsum, dolor sit amet', watch: ',' }
]

const FONT_SIZE = 100
const WIDTHS = []
for (let w = 250; w <= 1050; w += 25) WIDTHS.push(w)

async function main() {
  console.log('== SP-c 探针：canvaskit-wasm 断行禁则（避头尾）==')

  const fontData = new Uint8Array(readFileSync(FONT_PATH))
  const ck = await CanvasKitInit()
  const provider = ck.TypefaceFontProvider.Make()
  provider.registerFont(fontData, 'PuHuiTi')
  console.log(`字体已注册: ${FONT_PATH} (${fontData.byteLength} bytes)`)

  function linesOf(text, width, locale) {
    const textStyle = new ck.TextStyle({
      color: ck.Color4f(0, 0, 0, 1),
      fontFamilies: ['PuHuiTi'],
      fontSize: FONT_SIZE,
      ...(locale ? { locale } : {})
    })
    const paraStyle = new ck.ParagraphStyle({ textStyle })
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(paraStyle, provider)
    builder.addText(text)
    const paragraph = builder.build()
    paragraph.layout(width)
    const metrics = paragraph.getLineMetrics()
    const lines = metrics.map((m) => ({
      start: m.startIndex,
      end: m.endIndex,
      endText: m.endExcludingWhitespaces
    }))
    paragraph.delete()
    builder.delete()
    return lines
  }

  let totalViolations = 0
  let totalAdjacency = 0
  for (const locale of [undefined, 'zh-Hans']) {
    console.log(`\n-- locale = ${locale ?? '(未设置)'} --`)
    for (const fixture of FIXTURES) {
      const violations = []
      let sawWrap = false
      let legalAdjacency = 0
      for (const width of WIDTHS) {
        const lines = linesOf(fixture.text, width, locale)
        if (lines.length > 1) sawWrap = true
        for (let i = 1; i < lines.length; i++) {
          const first = fixture.text[lines[i].start]
          if (NO_START.has(first)) {
            violations.push({ width, kind: '行首', char: first, line: i })
          }
          // 断点紧邻观测字符的合法侧 = 危险区确实被探测到（A：某行以 。结尾）
          const prevLast = fixture.text[lines[i].start - 1]
          if (prevLast === fixture.watch && !NO_START.has(fixture.watch)) legalAdjacency++
        }
        for (let i = 0; i < lines.length - 1; i++) {
          const last = fixture.text[lines[i].endText - 1]
          if (last && NO_END.has(last)) {
            violations.push({ width, kind: '行尾', char: last, line: i })
          }
          // B：某行以 「 开头 = 断点落在 「 之前的合法侧
          const nextFirst = fixture.text[lines[i].endText]
          if (nextFirst === fixture.watch && NO_END.has(fixture.watch)) legalAdjacency++
        }
      }
      totalViolations += violations.length
      totalAdjacency += legalAdjacency
      const sample = violations.slice(0, 4)
      console.log(
        `  ${fixture.id}: 扫描 ${WIDTHS.length} 宽度，发生换行=${sawWrap}，` +
          `危险区探测（合法侧相邻断点）${legalAdjacency} 处，违规 ${violations.length} 处` +
          (sample.length
            ? `，示例 ${sample.map((v) => `w${v.width}:${v.kind}"${v.char}"`).join(' ')}`
            : '')
      )
    }
  }

  // 具体呈现：A 夹具在「正好 4em」危险宽度的实际断行
  const demoWidth = FONT_SIZE * 4.5
  const demoLines = linesOf(FIXTURES[0].text, demoWidth, undefined)
  console.log(
    `\n实证切片（A 夹具 @ ${demoWidth}px = 4.5em 危险宽度）：`,
    demoLines.map((l) => `「${FIXTURES[0].text.slice(l.start, l.endText)}」`).join(' / ')
  )

  console.log(`\n判定: 总违规数 = ${totalViolations}，危险区探测 = ${totalAdjacency} 处`)
  if (totalViolations === 0 && totalAdjacency > 0) {
    console.log(
      'SP-c 成立：避头尾自动排印（ICU 断行禁则生效，且危险区确被探测），无需 prompt 软约束兜底'
    )
  } else if (totalViolations === 0) {
    console.log('SP-c 证据不足：0 违规但危险区未被探测（扫描空转），需加宽扫描范围重跑')
    process.exitCode = 1
  } else {
    console.log('SP-c 证伪：存在禁则违规 → 长图 workflow 需 prompt 软约束（价值减半路线）')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('探针失败:', e)
  process.exit(1)
})
