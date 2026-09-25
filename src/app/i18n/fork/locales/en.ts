/**
 * T35：fork seam pi 段英文默认值。仿 src/app/i18n/notifications/index.ts 的
 * `notificationMessageDefaults` 模式——fork zone 自带 en 默认值，
 * zh-CN locale pack 在 locales/zh-cn.ts 提供中文覆盖。
 *
 * 历史教训：T21 把 pi 段硬塞进 packages/vue/src/i18n/messages/dialogs.ts
 * 是绕过了 fork seam 的反模式，导致 T31/T34 反复被上游 dialogs.json 撞。
 * T35 撤销 P38/P40，把英文 + 中文都搬到 fork zone（ownedRoot `src/app/i18n/fork/`）。
 */
import { params } from '@nanostores/i18n'

export const piMessageDefaults = {
  providersTitle: 'Model providers',
  catalogRefresh: 'Refresh',
  catalogOffline:
    'Local AI service unreachable — restart the app; in browser dev mode, start the local service first.',
  providerModels: params('{count} models'),
  modelSearchPlaceholder: 'Search models…',
  modelSearchEmpty: 'No models match your search.',
  modelSupportsImage: 'Image input',
  providerSearchPlaceholder: 'Search providers…',
  keyPlaceholderConfigured: 'Key saved — enter a new key to replace',
  keyPlaceholderMissing: 'Paste API key',
  keySave: 'Save key',
  keyClear: 'Clear key',
  addProvider: 'Add custom provider',
  providerId: 'Provider ID',
  providerBaseUrl: 'Base URL',
  providerApi: 'API type',
  providerModelIds: 'Model IDs (one per line)',
  providerSave: 'Save provider',
  designModel: 'Design model',
  designModelDescription:
    'Model used by the AI chat agent. Credentials come from the provider entry above.',
  designProvider: 'Provider',
  designModelSave: 'Save',
  designModelDirty: 'Unsaved',
  designModelSaved: 'Saved',
  designPickerEmpty: 'No matches.',
  // T97：合并面板摘要条文案（讨论稿 §4.2 段 b）
  currentAssignmentLabel: 'Current design model',
  currentAssignmentCurrent: 'Current',
  thinkingLevel: 'Thinking level',
  thinkingOff: 'Default',
  thinkingMinimal: 'Minimal',
  thinkingLow: 'Low',
  thinkingMedium: 'Medium',
  thinkingHigh: 'High',
  thinkingExtraHigh: 'Extra high',
  // T100：A 组发现性——provider 列表搜索框 + 已配置/全部分组小标题
  providerGroupConfigured: 'Configured',
  providerGroupAll: 'All providers',
  providerSearchEmpty: 'No providers match your search.',
  // T100：B1 验证闭环——行内验证按钮 + 三态结果文案（ok/失败/未知错误）
  providerVerify: 'Verify',
  providerVerifyOk: 'Verified',
  providerVerifyFailed: 'Verification failed',
  providerVerifyUnknownError: 'Verification failed (no detail from server).',
  // T100：B2 错误下沉——行内错误位（保存/删除/编辑/验证各动作的错误共用同位）
  providerRowError: 'Action failed',
  // T100：C1 删除——行内删除按钮 + 行内二次确认两态
  providerDelete: 'Delete',
  providerDeleteConfirm: 'Delete?',
  providerDeleteCancel: 'Cancel',
  providerDeleteConfirmHint:
    'This removes the custom provider and its models from your local catalog.',
  // T100：C2 编辑——行内编辑按钮 + 编辑态表单标题/提交文案
  providerEdit: 'Edit',
  providerFormTitleAdd: 'Add custom provider',
  providerFormTitleEdit: 'Edit custom provider',
  providerFormIdReadonlyHint: 'Provider ID cannot be changed.',
  providerFormSaveEdit: 'Save changes',
  // T100：D1 source 回显——stored/environment 标签文案；SDK 真实 source 值
  // （'stored credential' / 环境变量名本身）经 classifyAuthSource 归类
  providerAuthSourceEnvironment: 'Environment variable',
  // T100：D1 补钉——env shadow 提示（stored 赢时把被忽略的 env 显式化）
  providerAuthEnvShadowed: params(
    'Environment variable {names} ignored — stored key takes precedence'
  ),
  // T100：引导门（讨论稿 §3 落地清单 1）——needs-setup / needs-credential 两变体 +
  // catalog 加载中骨架条 + 卡脚 hint；function 键走 params 占位（providerModels 先例）。
  // 注：Translations 扁平（string | TranslationFunction），禁嵌套对象——键名带前缀分组
  providerGateSetupTitle: 'Set up design model',
  providerGateSetupDescription: 'Open AI settings to pick a provider and model to start chatting.',
  providerGateSetupCta: 'Open settings',
  providerGateCredentialTitle: params("{name} isn't configured yet"),
  providerGateCredentialDescription:
    'The model is picked, but this provider still needs an API key.',
  providerGateCredentialCta: params('Open {name} settings'),
  providerGateLoading: 'Loading model catalog…',
  providerGateHint: 'Manage models in Settings → AI',
  // ux-polish④：设计模型卡（合并面板顶部）—— 四字段：provider / model / thinking / key
  designCardTitle: 'Design model',
  designCardProvider: 'Provider',
  designCardModel: 'Model',
  designCardThinking: 'Thinking level',
  designCardApiKey: 'API key',
  designCardKeyStatusConfigured: 'Key saved',
  designCardKeyStatusMissing: 'No key yet',
  designCardProviderSearchPlaceholder: 'Search providers…',
  designCardProviderEmpty: 'No providers match your search.',
  designCardAdvancedTrigger: 'Advanced: provider list and custom providers'
} as const

