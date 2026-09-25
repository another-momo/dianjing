/**
 * T35：27 条 pi 段 i18n key 从 packages/vue/src/i18n/locales/zh-cn/dialogs.json
 * 迁回本 fork seam——绕开上游 dialogs.json 重构反复撞我们自有内容的死循环。
 *
 * 上游 dialogs.json 仅承载 T20/T22 引入前的全局 i18n 文案；pi 后端专属文案
 * 是 fork zone（ownedRoot `src/app/i18n/fork/`），不属于上游合并面。
 *
 * 历史教训：
 * - T31 合并第二轮：上游 messages+zh-cn 覆盖冲掉 26 个 pi* key，按 HEAD 定义
 *   合并回写（commit c0c1f117 实录）
 * - T34 合并第三轮：dialogs.json 冲突类 8 个里 1 个（zh-cn）保留 HEAD pi 段
 * - T35：根治——把 pi 段迁回 fork seam，dialogs.json 还原到上游 88c10770 截止状态
 */
import type { ComponentsJSON } from '@nanostores/i18n'

import type {
  agentCapabilitiesMessageDefaults,
  askMessageDefaults,
  chipsMessageDefaults,
  confirmMessageDefaults,
  fontsMessageDefaults,
  imageGenMessageDefaults,
  panelsMessageDefaults,
  piMessageDefaults,
  toolbarMessageDefaults
} from './en'

