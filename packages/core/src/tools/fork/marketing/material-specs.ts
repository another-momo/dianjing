/**
 * 物料规格库：输出介质规格的唯一真源。规格随平台方调整，维护在本文件，
 * 不靠模型记忆——结构化边界 = 代码消费边界（安全区等平台硬约束只通过
 * setup_design 命中时的回执投递到 agent，规格库自身不带规格参数字段）。
 *
 * 消费面：
 *  - setup_design 的 canvas 参数解析（像素直给 > 库别名命中 > invalid_canvas）
 *    与缺省兜底（DEFAULT_MATERIAL_SPEC）；
 *  - 前端物料选择器（ChatMaterialSelect dropdown）直引本表展示可点选物料。
 *
 * notes 准入原则：只填平台硬约束（安全区 / 必备要素 / 拒审规则），人话
 * 一句写完；审美建议（字号 / 配色 / 构图）一律不进——审美归 workflow 与
 * profile 层。无实证条目不写 notes，空着是诚实。
 */

export interface MaterialSpec {
  /** 稳定 id（agent 引用 / 前端 chip 数据键） */
  id: string
  /** 展示名（简短，平台用途为先） */
  label: string
  /** 匹配别名（小写比较：平台名 / 俗名 / 比例俗名） */
  aliases: readonly string[]
  width: number
  /** null = 流高（HUG，高度随内容生长——长图类专属形态） */
  height: number | null
  /** 可选：平台硬约束要点（安全区 / 必备要素），人话一句；无则不写 */
  notes?: string
}

/**
 * 长图兜底条目：独立常量声明，DEFAULT_MATERIAL_SPEC 引用本对象——
 * 默认身份走显式引用，不靠 MATERIAL_SPECS 数组位置约定。
 */
const LONG_IMAGE_SPEC: MaterialSpec = {
  id: 'long-image',
  label: '长图',
  aliases: ['长图', '详情页', '详情长图', '电商详情', '长海报', 'long image'],
  width: 750,
  height: null
}

/** 内置物料规格集（平台规格随平台方调整——改这里） */
export const MATERIAL_SPECS: readonly MaterialSpec[] = [
  LONG_IMAGE_SPEC,
  {
    id: 'ig-square',
    label: '方形帖',
    aliases: ['instagram', 'ins', 'ig', '方形', '方图', '小红书方形', 'square'],
    width: 1080,
    height: 1080,
    notes: '主页 grid 按 3:4 预览——重要内容收进中央 3:4 区'
  },
  {
    id: 'ig-portrait',
    label: 'Instagram 竖版',
    aliases: ['instagram 竖版', 'ins portrait', 'ig portrait', '4:5', 'portrait'],
    width: 1080,
    height: 1350,
    notes: '主页 grid 按 3:4 预览——重要内容收进中央 3:4 区'
  },
  {
    id: 'xhs-cover',
    label: '小红书',
    aliases: ['小红书', 'xiaohongshu', 'xhs', 'red', '3:4', 'b站竖屏'],
    width: 1080,
    height: 1440,
    notes: '多图笔记首图比例决定信息流外框——首图 1:1 则整篇按方形展示'
  },
  {
    id: 'wechat-cover',
    label: '公众号封面',
    aliases: ['微信公众号', '公众号封面', '公众号', '微信封面', 'wechat', '2.35:1'],
    width: 900,
    height: 383,
    notes: '重心限中央 383×383——历史列表 / 转发卡片裁方形'
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
    aliases: ['x', 'twitter', '推特', '16:9 帖图'],
    width: 1200,
    height: 675
  },
  {
    id: 'x-header',
    label: 'X 头图',
    aliases: ['banner', '横幅', 'twitter header'],
    width: 1500,
    height: 500
  },
  {
    id: 'story-9x16',
    label: '全屏竖屏',
    aliases: ['story', 'reels', '抖音', 'tiktok', '视频号', 'shorts', '壁纸', '9:16'],
    width: 1080,
    height: 1920,
    notes: '抖音封面实显约 1080×1464（上下裁切）——主体居中留白'
  },
  {
    id: 'ecommerce-main',
    label: '电商主图',
    aliases: ['主图', '淘宝', '天猫', '京东', '拼多多', '直播封面'],
    width: 800,
    height: 800
  },
  {
    id: 'youtube-thumbnail',
    label: 'YouTube 缩略图',
    aliases: ['youtube', '缩略图', 'thumbnail'],
    width: 1280,
    height: 720
  },
  {
    id: 'link-card',
    label: '链接分享图',
    aliases: ['og', 'og-image', '链接卡', 'facebook', 'linkedin'],
    width: 1200,
    height: 630
  },
  // 规格置信度低于其他条目（两源冲突：本表取 1320×824，通行另一口径
  // 1146×717 同 ≈16:10；后续若官方推新口径或两源合流再回头调）
  {
    id: 'bilibili-cover',
    label: 'B 站封面',
    aliases: ['b站', 'bilibili'],
    width: 1320,
    height: 824
  },
  {
    id: 'a4-print',
    label: 'A4 打印稿',
    aliases: ['a4', '打印', '印刷海报'],
    width: 2480,
    height: 3508
  }
]

/** 缺省兜底条目（长图）：未传 canvas 时的落点，显式常量引用 */
export const DEFAULT_MATERIAL_SPEC: MaterialSpec = LONG_IMAGE_SPEC

/** 物料 id 清单（对外列举的单源——invalid_canvas 错误消息速览等） */
export const MATERIAL_SPEC_IDS: readonly string[] = MATERIAL_SPECS.map((spec) => spec.id)

/**
 * 别名解析：trim + 小写化后按 id / label / aliases 精确命中；未命中 → null。
 * 像素串（如 '750x'）天然不命中（无此 id/label/别名）——像素解析在调用侧先行。
 */
export function resolveMaterialAlias(input: string): MaterialSpec | null {
  const key = input.trim().toLowerCase()
  if (key === '') return null
  for (const spec of MATERIAL_SPECS) {
    if (spec.id === key) return spec
    if (spec.label.toLowerCase() === key) return spec
    if (spec.aliases.some((alias) => alias.toLowerCase() === key)) return spec
  }
  return null
}
