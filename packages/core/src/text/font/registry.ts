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
  }
]

const bundledAllowlist = new Set(
  FONT_REGISTRY.filter((entry) => entry.source === 'bundled').map((entry) => entry.family)
)

export function fontRegistryEntry(family: string): FontRegistryEntry | undefined {
  return FONT_REGISTRY.find((entry) => entry.family === family)
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