const zhCN = {
  rebuild: {
    seamProbe: 'fork i18n 缝已接通'
  },
  chips: {
    chipsMode: '模式',
    chipsProfile: '风格',
    chipsNoProfile: '无风格档案',
    chipsPendingTip: '将以 {mode} · {profile} 新建设计，发送时确认',
    chipsManifestFailed: '设计模式与风格加载失败——选择器已禁用。',
    chipsRetry: '重试',
    chipsCaptureSelection: '引用画布选区',
    chipsCaptureEmpty: '画布上还没有选中节点',
    // T89：skill dropdown trigger + 搜索占位 + 空匹配提示
    chipsSkillChoose: '选择技能',
    chipsSkillSearchPlaceholder: '搜索技能…',
    chipsSkillEmpty: '没有匹配的技能'
  },
  // T87→T89→T96：settings 面板 Agent 能力分区文案。
  // T96：三档位重构——章节标题/描述 + 文件访问三档 + 技能系统开关标签/描述。
  agentCapabilities: {
    agentCapabilitiesTitle: 'Agent 能力',
    agentCapabilitiesDescription: '配置文件访问和技能系统',
    builtinToolsLabel: '文件访问',
    builtinToolsOff: '关闭 - 不访问文件',
    builtinToolsReadonly: '只读 - 查看文件但不修改',
    builtinToolsFull: '完整 - 读写文件和执行命令',
    agentSkillsLabel: '技能系统',
    agentSkillsDescription: '启用 AI 使用专业技能',
    agentCapabilitiesSaving: '保存中…',
    agentCapabilitiesError: '保存失败：{message}',
    customExtensionsTitle: '自定义拓展',
    customExtensionsDescription:
      '自定义 agent mode workflow / style profile / agent skill 的存放目录——照着 `_example` 改名改写即可，完整说明见文件夹内 README。',
    customExtensionsFolderLabel: '自定义拓展目录',
    customExtensionsOpen: '打开文件夹',
    customExtensionsOpened: '已打开',
    customExtensionsCopied: '已复制',
    customExtensionsCopyFailed: '复制失败'
  },
  panels: {
    contextTriggerLabel: '画布状态',
    contextTriggerDesignLabel: '正在设计：',
    contextTriggerDesignEmpty: '待新建',
    contextTriggerBriefsLabel: '需求单：',
    contextTriggerBriefsEmpty: '无',
    designsSection: '设计区',
    designsEmpty: '当前页还没有设计区——选好模式 / 风格后发送消息即可新建。',
    designsNoActive: '还没有正在设计的设计区。',
    designsActive: '正在设计',
    designsSetCurrent: '切换到此',
    designsSetting: '切换中…',
    designsSwitchFailed: '设为当前失败。',
    briefsSection: '本页需求单',
    briefListEmpty: '当前页还没有需求单。',
    briefContainsActive: '含正在设计',
    briefNew: '新建需求单',
    briefNewPlaceholder: '需求内容（可选）…',
    briefCreate: '创建',
    briefCreateCancel: '取消',
    briefCreateFailed: '新建需求单失败。',
    briefDirtyHint: '有未保存的需求单修改。',
    briefDiscardClose: '丢弃并关闭',
    briefKeepEditing: '继续编辑',
    briefDialogTitle: '需求单',
    briefDialogDescription: '内容与素材的修改写回画布上的需求单——画布是单一事实源。',
    briefOpenFailed: '该需求单结构不完整，无法读取。',
    briefDialogMissing: '该需求单已不在画布上（可能已被删除）。',
    briefContent: '需求内容',
    briefContentPlaceholder:
      '要做什么、给谁看、必须出现的内容、素材怎么用——写得越完整，AI 越少猜。',
    briefMaterials: '素材区',
    briefMaterialCaptionPlaceholder: '备注用途（如：主视觉 / 仅参考风格）…',
    briefMaterialAdd: '上传图片',
    briefMaterialAddSelection: '从画布选区添加（{count}）',
    briefMaterialRemove: '删除素材',
    briefConclusions: 'AI 结论',
    briefDesigns: '关联设计区',
    briefEmptySection: '空',
    briefSaved: '已保存',
    briefSaveFailed: '保存失败',
    briefApplyFailed: '操作失败——请重试。'
  },
  confirm: {
    intentTitle: '以新身份开始新设计？',
    intentSummaryLine: '将按「{mode} / {profile}」新建设计——画布上的现有内容原样保留，不会被删除。',
    intentNoProfile: '无风格档案',
    intentDraftSection: '发送内容（可编辑）',
    intentSizeSection: '画布尺寸',
    intentSizeAuto: '自动（AI 决定）',
    intentSizeCustomPlaceholder: '自定义，如 750x 或 750x2000',
    intentSizeInvalid: '尺寸格式：宽x 或 宽x高（如 750x2000）。',
    intentConfirm: '确认并发送',
    intentCancel: '取消',
    intentConfirmedBadge: '已确认',
    intentCancelledBadge: '已取消',
    consentTitle: 'AI 请求切换当前目标设计',
    consentTarget: '目标：{name}',
    consentAgree: '切换过去',
    consentDecline: '保持当前',
    consentAgreedBadge: '已切换',
    consentDeclinedBadge: '已拒绝',
    consentDeclinedLine: '已拒绝切换到 {name}——当前目标不变。',
    consentFailedLine: '切换失败——目标设计可能已被移动或删除。',
    contextSwitchLine: '—— 已切换到「{name}」——',
    // T91b：setup_design awaiting_new_intent_confirmation 信封卡片（AI 提议，用户二元决策）
    // 批 2（2026-09-21 拍板①⑤⑥）：message 不再直渲（模型向协议指令），换用户向
    // awaitingIntentPrompt；已决归档由卡面徽标承担，系统行退役
    awaitingIntentTitle: 'AI 想新建一张设计——需要你确认',
    awaitingIntentPrompt: 'AI 将按以上参数新建设计。确认后自动重发你的上一条需求，继续创作。',
    awaitingIntentMode: '模式',
    awaitingIntentProfile: '风格',
    awaitingIntentBrief: '需求单',
    awaitingIntentCanvas: '画布尺寸',
    awaitingIntentConfirm: '确认',
    awaitingIntentCancel: '取消',
    awaitingIntentConfirmedToast: '已确认——正在重发需求继续创建',
    awaitingIntentFailedLine: '确认失败：{msg}',
    awaitingIntentExpiredBadge: '已失效',
    awaitingIntentExpiredLine: '该新建提议未作答，已失效。',
    // T93：reasoning part 折叠卡标题（PiChatMessage.vue）
    reasoningTitle: '思考过程',
    // T96：流式中 reasoning 折叠卡标题（PiChatMessage.vue）——区别于已结束的
    //「思考过程」；带呼吸点动画，纯 CSS，零 JS 定时器
    reasoningStreamingTitle: '思考中',
    // T94：用户主动停止回执（ChatPanel toast + ChatMessage 末条消息底部小字行）
    chatStopped: '已停止'
  },
  ask: {
    askFormTitle: 'AI 向你提问',
    askSubmit: '提交作答',
    askSkip: '跳过表单',
    askOptional: '选答',
    askTextPlaceholder: '输入你的回答…',
    askOtherOption: '其他',
    askOtherPlaceholder: '输入你自己的回答…',
    askAnswered: '已作答',
    askSkipped: '已跳过',
    askImageUnavailable: '预览不可用',
    askInvalidDefinition: '表单定义无效，无法作答。',
    // 波2 #9：分页作答壳
    askNext: '下一题',
    askPrev: '上一题',
    askProgress: '第 {current} 题，共 {total} 题',
    askMissingCount: '还有 {count} 题未答',
    askMissingCountPlural: '还有 {count} 题未答',
    askMultiHint: '可选多项',
    askNotesPlaceholder: '笔记（可选）',
    askGlobalNotesPlaceholder: '还有什么想让 AI 知道的？（可选）',
    askSummaryNotes: '笔记：{notes}'
  },
  imagegen: {
    imageGenTitle: '图像生成',
    imageGenProvider: '服务商类型',
    imageGenBaseUrl: 'Base URL',
    imageGenBaseUrlPlaceholder: 'https://api.openai.com/v1',
    imageGenModel: '模型',
    imageGenModelPlaceholder: 'gpt-image-1',
    imageGenKeyPlaceholderConfigured: '密钥已保存——输入新密钥以替换',
    imageGenKeyPlaceholderMissing: '粘贴 API 密钥',
    imageGenKeySave: '保存密钥',
    imageGenKeyClear: '清除密钥',
    imageGenConfigured: '已配置',
    imageGenNotConfigured: '未配置',
    imageGenOffline: '无法连接本地 AI 服务——请重启应用；浏览器开发模式请先启动本地服务。',
    // 图片本地留存偏好——默认关闭；写盘失败静默，不污染画布 commit
    imageGenRetainLocal: '图片本地留存',
    imageGenRetainLocalHint: '生成图同时留存一份到本地目录',
    imageGenOpenFolder: '打开文件夹'
  },
  fonts: {
    settingsFonts: '字体',
    fontsPanelTitle: '字体白名单',
    fontsPanelDescription:
      '管理画布可用的字体。被停用的字体视为未安装：从字体选择器消失，文档自动回退到下一可用字体；内置字体始终启用（渲染兜底）。',
    fontsSearchPlaceholder: '搜索字体…',
    fontsLoading: '字体加载中…',
    fontsEmpty: '没有匹配的字体。',
    fontsEnabledSummary: '已启用 {enabled}/{total} 个家族',
    fontsSourceBundled: '内置',
    fontsSourceCdn: 'CDN 精选',
    fontsSourceCatalog: 'CDN 目录',
    fontsSourceLocal: '系统',
    fontsSourceOnline: '在线',
    fontsLockedHint: '内置字体始终启用——它们是渲染兜底。',
    fontsLocalAccessPrompt: '允许访问系统字体后可在此管理。',
    fontsLocalAllow: '允许访问系统字体',
    fontsVariableBadge: '可变',
    fontsFilterAll: '全部',
    fontsFilterEnabled: '已启用',
    fontsFilterDisabled: '已停用',
    fontsEnableAll: '全部启用',
    fontsDisableAll: '全部停用',
    fontsShowMore: '显示更多（还有 {count} 个）',
    fontsOnlineMaster: '在线字体库',
    fontsOnlineMasterHint:
      'Google Fonts / Fontsource / Bunny Fonts / Fontshare 四个在线库的总开关。',
    fontsOnlineOffHint: '已停用——四个在线库的家族从列表与字体选择器中隐藏。',
    fontsCnMaster: '中文网字计划 CDN',
    fontsCnMasterHint: '独立开关——不受在线字体库总开关影响。',
    fontsCnOffHint: '已停用——中文网字计划的家族从列表与字体选择器中隐藏。',
    fontsUnauditedLicense: '授权：{license}（以包内声明为准，未审计）',
    fontsCatalogHint:
      '中文网字计划全量目录。默认关闭——启用的家族出现在字体选择器中，按字符集按需加载子集分片。',
    // 统一批 A：面板扩管提供商单独开关（自 popover 迁入）
    fontsProvidersTitle: '在线提供商',
    fontsProvidersHint: '每个提供商独立开关。启用后其家族才会进入列表并按需加载。',
    fontsProviderGoogleUnavailable: 'Google Fonts 仅桌面应用可用。请下载桌面应用来使用。',
    // 统一批 A：回退包预下载（自 popover 迁入）
    fontsFallbackTitle: '后备字体包',
    fontsFallbackHint: '预下载 CJK 与阿拉伯语后备字体，使用它们的文件离线时也能渲染。',
    fontsFallbackDownload: '下载后备字体',
    fontsFallbackDownloading: '下载中…',
    fontsFallbackDownloaded: '后备字体已下载。',
    fontsFallbackDownloadFailed: '无法下载后备字体。',
    // 统一批 A：缓存管理（自 popover 迁入）
    fontsCacheTitle: '下载缓存',
    fontsCacheSummary: '{count} 个字体 · {size}',
    fontsCacheClear: '清除缓存',
    fontsCacheCleared: '已清除下载的字体缓存。',
    fontsCacheClearFailed: '无法清除下载的字体缓存。',
    // 统一批 B：本地源应用级开关
    fontsLocalMaster: '系统字体',
    fontsLocalMasterHint: '允许应用枚举并加载本机已安装的字体。关闭后将系统字体视为未安装。',
    fontsLocalOffHint: '已停用——系统字体从列表与字体选择器中隐藏；CJK 回退链也会跳过它们。'
  },
  pi: {
    providersTitle: '模型提供方',
    catalogRefresh: '刷新',
    catalogOffline: '无法连接本地 AI 服务——请重启应用；浏览器开发模式请先启动本地服务。',
    providerModels: '{count} 个模型',
    modelSearchPlaceholder: '搜索模型…',
    modelSearchEmpty: '没有匹配的模型。',
    modelSupportsImage: '图像输入',
    providerSearchPlaceholder: '搜索 Provider…',
    keyPlaceholderConfigured: '密钥已保存——输入新密钥以替换',
    keyPlaceholderMissing: '粘贴 API 密钥',
    keySave: '保存密钥',
    keyClear: '清除密钥',
    addProvider: '添加自定义 Provider',
    providerId: 'Provider ID',
    providerBaseUrl: 'Base URL',
    providerApi: 'API 类型',
    providerModelIds: '模型 ID（每行一个）',
    providerSave: '保存 Provider',
    designModel: '设计模型',
    designModelDescription: 'AI 聊天代理使用的模型。凭据来自上方对应的 Provider 条目。',
    designProvider: 'Provider',
    designModelSave: '保存',
    designModelDirty: '未保存',
    designModelSaved: '已保存',
    designPickerEmpty: '没有匹配项。',
    // T97：合并面板摘要条文案
    currentAssignmentLabel: '当前设计模型',
    currentAssignmentCurrent: '当前',
    thinkingLevel: '思考级别',
    thinkingOff: '默认',
    thinkingMinimal: '最低',
    thinkingLow: '低',
    thinkingMedium: '中',
    thinkingHigh: '高',
    thinkingExtraHigh: '极高',
    // T100：A 组发现性——provider 列表搜索框 + 已配置/全部分组小标题
    providerGroupConfigured: '已配置',
    providerGroupAll: '全部 Provider',
    providerSearchEmpty: '没有匹配的 Provider。',
    // T100：B1 验证闭环——行内验证按钮 + 三态结果文案
    providerVerify: '验证',
    providerVerifyOk: '验证通过',
    providerVerifyFailed: '验证失败',
    providerVerifyUnknownError: '验证失败（后端未返回详情）。',
    // T100：B2 错误下沉——行内错误位（保存/删除/编辑/验证各动作的错误共用同位）
    providerRowError: '操作失败',
    // T100：C1 删除——行内删除按钮 + 行内二次确认两态
    providerDelete: '删除',
    providerDeleteConfirm: '确认删除？',
    providerDeleteCancel: '取消',
    providerDeleteConfirmHint: '将从本地目录移除该自定义 Provider 及其模型。',
    // T100：C2 编辑——行内编辑按钮 + 编辑态表单标题/提交文案
    providerEdit: '编辑',
    providerFormTitleAdd: '添加自定义 Provider',
    providerFormTitleEdit: '编辑自定义 Provider',
    providerFormIdReadonlyHint: 'Provider ID 不可修改。',
    providerFormSaveEdit: '保存修改',
    // T100：D1 source 回显（SDK 真实 source 值经 classifyAuthSource 归类）
    providerAuthSourceEnvironment: '环境变量',
    // T100：D1 补钉——env shadow 提示（stored 赢时把被忽略的 env 显式化）
    providerAuthEnvShadowed: '环境变量 {names} 已忽略——设置中存储的 key 优先',
    // T100：引导门——needs-setup / needs-credential 两变体 + 加载骨架条 + 卡脚 hint；
    // 带 {name} 占位的键对应 en 侧 params function（providerModels 先例）；
    // Translations 扁平禁嵌套——键名带 providerGate 前缀分组
    providerGateSetupTitle: '设置设计模型',
    providerGateSetupDescription: '打开 AI 设置选择 provider 与模型，即可开始对话。',
    providerGateSetupCta: '打开设置',
    providerGateCredentialTitle: '{name} 还没配置 key',
    providerGateCredentialDescription: '模型已选，但还需要为该 provider 配置 API key。',
    providerGateCredentialCta: '打开 {name} 设置',
    providerGateLoading: '正在加载模型目录…',
    providerGateHint: '模型在「设置 → AI」中管理',
    // ux-polish④：设计模型卡（合并面板顶部）—— 四字段：provider / model / thinking / key
    designCardTitle: '设计模型',
    designCardProvider: '提供方',
    designCardModel: '模型',
    designCardThinking: '思考强度',
    designCardApiKey: 'API 密钥',
    designCardKeyStatusConfigured: '已配置密钥',
    designCardKeyStatusMissing: '尚未配置密钥',
    designCardProviderSearchPlaceholder: '搜索 Provider…',
    designCardProviderEmpty: '没有匹配的 Provider。',
    designCardAdvancedTrigger: '高级：Provider 列表与自定义 Provider'
  },
  toolbar: {
    addImage: '添加图片',
    addImageFailed: '无法添加所选图片——支持 PNG / JPEG / WebP / GIF / BMP / SVG。',
    addImageFailedEmpty: '无法添加图片——文件是空的（0 字节）。',
    addImageFailedUnsupported: '不支持的图片格式——支持 PNG / JPEG / WebP / GIF / BMP / SVG。',
    addImageFailedCorrupt: '无法添加图片——文件损坏或无法解码。',
    addImageFailedEngineNotReady: '图像引擎尚未就绪，请稍后重试。'
  }
} satisfies ComponentsJSON

export default zhCN

// T35：PiNamespace 类型基于 en defaults（含 params），与 zh-cn.ts 的 string 字面量解耦——
// 参数化 key（如 providerModels）在 useForkPi() 消费端保留 callable 形态。
export type PiNamespace = typeof piMessageDefaults
export type FontsNamespace = typeof fontsMessageDefaults
export type ImageGenNamespace = typeof imageGenMessageDefaults
export type AskNamespace = typeof askMessageDefaults
export type ChipsNamespace = typeof chipsMessageDefaults
export type PanelsNamespace = typeof panelsMessageDefaults
export type ConfirmNamespace = typeof confirmMessageDefaults
export type AgentCapabilitiesNamespace = typeof agentCapabilitiesMessageDefaults
export type ToolbarNamespace = typeof toolbarMessageDefaults
