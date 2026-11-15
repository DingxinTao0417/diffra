// 命令输出里的 ANSI 颜色码（第 655 步）：只认 SGR（ESC[…m）的前景色、粗体、暗、下划线、反色，换成主题令牌的颜色；
// 光标移动、清屏、OSC 链接这些控制序列去掉。不认背景色（大多是进度条），反色当作强调

export interface AnsiSpan {
  text: string
  className: string
}

// 30–37、90–97 的前景色对到令牌：红是出错、黄是提醒，其余借代码高亮的颜色（不用成功色：终端的绿不是验证结果）
const COLORS: Record<number, string> = {
  30: 'text-foreground',
  31: 'text-destructive',
  32: 'text-(--code-tag)',
  33: 'text-warning',
  34: 'text-(--code-string)',
  35: 'text-(--code-function)',
  36: 'text-(--code-number)',
  37: 'text-foreground',
  90: 'text-muted-foreground',
  91: 'text-destructive',
  92: 'text-(--code-tag)',
  93: 'text-warning',
  94: 'text-(--code-string)',
  95: 'text-(--code-function)',
  96: 'text-(--code-number)',
  97: 'text-foreground',
}

const SEQUENCE = /\u001b\[([0-9;?]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function hasAnsi(text: string): boolean {
  return text.includes('\u001b')
}

export function stripAnsi(text: string): string {
  return text.replace(SEQUENCE, '')
}

// 按行拆成带样式的片段；样式跨行延续（和终端一样）
export function parseAnsi(text: string): AnsiSpan[][] {
  const lines: AnsiSpan[][] = []
  let color: string | null = null
  let bold = false
  let dim = false
  let underline = false
  const className = () => [color, bold && 'font-bold', dim && 'opacity-70', underline && 'underline'].filter(Boolean).join(' ')
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    // 回车覆盖同一行（进度条）：只留最后一段
    const line = raw.includes('\r') ? raw.slice(raw.lastIndexOf('\r') + 1) : raw
    const spans: AnsiSpan[] = []
    let last = 0
    for (const match of line.matchAll(SEQUENCE)) {
      if (match.index > last) spans.push({ text: line.slice(last, match.index), className: className() })
      last = match.index + match[0].length
      if (match[2] !== 'm') continue
      const codes = (match[1] || '0').split(';').map(Number)
      for (let index = 0; index < codes.length; index++) {
        const code = codes[index]!
        if (code === 0) {
          color = null
          bold = dim = underline = false
        } else if (code === 1) bold = true
        else if (code === 2) dim = true
        else if (code === 4) underline = true
        else if (code === 7) bold = true
        else if (code === 22) bold = dim = false
        else if (code === 24) underline = false
        else if (code === 39) color = null
        else if (COLORS[code]) color = COLORS[code]!
        // 256 色和真彩色：38;5;n、38;2;r;g;b，跳过参数，按默认色显示
        else if (code === 38 || code === 48) index += codes[index + 1] === 5 ? 2 : 4
      }
    }
    if (last < line.length) spans.push({ text: line.slice(last), className: className() })
    lines.push(spans)
  }
  return lines
}
