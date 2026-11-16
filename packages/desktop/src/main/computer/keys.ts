// 电脑操控（v2 · M5）的按键：「Ctrl+Shift+T」这样的写法拆成修饰键和一个主键，再按系统换成虚拟键码。
// 不引 Electron，scripts/computer.test.ts 直接测

export type Modifier = 'ctrl' | 'shift' | 'alt' | 'meta'

export interface KeyCombo {
  modifiers: Modifier[]
  // 规范化的键名：a–z、0–9、enter、tab、escape、backspace、delete、space、up、down、left、right、home、end、pageup、pagedown、insert、f1–f12
  key: string | null
}

const MODIFIER_NAMES: Record<string, Modifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  super: 'meta',
}

const KEY_NAMES: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  tab: 'tab',
  esc: 'escape',
  escape: 'escape',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  space: 'space',
  up: 'up',
  arrowup: 'up',
  down: 'down',
  arrowdown: 'down',
  left: 'left',
  arrowleft: 'left',
  right: 'right',
  arrowright: 'right',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  insert: 'insert',
}

export function parseKeys(keys: string): KeyCombo {
  const parts = keys.length === 1 ? [keys] : keys.split('+').map((part) => part.trim())
  const modifiers: Modifier[] = []
  let key: string | null = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    const modifier = MODIFIER_NAMES[lower]
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier)
      continue
    }
    if (key !== null) throw new Error(`一次只能按一个主键：${keys}`)
    if (KEY_NAMES[lower]) key = KEY_NAMES[lower]
    else if (/^f([1-9]|1[0-2])$/.test(lower)) key = lower
    else if (/^[a-z0-9]$/.test(lower)) key = lower
    else throw new Error(`认不出这个键：${part}`)
  }
  if (key === null && modifiers.length === 0) throw new Error(`没有要按的键：${keys}`)
  return { modifiers, key }
}

// Windows 虚拟键码；扩展键（方向键、Home、End 这些）要带 KEYEVENTF_EXTENDEDKEY
const WINDOWS_KEYS: Record<string, number> = {
  enter: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  space: 0x20,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  insert: 0x2d,
  ctrl: 0x11,
  shift: 0x10,
  alt: 0x12,
  meta: 0x5b,
}
const WINDOWS_EXTENDED = new Set(['delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'insert', 'meta'])

export function windowsKey(key: string): { vk: number; extended: boolean } {
  const known = WINDOWS_KEYS[key]
  if (known !== undefined) return { vk: known, extended: WINDOWS_EXTENDED.has(key) }
  if (/^[a-z]$/.test(key)) return { vk: key.toUpperCase().charCodeAt(0), extended: false }
  if (/^[0-9]$/.test(key)) return { vk: key.charCodeAt(0), extended: false }
  const fn = /^f(\d+)$/.exec(key)
  if (fn) return { vk: 0x6f + Number(fn[1]), extended: false }
  throw new Error(`认不出这个键：${key}`)
}

// macOS 的虚拟键码（Carbon 的 kVK_*，按美式键盘位置）
const MAC_KEYS: Record<string, number> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f,
  y: 0x10, t: 0x11, '1': 0x12, '2': 0x13, '3': 0x14, '4': 0x15, '6': 0x16, '5': 0x17, '9': 0x19, '7': 0x1a, '8': 0x1c, '0': 0x1d,
  o: 0x1f, u: 0x20, i: 0x22, p: 0x23, l: 0x25, j: 0x26, k: 0x28, n: 0x2d, m: 0x2e,
  enter: 0x24, tab: 0x30, space: 0x31, backspace: 0x33, escape: 0x35, delete: 0x75,
  home: 0x73, end: 0x77, pageup: 0x74, pagedown: 0x79, left: 0x7b, right: 0x7c, down: 0x7d, up: 0x7e, insert: 0x72,
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62, f8: 0x64, f9: 0x65, f10: 0x6d, f11: 0x67, f12: 0x6f,
  meta: 0x37, shift: 0x38, alt: 0x3a, ctrl: 0x3b,
}

export function macKey(key: string): number {
  const code = MAC_KEYS[key]
  if (code === undefined) throw new Error(`认不出这个键：${key}`)
  return code
}

// 输入的文字按换行、制表符拆开：这两个按 Enter、Tab 键发，其余按 Unicode 字符发（中文也行）
export function textSegments(text: string): Array<{ text: string } | { key: 'enter' | 'tab' }> {
  const segments: Array<{ text: string } | { key: 'enter' | 'tab' }> = []
  let current = ''
  for (const char of text.replace(/\r\n?/g, '\n')) {
    if (char === '\n' || char === '\t') {
      if (current) segments.push({ text: current })
      current = ''
      segments.push({ key: char === '\n' ? 'enter' : 'tab' })
    } else current += char
  }
  if (current) segments.push({ text: current })
  return segments
}
