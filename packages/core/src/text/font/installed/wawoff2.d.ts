/**
 * wawoff2 ambient 声明。
 *
 * wawoff2 是纯 CJS 无官方 .d.ts 的包（fontello/wawoff2@2.0.1）。本仓 core 域
 * 直接消费其压缩 / 解压 API。声明放本目录本地：避免污染全局 @types，也不让上游
 * 类型包 transitively 改源。
 *
 * 真实签名（decompress.js / compress.js）：
 *  - decompress(buffer: Uint8Array): Promise<Uint8Array> — 失败 throw Error('ConvertWOFF2ToTTF failed')
 *  - compress(buffer: Uint8Array): Promise<Uint8Array>  — 失败 throw Error('ConvertTTFToWOFF2 failed')
 */
declare module 'wawoff2' {
  export function decompress(input: Uint8Array): Promise<Uint8Array>
  export function compress(input: Uint8Array): Promise<Uint8Array>
}