/** T54→T66：generate_image 凭证面板（SettingsDialog ai 分区；Provider 类型下拉 + baseUrl/model/key 输入 + 测试连接）英文默认值 */
export const imageGenMessageDefaults = {
  imageGenTitle: 'Image generation',
  imageGenProvider: 'Provider type',
  imageGenBaseUrl: 'Base URL',
  imageGenBaseUrlPlaceholder: 'https://api.openai.com/v1',
  imageGenModel: 'Model',
  imageGenModelPlaceholder: 'gpt-image-1',
  imageGenKeyPlaceholderConfigured: 'Key saved — enter a new key to replace',
  imageGenKeyPlaceholderMissing: 'Paste API key',
  imageGenKeySave: 'Save key',
  imageGenKeyClear: 'Clear key',
  imageGenConfigured: 'Configured',
  imageGenNotConfigured: 'Not configured',
  imageGenOffline:
    'Local AI service unreachable — restart the app; in browser dev mode, start the local service first.',
  // 图片本地留存偏好——off by default；写盘失败静默，不污染画布 commit
  imageGenRetainLocal: 'Save images locally',
  imageGenRetainLocalHint: 'Keep a local copy of generated images',
  imageGenOpenFolder: 'Open folder'
} as const

/** T56→波2：ask_user_question 聊天内表单卡片（AskUserQuestionCard）英文默认值；
 * T95：per-question「其他」选项（askOtherOption/askOtherPlaceholder）——全局 textarea 随重设计移除，askSkipPlaceholder 退役；
 * 波2 #9：分页作答壳（progress / next/prev / multi_select 提示 / notes placeholder / 全局备注 + 摘要 notes 前缀） */
