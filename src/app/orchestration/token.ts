import { randomBytes } from 'node:crypto'

/**
 * 生成 32-hex 字符鉴权 token（randomBytes(16).toString('hex') 的薄封装）。
 * 三处编排共享同一来源——bridge vite 插件、pi-backend vite 插件、Electron main、
 * pi-backend host.ts——避免「每处自备 randomBytes」漂移。
 */
export function generateToken(): string {
  return randomBytes(16).toString('hex')
}
