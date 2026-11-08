import { MIXED, type MixedValue } from '@open-pencil/vue/controls/node-props'

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

const channel = (value: number) =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0')

export function toHex(color: RGBA): string {
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase()
}

// #RGB 或 #RRGGBB；不合法时返回 null
export function fromHex(text: string, alpha = 1): RGBA | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())
  if (!match) return null
  const hex = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join('') : match[1]!
  const value = (offset: number) => parseInt(hex.slice(offset, offset + 2), 16) / 255
  return { r: value(0), g: value(2), b: value(4), a: alpha }
}

export function isMixed<T>(value: MixedValue<T>): value is typeof MIXED {
  return value === MIXED
}

// 输入框里显示的数字：混合值显示「混合」，小数最多两位
export function showNumber(value: MixedValue<number>): string {
  if (isMixed(value)) return '混合'
  return String(Math.round(value * 100) / 100)
}