export const askMessageDefaults = {
  askFormTitle: 'The AI is asking a few questions',
  askSubmit: 'Submit answers',
  askSkip: 'Skip this form',
  askOptional: 'Optional',
  askTextPlaceholder: 'Type your answer…',
  askOtherOption: 'Other',
  askOtherPlaceholder: 'Type your own answer…',
  askAnswered: 'Answered',
  askSkipped: 'Skipped',
  askImageUnavailable: 'Preview unavailable',
  askInvalidDefinition: 'This form definition is invalid and cannot be answered.',
  // 波2 #9：分页作答壳
  askNext: 'Next',
  askPrev: 'Previous',
  askProgress: params('Question {current} of {total}'),
  askMissingCount: params('{count} question remaining'),
  askMissingCountPlural: params('{count} questions remaining'),
  // multi_select 多选提示
  askMultiHint: 'Select all that apply',
  // 笔记输入区（per-question notes）+ 全局备注（卡片底部）
  askNotesPlaceholder: 'Notes (optional)',
  askGlobalNotesPlaceholder: 'Anything else you want the AI to know? (optional)',
  // 摘要渲染 notes 前缀
  askSummaryNotes: params('Notes: {notes}')
} as const

/**
 * T61：输入条 chips（mode/profile 两级数据驱动）+ manifest 失败条 英文默认值。
 * T65：gallery 键删除（组件退役，决策 B3）。T66：chipsEmptyHint 删除——空槽引导
 * 收敛进 ChatContextBar 双段式 trigger（决策①），输入条零状态显示。
 * T70：chipsCaptureSelection / chipsCaptureEmpty——「引用画布选区」按钮 +
 * 空选区轻提示（ChatInput attachment 槽；空选区不产生 token）。
 * chipsPendingTip：pending 意向的变色 chip 锚点 Tip 全文（badge 已退役）。
 */
export const chipsMessageDefaults = {
  chipsMode: 'Mode',
  chipsProfile: 'Style',
  chipsNoProfile: 'No style profile',
  chipsPendingTip: params('Will create {mode} · {profile} as a new design — confirm on send'),
  chipsManifestFailed: 'Failed to load design modes and profiles — selectors are disabled.',
  chipsRetry: 'Retry',
  chipsCaptureSelection: 'Reference canvas selection',
  chipsCaptureEmpty: 'Nothing selected on the canvas',
  // T89：skill dropdown trigger + 搜索占位 + 空匹配提示
  chipsSkillChoose: 'Choose a skill',
  chipsSkillSearchPlaceholder: 'Search skills…',
  chipsSkillEmpty: 'No skills match'
} as const

/**
 * T87→T89→T96：settings 面板 Agent 能力分区文案。
 * T96：三档位重构（预研 §5.4）——新增章节标题/描述 + builtinTools 三档 radio
 * 键组 + agentSkills 开关标签/描述；旧单键 agentCapabilitiesSkillLabel 删除
 * （唯一消费点 AgentSettingsPanel 同批重构）。
 */
export const agentCapabilitiesMessageDefaults = {
  agentCapabilitiesTitle: 'Agent Capabilities',
  agentCapabilitiesDescription: 'Configure file access and skill system',
  builtinToolsLabel: 'File Access',
  builtinToolsOff: 'Off - No file access',
  builtinToolsReadonly: 'Read-only - View files without modification',
  builtinToolsFull: 'Full - Read, write, edit, and execute commands',
  agentSkillsLabel: 'Skill System',
  agentSkillsDescription: 'Enable AI to use specialized skills',
  agentCapabilitiesSaving: 'Saving…',
  agentCapabilitiesError: params('Failed to save: {message}'),
  // ai-panel-ux-consolidation：自定义拓展（workflow / profile / skill 资产根目录入口）
  customExtensionsTitle: 'Custom extensions',
  customExtensionsDescription:
    'Folder for custom agent mode workflows, style profiles, and agent skills — copy the built-in `_example` and edit it. See the README inside the folder for details.',
  customExtensionsFolderLabel: 'Extensions folder',
  customExtensionsOpen: 'Open folder',
  customExtensionsOpened: 'Opened',
  customExtensionsCopied: 'Copied',
  customExtensionsCopyFailed: 'Copy failed'
} as const

