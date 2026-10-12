/**
 * 共享 style 命名（weight → 英文 style 名）。fontsource / gf-api 两适配器
 * 的产物 style 字符串必须一致（同一 (weight, italic) 同名），故收敛单处。
 */
const WEIGHT_LABELS: Record<number, string> = {
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black'
}

export function styleLabel(weight: number, italic: boolean): string {
  const base = WEIGHT_LABELS[weight] ?? `Weight ${weight}`
  return italic ? `${base} Italic` : base
}
