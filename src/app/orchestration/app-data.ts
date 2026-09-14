/**
 * 应用数据目录原语（D2：状态根收拢）。
 *
 * 改名期 ③ 的状态根解析单点——三处状态根（pi-backend/host/dev 形态 +
 * 桥 discovery）统一进 OS 标准应用数据目录，与 Electron userData 同位
 * （Windows %APPDATA%/Dianjing、macOS ~/Library/Application Support/Dianjing、
 * Linux $XDG_CONFIG_HOME/Dianjing 或 ~/.config/Dianjing）。三形态共享同一
 * 真源，避免「三处根不统一 + 双层嵌套 + 卸载残渣」。
 *
 * 行为纪律：
 *  - 纯函数（env 注入 + platform 注入，测试可走 fixture 不读真实环境）
 *  - leaf 模块：仅依赖 node:os + brand.ts，浏览器链不碰
 *  - 不创建目录（mkdir 由 caller 持有，resolver 只算路径）
 *
 * 与 env.ts 的关系：本模块只解析默认根；env override（D2 起语义改为
 *「直接指向状态根本身」而非「含 .dianjing 子层」）由 env.ts readRootDir
 * 暴露。两者职责分离：本模块算「OS 默认是哪儿」，env.ts 算「调用方想钉哪儿」。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { USER_DATA_DIR_NAME } from './brand'
import type { EnvSource } from './env'

/**
 * 解析 OS 标准应用数据目录下的 Dianjing 状态根。
 *
 * 平台语义（与 Electron app.getPath('userData') 对齐——打包形态 main.ts
 * 已显式走 app.getPath('userData'，本函数覆盖 dev/host/桥 discovery 形态）：
 *  - win32：%APPDATA%/Dianjing（env.APPDATA 缺失则 homedir()/AppData/Roaming）
 *  - darwin：~/Library/Application Support/Dianjing
 *  - linux（缺省）：$XDG_CONFIG_HOME/Dianjing（缺失则 ~/.config/Dianjing）
 *
 * 参数：
 *  - env：env 源（结构子集，缺省 process.env——测试纪律：禁止直接读真实
 *    env，需走注入；本函数本身不读 env，只在 win32/linux 分支透传给下游）
 *  - runtimePlatform：缺省 process.platform（同上，测试可显式注入）
 *
 * 注意：返回的路径**不**含 mkdir 副作用。调用方按需 mkdirSync/await mkdir。
 */
export function resolveAppDataRoot(env: EnvSource, runtimePlatform?: string): string {
  const platform = runtimePlatform ?? process.platform
  if (platform === 'win32') {
    const appData = env?.APPDATA?.trim()
    const base = appData && appData.length > 0 ? appData : join(homedir(), 'AppData', 'Roaming')
    return join(base, USER_DATA_DIR_NAME)
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', USER_DATA_DIR_NAME)
  }
  // linux / 其他 unix：按 XDG 规范——XDG_CONFIG_HOME 缺省 ~/.config
  const xdgConfig = env?.XDG_CONFIG_HOME?.trim()
  const base = xdgConfig && xdgConfig.length > 0 ? xdgConfig : join(homedir(), '.config')
  return join(base, USER_DATA_DIR_NAME)
}