/**
 * T61：设计列表面板 + 需求单面板英文默认值；T65 重写：三合一为画布工作状态
 * 面板（ChatContextBar，决策 B2）——①当前目标卡 ②设计区列表 ③需求单列表。
 * 扫描统一只扫当前页（决策 D4），标题文案明示「当前页面」。
 * T66：trigger 双段式状态文案（决策①，「当前设计区：X | 需求单：N」）；
 * 详情编辑迁出 popover 进 ChatBriefDialog 大面板（决策②）——briefBack /
 * briefDiscardBack / briefSave 随 popover 详情视图退役，新增 dialog 素材四能力
 * 键组（上传 / 选区添加 / 删除 / 缩略图 caption）。
 */
export const panelsMessageDefaults = {
  contextTriggerLabel: 'Canvas state',
  contextTriggerDesignLabel: 'Designing: ',
  contextTriggerDesignEmpty: 'Not created',
  contextTriggerBriefsLabel: 'Briefs: ',
  contextTriggerBriefsEmpty: 'None',
  designsSection: 'Design areas',
  designsEmpty:
    'No design areas on this page yet — pick a mode / style and send a message to start one.',
  designsNoActive: 'No design area is being designed yet.',
  designsActive: 'Designing',
  designsSetCurrent: 'Switch to this',
  designsSetting: 'Switching…',
  designsSwitchFailed: 'Failed to set the current design.',
  briefsSection: 'Briefs on this page',
  briefListEmpty: 'No briefs on this page yet.',
  briefContainsActive: 'Contains active design',
  briefNew: 'New brief',
  briefNewPlaceholder: 'Requirement content (optional)…',
  briefCreate: 'Create',
  briefCreateCancel: 'Cancel',
  briefCreateFailed: 'Failed to create the brief.',
  briefDirtyHint: 'Unsaved brief edits.',
  briefDiscardClose: 'Discard & close',
  briefKeepEditing: 'Keep editing',
  briefDialogTitle: 'Brief',
  briefDialogDescription:
    'Content and materials are written back to the canvas brief — the canvas stays the single source of truth.',
  briefOpenFailed: 'This brief could not be read (structure incomplete).',
  briefDialogMissing: 'This brief is no longer on the canvas (it may have been deleted).',
  briefContent: 'Content',
  briefContentPlaceholder:
    'What to make, who it is for, must-include content, how to use the materials — the more complete, the less the AI has to guess.',
  briefMaterials: 'Materials',
  briefMaterialCaptionPlaceholder: 'Note its use (e.g. hero / style reference only)…',
  briefMaterialAdd: 'Upload image',
  briefMaterialAddSelection: params('Add from selection ({count})'),
  briefMaterialRemove: 'Remove material',
  briefConclusions: 'AI conclusions',
  briefDesigns: 'Linked designs',
  briefEmptySection: 'Empty',
  briefSaved: 'Saved',
  briefSaveFailed: 'Save failed',
  briefApplyFailed: 'Operation failed — please retry.'
} as const

/**
 * T61：新建意图确认卡 + set_active_design 同意卡 英文默认值。
 * T65：确认卡尺寸行（决策 C：预设 chips + 自定义输入）；切换成功回执 =
 * 对话流分割线（决策 D3，consentAgreedLine 随之退役）；卡片降权为系统视觉。
 */
