/**
 * 平台尺寸库：尺寸知识的唯一真源。尺寸 = 输出介质规格，与 workflow
 * （生产过程）解耦——平台规格随平台方调整，维护在本文件，不靠模型记忆。
 *
 * 消费面：setup_design 的 canvas 参数解析（像素直给 > 库别名命中 >
 * invalid_canvas）与缺省兜底（DEFAULT_SIZE_PRESET）；后续前端尺寸选择
 * UI 同源消费本表。
 */

/** 平台尺寸预设条目 */
export interface SizePreset {
  /** 稳定 id（agent 引用 / 未来 UI 锚点用），如 'ig-square' */
  id: string
  /** 展示名（简短，平台名为先） */
  label: string
  /** 匹配别名（小写比较；平台名 / 俗名 / 比例俗名都收） */
  aliases: readonly string[]
  width: number
  /** null = 流高（HUG，高度随内容生长——长图类专属形态） */
  height: number | null
}

/**
 * 长图兜底条目：独立常量声明，DEFAULT_SIZE_PRESET 引用本对象——
 * 默认身份走显式引用，不靠 SIZE_PRESETS 数组位置约定。
 */
const LONG_IMAGE_PRESET: SizePreset = {
  id: 'long-image',
  label: '长图',
  aliases: ['长图', '详情页', '长海报', 'long image'],
  width: 750,
  height: null
}

/** 内置平台预设集（平台规格随平台方调整——改这里） */
export const SIZE_PRESETS: readonly SizePreset[] = [
  LONG_IMAGE_PRESET,
  {
    id: 'ig-square',
    label: 'Instagram 方形',
    aliases: ['instagram', 'ins', 'ig', '方形'],
    width: 1080,
    height: 1080
  },
  {
    id: 'ig-portrait',
    label: 'Instagram 竖版',
    aliases: ['instagram 竖版', 'ins portrait', 'ig portrait', '4:5'],
    width: 1080,
    height: 1350
  },
  {
    id: 'xhs-cover',
    label: '小红书',
    aliases: ['小红书', 'xiaohongshu', 'xhs', 'red', '3:4'],
    width: 1080,
    height: 1440
  },
  {
    id: 'wechat-cover',
    label: '公众号封面',
    aliases: ['微信公众号', '公众号封面', '公众号', 'wechat'],
    width: 900,
    height: 383
  },
  {
    id: 'slides-16x9',
    label: '演示页 16:9',
    aliases: ['ppt', '演示', '演示页', 'slides', '16:9'],
    width: 1920,
    height: 1080
  },
  {
    id: 'x-post',
    label: 'X 帖图',
    aliases: ['x', 'twitter', '推特'],
    width: 1200,
    height: 675
  },
  {
    id: 'banner-wide',
    label: '横幅 banner',
    aliases: ['banner', '横幅'],
    width: 1500,
    height: 500
  }
]

/** 缺省兜底条目（长图）：未传 canvas 时的落点，显式常量引用 */
export const DEFAULT_SIZE_PRESET: SizePreset = LONG_IMAGE_PRESET

/** 预设 id 清单（对外列举的单源——invalid_canvas 错误消息速览等） */
export const SIZE_PRESET_IDS: readonly string[] = SIZE_PRESETS.map((preset) => preset.id)

/**
 * 别名解析：trim + 小写化后按 id / label / aliases 精确命中；未命中 → null。
 * 像素串（如 '750x'）天然不命中（无此 id/label/别名）——像素解析在调用侧先行。
 */
export function resolveSizeAlias(input: string): SizePreset | null {
  const key = input.trim().toLowerCase()
  if (key === '') return null
  for (const preset of SIZE_PRESETS) {
    if (preset.id === key) return preset
    if (preset.label.toLowerCase() === key) return preset
    if (preset.aliases.some((alias) => alias.toLowerCase() === key)) return preset
  }
  return null
}
