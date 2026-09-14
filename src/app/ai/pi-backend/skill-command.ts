/**
 * T91o：/skill: 命令归一化——pi SDK `_expandSkillCommand`（agent-session.js:953）
 * 只认「整条消息以 /skill: 开头 + skill 名到首个 ASCII 空格止」的单命令契约：
 *  - 名后直接贴中文（无空格）→ skillName 吞掉整段正文、查无此 skill 透传
 *  - 提及在句中/句尾 → startsWith 不过、整条透传
 * 透传后模型只拿到字面 /skill: 文本，退化成 find/read/ls 猎 SKILL.md——
 * .dianjing/skills 是隐藏目录、fd 默认不搜隐藏目录，永远猎不到
 * （owner 情况①②实测）。
 *
 * 本模块只做「整形」：把首个 /skill: 提及提到消息头、与正文用单空格连接，
 * 展开动作留给 SDK 原生路径（块格式/位置/transcript 形状与 pi CLI 完全一致，
 * 不自建展开逻辑）。其余提及保留字面文本（SDK 单命令契约；模型可经
 * <available_skills> 清单的 location 自读，base.md 已禁文件系统搜索）。
 * 未知 skill 名归一化后由 SDK 查无透传（同 pi CLI 语义），不在本层判存否。
 */

const SKILL_MENTION = /\/skill:([A-Za-z0-9_-]+)/

/**
 * 首个 `/skill:<name>` 提及归一为 SDK 可展开的命令形：`/skill:<name> <正文>`。
 * 无提及 → 原文不动。已是命令形 → 幂等。
 */
export function normalizeSkillCommandText(text: string): string {
  const first = SKILL_MENTION.exec(text)
  if (!first) return text
  // 移除首个提及后接缝两侧空白收敛为单空格（token 原本自带的间距不遗留在
  // args 里）；两侧任一为空的 join 自然去尾/头
  const before = text.slice(0, first.index).replace(/\s+$/, '')
  const after = text.slice(first.index + first[0].length).replace(/^\s+/, '')
  const remainder = [before, after].filter(Boolean).join(' ')
  return remainder ? `/skill:${first[1]} ${remainder}` : `/skill:${first[1]}`
}
