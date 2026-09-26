/**
 * 字体注册表与白名单（T39，S2 规格 §7）。
 *
 * 白名单语义边界（15 册 D.5「结构性约束而非 prompt 约束」）：
 * - 只管「应用提供/推荐」面——bundled 字体与在线字体 provider 的枚举/加载；
 * - 用户本地系统字体（local 源）不受限——那是用户自己的资产。
 *
 * tier 分级（chinese-font-selector 内化，15 册 D.5）：
 * - T0 = 开源 OFL（铁稳，可再分发）；T1 = 厂商免费商用（厂商保留收回权利，需标注）；
 * - T2 = 慎用/禁用（不入注册表）。
 */

import { cnCatalogEntry } from '#core/text/font/cn-catalog'

export type FontLicenseTier = 'T0' | 'T1' | 'T2'

/**
 * CDN 描述符（T40 S4）：中文网字计划 @chinese-fonts/* npm 包寻址信息。
 * 字段语义与解析流程见 web-font/cn-fonts.ts 头注。
 */
export interface CnFontCdnDescriptor {
  /** npm 包名，如 '@chinese-fonts/lxgwwenkai' */
  package: string
  /** 版本，缺省 'latest' */
  version?: string
  /** 子族索引路径，缺省 'dist/index.json' */
  indexPath?: string
  /** 显式 result.css 路径（单字重包可直接指定） */
  cssPath?: string
  /**
   * CDN base 覆盖（T42）：缺省 jsdelivr。非 ASCII 子族目录名的包曾在
   * jsdelivr 全边缘 404（2026-08-30 实测），catalog 条目带过 base=unpkg
   * 回退；2026-09-06 复测 jsdelivr 已支持非 ASCII 路径（37/37 族），
   * 回退已全量移除，本字段保留给 registry 精选层/未来回退场景。
   */
  baseURL?: string
}

export interface FontRegistryEntry {
  family: string
  /** 中文显示名（2026-09-26 策展批）：family 为拼音/英文时的可读名。展示用，family 身份不变 */
  displayName?: string
  tier: FontLicenseTier
  license: string
  source: string
  /** bundled 字重样式名（与 BUNDLED_FONTS 键一致）；非 bundled 家族为空 */
  weights: string[]
  /** CDN 家族的分片子集寻址信息（source='cdn' 时必填） */
  cdn?: CnFontCdnDescriptor
  /** 可变字体家族（T41）：渲染期 wght 轴按 fontWeight 注入，weights 列静态档为空 */
  variable?: boolean
  /** 授权备注（如 T1 的厂商收回权利警示） */
  note?: string
}

