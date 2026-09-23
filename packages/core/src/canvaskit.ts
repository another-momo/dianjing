/// <reference types="vite/client" />
import CanvasKitInit, { type CanvasKit } from 'canvaskit-wasm'

import { hasWindowGlobal } from './constants'

let instance: CanvasKit | null = null

export interface CanvasKitOptions {
  locateFile?: (file: string) => string
}

export async function getCanvasKit(options?: CanvasKitOptions): Promise<CanvasKit> {
  if (instance) return instance

  const defaultLocate = (file: string) => {
    // bun/node 运行时一律走 fs 读盘——不能用 hasWindowGlobal 判定：bun 测试里
    // window stub 会让活探返真，误走浏览器 fetch 分支挂起（render 批次 30s 超时实证）
    if ('Bun' in globalThis || !hasWindowGlobal()) {
      const ckPath = import.meta.resolve('canvaskit-wasm')
      const pathname = decodeURIComponent(new URL(file, ckPath).pathname)
      // Windows file URL 的 pathname 带前导斜杠（/D:/...），剥掉才能过 fs 读盘
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname
    }
    const base = 'env' in import.meta ? import.meta.env.BASE_URL : '/'
    const prefix = base === '/' ? '' : base.replace(/\/$/, '')
    return `${prefix}/${file}`
  }

  instance = await CanvasKitInit({
    locateFile: options?.locateFile ?? defaultLocate
  })

  // B-6 用后即焚代理（仓外 docs/202609221818 §4 抓虫网）：仅 vite dev 形态
  // 生效（import.meta.env.DEV 且非 Bun 运行时——bun 测试不套，避免代理身份
  // 差干扰既有断言）；生产构建 DEV=false 整支短路，零开销。
  if ('env' in import.meta && import.meta.env.DEV && !('Bun' in globalThis)) {
    instance = wrapCanvasKitUseAfterDeleteGuard(instance)
  }

  return instance
}

// ── B-6 用后即焚代理 ─────────────────────────────────────────────────────
// CanvasKit 堆真因未查明期间，把「UAF 写脏堆后在随机位置随机炸」降级为
// 「首个作案点可定位」：dev 形态给 CanvasKit 返回的 embind 对象套 Proxy，
// .delete() 之后再碰任何方法/属性立即在调用点抛带标签的 JS 错误。
// isDeleted 保持可查询（embind 契约里它是 delete 后唯一安全的方法）。

type EmbindInstance = { delete: () => void; isDeleted: () => boolean }

function isEmbindInstance(value: unknown): value is EmbindInstance {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { delete?: unknown; isDeleted?: unknown }
  return typeof candidate.delete === 'function' && typeof candidate.isDeleted === 'function'
}

function wrapEmbind<T extends object>(obj: T, label: string): T {
  let deleted = false
  return new Proxy(obj, {
    get(target, prop, receiver) {
      if (prop === 'delete') {
        return () => {
          deleted = true
          ;(Reflect.get(target, 'delete') as () => void).call(target)
        }
      }
      if (prop === 'isDeleted') return () => deleted
      if (deleted) {
        throw new Error(
          `[canvaskit-uaf-guard] ${label}.${String(prop)} accessed after delete() —— use-after-delete 首个作案点`
        )
      }
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      // 方法包装必须是 apply+construct 双 trap 的 Proxy 而非裸箭头函数——
      // 箭头函数会丢掉原函数的静态属性（embind 枚举命名空间如 ColorSpace.SRGB
      // 挂在可调用对象上，丢失后传参变 undefined：dev 实证 'Cannot pass
      // "undefined" as a sk_sp<ColorSpace>'），也让 new ck.Font() 这类构造器
      // 退化成普通调用
      return new Proxy(value, {
        apply(fnTarget, _thisArg, args) {
          const result = Reflect.apply(fnTarget as (...a: unknown[]) => unknown, target, args)
          // 方法调用结果若是 embind 对象（如 surface.makeImageSnapshot()）递归套代理
          return isEmbindInstance(result)
            ? wrapEmbind(result as object, `${label}.${String(prop)}()`)
            : result
        },
        construct(fnTarget, args) {
          const result = Reflect.construct(fnTarget as new (...a: unknown[]) => object, args)
          return isEmbindInstance(result)
            ? wrapEmbind(result, `${label}.${String(prop)}()`)
            : result
        }
      })
    }
  })
}

/** 给 CanvasKit 模块对象套代理：工厂方法返回的 embind 对象递归受控。 */
export function wrapCanvasKitUseAfterDeleteGuard(ck: CanvasKit): CanvasKit {
  return new Proxy(ck, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      // 同 wrapEmbind：双 trap Proxy 保原函数静态属性（枚举命名空间穿透）
      // 与构造器语义（new ck.Font()）
      return new Proxy(value, {
        apply(fnTarget, _thisArg, args) {
          const result = Reflect.apply(fnTarget as (...a: unknown[]) => unknown, target, args)
          return isEmbindInstance(result)
            ? wrapEmbind(result as object, `ck.${String(prop)}()`)
            : result
        },
        construct(fnTarget, args) {
          const result = Reflect.construct(fnTarget as new (...a: unknown[]) => object, args)
          return isEmbindInstance(result) ? wrapEmbind(result, `ck.${String(prop)}()`) : result
        }
      })
    }
  })
}
