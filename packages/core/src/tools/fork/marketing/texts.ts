/**
 * 画布文案外置（T52，S3 §9 i18n 行：画布对象/工具文案外置，zh-cn 为内容语言——
 * 外置≠英文化）。brief 三件套写到画布上的全部中文展示文案集中在这里；
 * 结构性节点名（寻址用，如 '需求内容' / 'MaterialGrid' / '图片位'）不属于展示文案，
 * 留在 brief.ts 作为常量。
 */
export const BRIEF_TEXTS = {
  /** brief 根 frame 显示名 */
  briefName: '需求单',
  subtitle: '填好后对 AI 说：按需求单做一张朋友圈广告',

  contentZoneName: '内容区',
  contentZoneBadge: '支持长文本 · 双击替换示例',
  contentExample:
    '例如：「XX奶茶」夏季新品买一送一，主推芒果冰沙，单价 9.9 元，活动时间 6 月 1 日 — 6 月 7 日。文案方向：年轻、清爽、突出「夏日解暑」的感觉。',
  fieldsHint: '把需求写在这里：要做什么、给谁看、必须出现的内容、素材怎么用——写得越完整，AI 越少猜',

  materialsZoneName: '素材区',
  materialsZoneBadge: '在需求单面板中添加',
  materialsEmptyHint: '暂无素材 · 在需求单面板中添加',
  materialNote: '每张图可备注用途（主视觉 / 卡片配图 / 仅参考风格）',

  conclusionsZoneName: 'AI结论区',
  conclusionsHint: 'AI 确认的结论会记在这里，不用管',
  conclusionsEmptyStatus: '（尚无结论）',

  designsZoneName: '关联设计区',
  designsZoneBadge: '新建设计后自动登记',
  designsEmptyHint: '暂无关联设计 · 新建设计后自动登记',

  /** tombstone 标注：关联设计已删除时追加在条目名后（保痕，不物理清除） */
  deletedMark: '（已删除）'
} as const

/**
 * setup_design 文案（T53）：画布命名基底 + 结构化错误的用户语言化 message
 * （zh-cn 外置）。参数化消息用函数形态，插值只发生在调用侧。
 *
 * 2026-09-27 帧无身份：mode/profile 校验文案（unknown_mode / unknown_profile /
 * catalog_unavailable）与新建意图确认门文案（unconfirmed_new_intent）随机制
 * 退役整体删除；成功锚点行收为单型（工作流推进事实由装配注入的 system prompt
 * 承担，结果行不再按 mode 分型）。
 */
export const SETUP_TEXTS = {
  /** 设计根 frame 的命名基底（帧无身份后无 mode 子域，全 mode 同名去重域） */
  designRootName: '营销设计',
  briefNone: '文档里还没有需求单——请先 create_brief，再新建设计。',
  ambiguousBrief: '页面上有多份需求单且未指定 briefId——请询问用户使用哪一份，然后带 briefId 重试。',
  briefNotFound: (briefId: string) =>
    `找不到需求单「${briefId}」——请确认 briefId 是否正确，或先 create_brief。`,
  invalidCanvas: (canvas: string, presetIds: string) =>
    `尺寸「${canvas}」无法识别——应为 \`宽x\`（如 750x，高度随内容生长）或 \`宽x高\`（如 750x2000，定高），或平台尺寸库别名。Presets: ${presetIds}`,
  /** 成功结果锚点行——工作区已落图的事实行 */
  workspaceCreated: () => '设计工作区已落图——后续回合继续在施工页上按当前模式推进。'
} as const

/**
 * 装配注入文案（zh-cn 外置）：modeId 命中但 workflow 文件缺失 → 按 general
 * 组装 + 本行提示（显式报错路径，不静默降级）。
 */
export const ACTIVE_DESIGN_TEXTS = {
  workflowMissing: (modeId: string) =>
    `当前文档确认的模式「${modeId}」对应的 workflow 文件缺失——本回合按通用模式进行；装回该文件后可按原模式续作，或确认切换到通用模式。`
} as const
