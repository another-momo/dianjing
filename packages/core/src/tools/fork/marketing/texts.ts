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
  deletedMark: '（已删除）',
  /** 关联设计区投影缺省显示（设计身份三元组由 T53 写入，此前无数据可投影） */
  missingProjection: '—'
} as const

/**
 * setup_design 文案（T53）：画布命名基底 + 结构化错误的用户语言化 message
 * （zh-cn 外置）。参数化消息用函数形态，插值只发生在调用侧；文案不出现
 * 注入缝参数名（__catalog / __confirmedNewIntent 不进用户视野）。
 *
 * T91b：`unconfirmedNewIntent` 仍在 awaiting 信封 message 字段复用——非
 * 错误路径，而是 AI 提议后等待用户决策的提示文案。错误面已收六码（新设计
 * intent 改 awaiting 信封，不再有 unconfirmed_new_intent 错误）。
 */
export const SETUP_TEXTS = {
  /** general mode 根 frame 的命名基底 */
  generalDesignName: '营销设计',

  unconfirmedNewIntent:
    '新建设计需要先获得用户确认——请询问用户是否要新建一张设计，用户确认后宿主会带上新建意图再调用。',
  catalogUnavailable:
    '设计模式注册表不可用（当前环境未注入注册表快照）——仅 modeId=general 且不带 profileId 时可用。',
  briefNone: '文档里还没有需求单——请先 create_brief，再新建设计。',
  ambiguousBrief: '页面上有多份需求单且未指定 briefId——请询问用户使用哪一份，然后带 briefId 重试。',
  briefNotFound: (briefId: string) =>
    `找不到需求单「${briefId}」——请确认 briefId 是否正确，或先 create_brief。`,
  unknownMode: (modeId: string) =>
    `未知的设计模式「${modeId}」（不在注册表内）——通用长图请用 modeId=general。`,
  unknownProfile: (profileId: string) =>
    `未知的风格档案「${profileId}」（不在注册表 profileIds 内）。`,
  invalidCanvas: (canvas: string) =>
    `尺寸「${canvas}」格式非法——应为 \`宽x\`（如 750x，高度随内容生长）或 \`宽x高\`（如 750x2000，定高）。`,
  /** A3：B4 成功结果锚点行——分两型，按 mode 区分后续回合走向（专项有 workflow 推进，通用无） */
  specializedWorkspaceCreated: (label: string) =>
    `「${label}」设计工作区已落图并成为当前设计目标——后续回合按其 workflow 推进。`,
  generalWorkspaceCreated: () => '设计工作区已落图并成为当前设计目标——后续回合以它为工作区续作。'
} as const

/**
 * active_design 单槽文案（T60，S3 §9 / S1 §5）：端点合法性驳回的
 * 用户语言化 message + 宿主注入 context 的一行系统提示（zh-cn 外置）。
 */
export const ACTIVE_DESIGN_TEXTS = {
  notFound: (nodeId: string) =>
    `找不到节点「${nodeId}」——它可能已被删除；请从设计列表另选目标或新建设计。`,
  notDesignRoot: (nodeId: string) =>
    `节点「${nodeId}」不是设计区根框——只能在营销设计区之间切换当前目标。`,
  crossPage: '只能切换到当前画布页上的设计区——跨页设计暂不支持设为当前目标。',
  briefMismatch:
    '该设计区与它声明关联的需求单不一致（需求单已删除、跨页或未登记该设计区）——请从设计列表另选目标。',
  /** 槽位节点删除（或不再是设计区根框）→ 清槽后注入 context 的一行提示 */
  slotCleared:
    '当前设计目标已在画布上被删除，已自动清除设计目标——可新建设计，或在设计列表中另选目标。',
  /** brief 悬空（设计区仍在、需求单被删）→ 组装时注入的一行提示（S1 §5 显式提示，不静默降级） */
  briefMissing: '当前设计目标关联的需求单已被删除——可新建需求单绑定，或不走需求单直接聊天修改。',
  /** 落盘 mode 的 workflow 文件缺失 → 按 general 组装 + 本行提示（S1 §5 显式报错路径） */
  workflowMissing: (modeId: string) =>
    `当前设计落盘的模式「${modeId}」对应的 workflow 文件缺失——本回合按通用模式进行；装回该文件后可按原模式续作，或确认切换到通用模式。`,
  /**
   * T65（修 T60 集成缺口）：新建意图信封剥离后注入本回合 context 的确认参数行——
   * 确认参数对 AI 可见（此前旗标只真假）。缺省字段省略；全缺省 → 空串（宿主不注入）。
   * A3：B2 扩 canvas——pluginData 持久路径同样适用此函数（host 端归一调用）。
   */
  newIntentConfirmed: (fields: { modeId?: string; profileId?: string; canvas?: string }) => {
    const parts = [
      ...(fields.modeId ? [`modeId=${fields.modeId}`] : []),
      ...(fields.profileId ? [`profileId=${fields.profileId}`] : []),
      ...(fields.canvas ? [`尺寸=${fields.canvas}`] : [])
    ]
    if (parts.length === 0) return ''
    return `用户已为本次新建确认参数：${parts.join(' ')}（选择即锁定，不得覆盖）`
  },
  /**
   * A3：身份差分通知文案（B3）——agent 在装配回合变更可观测到「发生了什么」。
   * 模式变化 → 「设计模式已切换：X → Y（触发源：Z）；画布内容不受影响。」
   * profile-only 变化 → 「设计风格已切换：A → B（触发源：Z）；画布内容不受影响。」
   * Y=general 表述为「通用（无专项流程，走基础路由）」；X=空身份（首回合后从空槽到有身份）
   * 同样以「通用」表述。触发源短时记忆：用户确认新建 / 同意切换 / 新设计落图 / 外部变更。
   */
  modeSwitchedNotice: (fromMode: string, toMode: string, source: string) =>
    `[系统] 设计模式已切换：${fromMode} → ${toMode}（触发源：${source}）；画布内容不受影响。`,
  profileSwitchedNotice: (fromProfile: string, toProfile: string, source: string) =>
    `[系统] 设计风格已切换：${fromProfile} → ${toProfile}（触发源：${source}）；画布内容不受影响。`
} as const

/**
 * A3 身份差分通知（B3）——触发源短时记忆串（host 闭包即用即清）。
 */
export const IDENTITY_DIFF_SOURCES = {
  userConfirmedNew: '用户确认新建',
  userAgreedSwitch: '同意切换',
  newDesignCreated: '新设计落图',
  externalChange: '外部变更'
} as const

export type IdentityDiffSource = (typeof IDENTITY_DIFF_SOURCES)[keyof typeof IDENTITY_DIFF_SOURCES]

/** general 模式的用户可见表述（B3 通知行专用） */
export const GENERAL_MODE_DISPLAY = '通用（无专项流程，走基础路由）'
/** 空身份的上回合表述（首回合后从空槽到有身份） */
export const EMPTY_IDENTITY_DISPLAY = '通用'
