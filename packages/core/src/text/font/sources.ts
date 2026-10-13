export type FontFamilySource = 'bundled' | 'user' | 'fallback'

/**
 * Sources whose picker rows support an on-demand preview load via `loadFont`.
 * The picker triggers `@vue:mounted` font fetch only when the row's source is in
 * this set — list-driven routes are loaded through their own pipelines.
 */
export const PREVIEWABLE_FONT_SOURCES: readonly FontFamilySource[] = ['user', 'bundled'] as const
export type FontLoadedSource = FontFamilySource | 'cache' | 'registered'

export interface FontFamilyOption {
  family: string
  source: FontFamilySource
}

/**
 * 应用字体库（用户安装）提供者：list 返 FamilyView 聚合视图，read 返指定
 * 族内 style 的字节（FamilyView.styles[].key）。core 域不依赖 HTTP——app 层
 * 把 client-fonts 适配成该接口后注入。
 *
 * readSubsetPieces（可选）：subset-collection artifact 族的渲染期加载——按
 * 字符选片 + 拉片字节。返回主片（首片）+ 补充片（同名 alias 防塌缩）形态。
 * 未实现时 subset-collection 族走 read 端点会被服务端 501 拒，本方法也返 null。
 */
export interface UserFontProvider {
  list(): Promise<
    {
      family: string
      styles: { key: string; weight: number; italic: boolean; variable: boolean }[]
    }[]
  >
  read(family: string, styleKey: string): Promise<ArrayBuffer | null>
  readSubsetPieces?(args: {
    family: string
    /** 请求侧 style 字符串（FontManager 注册键；与 family|style 缓存键一致） */
    style: string
    /** 已解析的真值 styleKey——list 端点/style[].key 之一。选片按它精确匹配，
     *  解决.VF 族 index 条目.weight 恒 400（adapter 用单 variable 条目）时按
     *  weight/italic 推断会过滤为零的回退问题 */
    styleKey: string
    characters: string
  }): Promise<{
    primary: { hash: string; buffer: ArrayBuffer; ranges: Array<[number, number]> }
    supplemental: Array<{ hash: string; buffer: ArrayBuffer; ranges: Array<[number, number]> }>
    coveredCharacters: string[]
  } | null>
}