export const confirmMessageDefaults = {
  intentTitle: 'Start a new design?',
  // 批 2（2026-09-21 拍板⑤）：卡面复述将确认的 mode/profile label——
  // 替代旧 intentUnifiedLine 静态文案（F7：卡面不说确认内容）
  intentSummaryLine: params(
    'Start a new design as {mode} / {profile} — everything already on the canvas stays as is and will not be deleted.'
  ),
  intentNoProfile: 'No profile',
  // 批 2（拍板②）：草稿随卡——拦截正文在卡内展示并可编辑，确认发的是卡上内容
  intentDraftSection: 'Message to send (editable)',
  intentSizeSection: 'Canvas size',
  intentSizeAuto: 'Auto (AI decides)',
  intentSizeCustomPlaceholder: 'Custom, e.g. 750x or 750x2000',
  intentSizeInvalid: 'Size format: Wx or WxH (e.g. 750x2000).',
  intentConfirm: 'Confirm & send',
  intentCancel: 'Cancel',
  intentConfirmedBadge: 'Confirmed',
  intentCancelledBadge: 'Cancelled',
  consentTitle: 'The AI asks to switch the current design',
  consentTarget: params('Target: {name}'),
  consentAgree: 'Switch to it',
  consentDecline: 'Keep current',
  consentAgreedBadge: 'Switched',
  consentDeclinedBadge: 'Declined',
  consentDeclinedLine: params('Declined switching to {name} — the current design is unchanged.'),
  consentFailedLine: 'Switch failed — the target design may have been moved or deleted.',
  // T91b：setup_design awaiting_new_intent_confirmation 信封卡片
  // 批 2（2026-09-21 拍板①⑤⑥）：message 不再直渲（那是模型向协议指令），换用户向
  // awaitingIntentPrompt；mode/profile 走 label 投影、briefId 换需求单名、canvas 显示
  // AI 提议值；确认成功自动重发末条用户消息（confirmedLine/cancelledLine 系统行退役，
  // 已决归档由卡面徽标承担）；expired = 未作答即被新消息/更新提议越过（借 authz expired）
  awaitingIntentTitle: 'The AI wants to create a new design — confirm?',
  awaitingIntentPrompt:
    'The AI wants to create a new design with these parameters. Confirm to proceed — your last request will be resent automatically.',
  awaitingIntentMode: 'Mode',
  awaitingIntentProfile: 'Profile',
  awaitingIntentBrief: 'Brief',
  awaitingIntentCanvas: 'Canvas size',
  awaitingIntentConfirm: 'Confirm',
  awaitingIntentCancel: 'Cancel',
  awaitingIntentConfirmedToast: 'Confirmed — resending your request',
  awaitingIntentFailedLine: params('Confirm failed: {msg}'),
  awaitingIntentExpiredBadge: 'Expired',
  awaitingIntentExpiredLine: 'This new-design proposal was not answered and has expired.',
  contextSwitchLine: params('—— Switched to {name} ——'),
  // T93：reasoning part 折叠卡标题（PiChatMessage.vue，预研 §5.2 方案 A）
  reasoningTitle: 'Thinking process',
  // T96：流式中 reasoning 折叠卡标题（PiChatMessage.vue）——区别于已结束的
  //「Thinking process」；带呼吸点动画，纯 CSS，零 JS 定时器
  reasoningStreamingTitle: 'Thinking',
  // T94：用户主动停止回执（ChatPanel toast + ChatMessage 末条消息底部小字行）
  chatStopped: 'Stopped'
} as const