export const FONT_REGISTRY: FontRegistryEntry[] = [
  {
    family: 'Inter',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'bundled',
    weights: ['Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold']
  },
  {
    family: 'Alibaba PuHuiTi',
    tier: 'T1',
    license: 'Alibaba 普惠体授权（免费商用，厂商保留收回权利）',
    source: 'bundled',
    weights: [
      'Thin',
      'Light',
      'Regular',
      'Medium',
      'SemiBold',
      'Bold',
      'ExtraBold',
      'Heavy',
      'Black'
    ],
    note: 'T1：厂商保留收回免费授权的权利，授权声明需存档（15 册 D.5 治理层）'
  },
  {
    family: 'Noto Naskh Arabic',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'bundled',
    weights: ['Regular']
  },

  // —— CDN 家族（T40 S4，中文网字计划 @chinese-fonts/* 按需子集）——
  // 包名/目录结构/font-family 均经 2026-08-30 jsdelivr 实测核验（D-a，记录见 T40-self-check）：
  // - syst（思源宋体 CN VF）T41 收录（D-b 收口）：dist/index.json 单目录 ["SourceHanSerifCN"]，
  //   result.css `font-weight:250 900` 区间形态 + font-family "Source Han Serif CN VF"，OFL-1.1；
  // - sypxzs（思源屏显臻宋）因子族目录为中文名、jsdelivr 对非 ASCII 路径 404 而剔除。
  // 2026-09-25 精选扩录：zqfs/zqzmxs/cubic 补仿宋/行书/点阵缺位（家族名采自目录构建产物，
  // 授权逐包一手核仓 OFL-1.1）；mksjh/hcqyt 同款核查由 T1 纠正为 T0。
  {
    family: 'Source Han Serif CN VF',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    variable: true,
    weights: [],
    cdn: { package: '@chinese-fonts/syst' },
    note: 'OFL-1.1 附保留字体名（RFN "Source"）：修改版再分发须改名；原样子集引用不受影响'
  },
  {
    family: 'LXGW WenKai',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    weights: ['Light', 'Regular', 'Medium'],
    cdn: { package: '@chinese-fonts/lxgwwenkai' }
  },
  {
    family: 'Xiaolai SC',
    tier: 'T0',
    license: 'OFL-1.1（思源宋体衍生）',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/xiaolai' }
  },
  {
    family: 'Yozai',
    tier: 'T0',
    license: 'OFL-1.1（思源黑体衍生）',
    source: 'cdn',
    weights: ['Light', 'Regular', 'Medium', 'Bold'],
    cdn: { package: '@chinese-fonts/yozai' }
  },
  {
    family: 'MaokenAssortedSans',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/mksjh' },
    note: '仓库 LICENSE 为 OFL-1.1（2026-09-25 一手核查，原 T1 误标纠正）'
  },
  {
    family: '寒蝉全圆体',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    weights: ['Regular', 'Bold'],
    cdn: { package: '@chinese-fonts/hcqyt' },
    note: '仓库 LICENSE 为 OFL-1.1（2026-09-25 一手核查，原 T1 误标纠正）；上游 Kosugi Maru 为 Apache-2.0 混源'
  },
  {
    family: 'Zhuque Fangsong (technical preview)',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/zqfs' },
    note: '朱雀仿宋：OFL-1.1 无保留字体名，官方明确允许再分发与嵌入'
  },
  {
    family: 'Zhi Mang Xing',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/zqzmxs' },
    note: '钟齐志莽行书：OFL-1.1 无保留字体名'
  },
  {
    family: 'Cubic 11',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/cubic' },
    note: '俐方体11号（点阵风格）'
  },

  // —— 2026-09-26 策展扩充（参考 chinese-font-selector 场景矩阵补位：标题黑/活泼标题/
  // 屏显漫黑/复古明朝/多字重创意/书法小楷/文艺楷）——
  // T0 四件一手核上游原文：得意黑 atelier-anchor/smiley-sans OFL-1.1、霞鹜漫黑
  // lxgw/LxgwMarkerGothic OFL-1.1、月星楷包内 LICENSE 原文即 OFL-1.1、余繁新语
  // chilingg/yufanxinyu MIT（作者声明仅保留署名权）；T1 三件为作者/厂商免费商用声明。
  // 晋升后原 catalog 条目已由 prune-catalog-packages 归位剔除（精选层优先，D-b）。
  {
    family: 'Smiley Sans Oblique',
    displayName: '得意黑',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/dyh', version: '3.0.0' },
    note: '上游 atelier-anchor/smiley-sans 仓 OFL-1.1（2026-09-26 一手核查）；包装层 MIT 不替换上游授权'
  },
  {
    family: 'LXGW Marker Gothic',
    displayName: '霞鹜漫黑',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/lxgwmanhei', version: '3.0.0' },
    note: '上游 lxgw/LxgwMarkerGothic README 声明 SIL OFL-1.1（2026-09-26 一手核查）'
  },
  {
    family: 'Moon Stars Kai',
    displayName: '月星楷',
    tier: 'T0',
    license: 'OFL-1.1',
    source: 'cdn',
    weights: ['Light', 'Regular', 'Bold'],
    cdn: { package: '@chinese-fonts/moon-stars-kai', version: '2.0.0' },
    note: '包内 LICENSE 原文即 SIL OFL-1.1（2026-09-26 核查；package.json 误标 MIT）；仅简中基族入精选，HW/T 变体随目录剔除退出'
  },
  {
    family: 'YuFanXinYu',
    displayName: '余繁新语',
    tier: 'T0',
    license: 'MIT',
    source: 'cdn',
    weights: ['Light', 'Regular', 'Medium', 'Bold'],
    cdn: { package: '@chinese-fonts/yfxy', version: '3.0.0' },
    note: '上游 chilingg/yufanxinyu 仓 MIT + 作者声明仅保留署名权（2026-09-26 一手核查）'
  },
  {
    family: 'Huiwen-mincho',
    displayName: '汇文明朝体',
    tier: 'T1',
    license: '作者声明免费商用（特里王，禁单独转售字库）',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/hwmct', version: '3.0.0' },
    note: '非标 OSI 授权——作者知乎声明免费商用（2026-09-26 核查授权出处）；fonts-database 曾推定 OFL，纠正为 T1'
  },
  {
    family: 'YouSheBiaoTiHei',
    displayName: '优设标题黑',
    tier: 'T1',
    license: '优设官方声明免费商用',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/ysbth', version: '3.0.0' },
    note: 'T1：厂商保留收回免费授权的权利，授权声明需存档'
  },
  {
    family: 'slideyouran',
    displayName: '演示悠然小楷',
    tier: 'T1',
    license: '演示字体官方声明免费商用',
    source: 'cdn',
    weights: ['Regular'],
    cdn: { package: '@chinese-fonts/ysyrxk', version: '3.0.0' },
    note: '目录未收（全量目录构建时未含此包）——精选层直录；family 为包内 @font-face 字面'
  }
]

const bundledAllowlist = new Set(
  FONT_REGISTRY.filter((entry) => entry.source === 'bundled').map((entry) => entry.family)
)

export function fontRegistryEntry(family: string): FontRegistryEntry | undefined {
  return FONT_REGISTRY.find((entry) => entry.family === family)
}

/**
 * 家族显示名（2026-09-26 策展批）：registry 精选 displayName 优先，catalog
 * displayName 兜底——picker 与字体白名单面板共用。family 身份不变，仅展示层。
 */
export function fontFamilyDisplayName(family: string): string | undefined {
  return fontRegistryEntry(family)?.displayName ?? cnCatalogEntry(family)?.displayName
}

/** CDN 家族注册条目（T40 S4）：命中即由 cn-font 子集解析器承担加载 */
export function cdnFontEntry(family: string): FontRegistryEntry | undefined {
  const entry = fontRegistryEntry(family)
  return entry?.cdn ? entry : undefined
}

/**
 * bundled 家族是否在白名单内。只约束 bundled 面；local/system 与 fallback
 * 专用家族不经此判定（fallback 链由 fallbacks.ts 独立管理）。
 */
export function isBundledFamilyAllowed(family: string): boolean {
  return bundledAllowlist.has(family)
}

/**
 * 在线 provider 枚举过滤：provider 家族默认放行（在线字体是通用能力，
 * 授权治理属用户选择）；本函数为后续「推荐集」收窄预留挂点。
 */
export function isProviderFamilyVisible(_family: string): boolean {
  return true
}
