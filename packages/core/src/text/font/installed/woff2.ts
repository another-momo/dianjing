/**
 * woff2 → sfnt 转码封装。
 *
 * 形态：纯函数层（无 fs）。wawoff2 是 emscripten 编出的 wasm + CJS 无类型包，
 * 包体内 async 函数（runtime 等 wasm 初始化完成后 resolve）。本仓走 lazy +
 * 错误透明策略：
 *  - 引入方式：createRequire 拉 CJS 默认导出（`import wawoff2 from 'wawoff2'`
 *    在本仓 esModuleInterop=false + bun transpile 下会被识别为 namespace 而非
 *    默认导出；createRequire 走 node CJS 解析更稳）。
 *  - 转码后 sniff sfnt 魔数（ttf=0x00010000 / otf='OTTO'）— wawoff2 输出恒为
 *    sfnt 容器（ttf 或 otf 取决于原字体轮廓格式），扩展名以转码后魔数为准。
 *
 * 浏览器 bundle 隔离：install.ts 不静态 import 本模块（避免把 315KB wasm
 * 打入非必要路径）；调用方在运行时按需注入 transcode 闭包。
 */
import { createRequire } from 'node:module'

import { detectContainer } from './validate'

const requireCJS = createRequire(import.meta.url)
const wawoff2 = requireCJS('wawoff2') as {
  decompress: (input: Uint8Array) => Promise<Uint8Array>
}

/** woff2 容器（'wOF2' 魔数）转 sfnt 容器（ttf/otf）。非 woff2 输入直接抛。 */
export async function transcodeWoff2ToSfnt(bytes: Uint8Array): Promise<Uint8Array> {
  if (detectContainer(bytes) !== 'woff2') {
    throw new Error('transcodeWoff2ToSfnt requires a woff2 input')
  }
  const output = await wawoff2.decompress(bytes)
  // wawoff2 返回的是 WASM 堆上的视图（实测 output.buffer 恒为整块 16MB 堆）——
  // 必须立即拷出：持有的视图在后续 decompress/GC 活动后会被堆复用覆写成垃圾
  // （实证：69 片装完 68 片魔数全毁、仅存最后一片；校验通过 ≠ 写盘时仍合法）。
  const copied = new Uint8Array(output.byteLength)
  copied.set(output)
  const magic = new DataView(copied.buffer, copied.byteOffset, 4).getUint32(0)
  if (magic !== 0x00010000 && magic !== 0x4f54544f) {
    throw new Error(`transcoded bytes have unexpected sfnt magic: 0x${magic.toString(16)}`)
  }
  return copied
}