/** T41：字体白名单设置面板（SettingsDialog fonts 分区）英文默认值；T42：来源开关 + 目录组 + 筛选/折叠/批量；统一批：来源开关扩至本地源 + 提供商细分 + 回退/缓存 */
export const fontsMessageDefaults = {
  settingsFonts: 'Fonts',
  fontsPanelTitle: 'Font allowlist',
  fontsPanelDescription:
    'Manage the fonts available on the canvas. A disabled font is treated as not installed: it disappears from the font picker and documents fall back to the next available font. Built-in fonts stay always on as the rendering fallback.',
  fontsSearchPlaceholder: 'Search fonts…',
  fontsLoading: 'Loading fonts…',
  fontsEmpty: 'No fonts match your search.',
  fontsEnabledSummary: params('{enabled} of {total} families enabled'),
  fontsSourceBundled: 'Built-in',
  fontsSourceCdn: 'CDN featured',
  fontsSourceCatalog: 'CDN catalog',
  fontsSourceLocal: 'System',
  fontsSourceOnline: 'Online',
  fontsLockedHint: 'Built-in fonts stay always on — they are the rendering fallback.',
  fontsLocalAccessPrompt: 'Allow access to system fonts to manage them here.',
  fontsLocalAllow: 'Allow system fonts',
  fontsVariableBadge: 'Variable',
  fontsFilterAll: 'All',
  fontsFilterEnabled: 'Enabled',
  fontsFilterDisabled: 'Disabled',
  fontsEnableAll: 'Enable all',
  fontsDisableAll: 'Disable all',
  fontsShowMore: params('Show more ({count} remaining)'),
  fontsOnlineMaster: 'Online font libraries',
  fontsOnlineMasterHint:
    'Master switch for four online libraries: Google Fonts, Fontsource, Bunny Fonts, Fontshare.',
  fontsOnlineOffHint:
    'Off — families from the four online libraries are hidden from the list and picker.',
  fontsCnMaster: 'Chinese Fonts CDN (中文网字计划)',
  fontsCnMasterHint: 'Independent switch — not affected by the online font libraries toggle.',
  fontsCnOffHint: 'Off — Chinese Fonts CDN families are hidden from the list and picker.',
  fontsUnauditedLicense: params('License: unaudited (package declares {license})'),
  fontsCatalogHint:
    'Full Chinese Fonts CDN catalog. Off by default — enabled families appear in the picker and load subset pieces on demand.',
  // 统一批 A：面板扩管提供商单独开关（自 popover 迁入）
  fontsProvidersTitle: 'Online providers',
  fontsProvidersHint:
    'Each provider is opt-in. Turn one on to list its families and load on demand.',
  fontsProvidersOptInHint: 'Turning a provider on lists thousands of online font families.',
  fontsProviderGoogleUnavailable:
    'Google Fonts is only available in the desktop app. Download the desktop app to use it.',
  // 统一批 A：回退包预下载（自 popover 迁入）
  fontsFallbackTitle: 'Fallback packs',
  fontsFallbackHint:
    'Pre-download CJK and Arabic fallbacks so files using them render without network.',
  fontsFallbackDownload: 'Download fallbacks',
  fontsFallbackDownloading: 'Downloading…',
  fontsFallbackDownloaded: 'Fallback fonts downloaded.',
  fontsFallbackDownloadFailed: 'Could not download fallback fonts.',
  // 统一批 A：缓存管理（自 popover 迁入）
  fontsCacheTitle: 'Downloaded cache',
  fontsCacheSummary: params('{count} fonts · {size}'),
  fontsCacheClear: 'Clear cache',
  fontsCacheCleared: 'Downloaded font cache cleared.',
  fontsCacheClearFailed: 'Could not clear the downloaded font cache.',
  // 统一批 B：本地源应用级开关
  fontsLocalMaster: 'System fonts',
  fontsLocalMasterHint:
    'Allow the app to enumerate and load fonts installed on this device. Turn this off to treat system fonts as not installed.',
  fontsLocalOffHint:
    'Off — system fonts are hidden from the list and picker; CJK fallback chain will skip them.'
} as const

/** ux-polish⑤（2026-09-09）：画布工具条「添加图片」文案域（Toolbar 按钮 / useAddImage 失败 toast） */
export const toolbarMessageDefaults = {
  addImage: 'Add image',
  addImageFailed:
    'Could not add the selected image — supported formats: PNG, JPEG, WebP, GIF, BMP, SVG.',
  addImageFailedEmpty: 'Could not add the image — the file is empty (0 bytes).',
  addImageFailedUnsupported:
    'Unsupported image format — supported formats: PNG, JPEG, WebP, GIF, BMP, SVG.',
  addImageFailedCorrupt: 'Could not add the image — the file is corrupted or cannot be decoded.',
  addImageFailedEngineNotReady:
    'The image engine is still starting up — please try again in a moment.'
} as const
