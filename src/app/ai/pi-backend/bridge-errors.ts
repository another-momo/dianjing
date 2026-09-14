/**
 * T98：桥失败的模型可见错误分类（T66/T81「内部设施不外露」收口）。
 *
 * 实证缺陷（owner 实测）：render 工具 JSX 解析错（模型误输出字面 `</jsx>`）
 * 经桥回到后端时被统一包成「7600 桥执行失败：...——确认浏览器已打开 app」——
 * ① 工具侧解析错误被误标为编辑器离线类连接故障，误导 agent 排查环境；
 * ② 模型可见文本泄露端口 7600 与「桥」架构措辞。
 *
 * 两类失败的判别缝（桥侧 server.ts 配合：浏览器显式应答 ok:false 的工具错误
 * 以 200 返回，连接级失败保留 502）：
 *  - 连接级：discovery 缺失 / fetch 拒绝 / 401 / 502（桥在线但编辑器未连、
 *    RPC 超时、浏览器断连）——编辑器确实不可达，模型应引导用户打开 app。
 *  - 工具执行级：2xx + {ok:false, error}——编辑器在线且已执行，工具自身
 *    抛错（JSX 解析/参数校验/运行时）。原样归类为工具错误，透传清洗后的
 *    工具 message，绝不附「确认浏览器已打开」类误导指引。
 *
 * 模型可见文案一律英文（对齐 core 工具 description 与 T21 step warning、
 * T81 vision 前置拒绝的既有语言习惯）；端口、桥架构措辞、堆栈等内部细节
 * 只进后端日志（调用方 console.warn），不进模型可见 text。
 */

/** 连接级失败统一文案（模型可见）——不含端口/桥/discovery 等内部设施字眼。 */
export const EDITOR_UNREACHABLE_MESSAGE =
  'Editor is not reachable — make sure the Dianjing Studio app is open in a browser tab with a document loaded, then try again.'

/** 内部落点路径片段（最小清洗的判定锚）：核心包/源码目录/依赖目录 */
const INTERNAL_PATH_PATTERN = /(?:^|[\\/])(?:packages|src|node_modules)(?:[\\/]|$)/

/** 类绝对路径片段（≥2 个分隔符，避免误伤 JSX/普通文本里的单个斜杠；
 *  片段内不允许冒号——Windows 盘符冒号由前缀单独承接） */
const PATH_LIKE_PATTERN = /(?:[A-Za-z]:)?(?:[\\/][^\s:"'()[\]]+){2,}/g

/**
 * 工具错误 message 最小清洗：剥掉偶发的内部绝对路径（核心包落点等），其余
 * 原样透传——工具自身 message（如 JSX parse error）是对模型最有用的修正
 * 信号，不做改写映射。
 */
export function sanitizeToolErrorMessage(message: string | undefined, toolName: string): string {
  const raw = message?.trim()
  if (!raw) return `Tool ${toolName} failed without an error message.`
  return raw.replace(PATH_LIKE_PATTERN, (segment) =>
    INTERNAL_PATH_PATTERN.test(segment) ? '[internal path]' : segment
  )
}

export type BridgeFailure =
  | { kind: 'editor-unreachable'; message: typeof EDITOR_UNREACHABLE_MESSAGE }
  | { kind: 'tool-error'; message: string }

/**
 * 桥 /rpc 响应 → 模型可见错误分类。
 * 调用方约定：连接级分支同时 console.warn 内部细节（HTTP 状态/上游 error），
 * 模型可见 text 只取 failure.message。
 */
export function classifyBridgeFailure(
  status: number,
  body: { ok?: boolean; error?: string } | null,
  toolName: string
): BridgeFailure {
  // 2xx + ok:false = 桥已中继、编辑器显式应答工具失败（server.ts 对此类固定
  // 回 200；502 保留给编辑器不可达：未连接/RPC 超时/断连）
  if (status >= 200 && status < 300 && body?.ok === false) {
    return { kind: 'tool-error', message: sanitizeToolErrorMessage(body.error, toolName) }
  }
  return { kind: 'editor-unreachable', message: EDITOR_UNREACHABLE_MESSAGE }
}
