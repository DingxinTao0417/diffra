// 架构页 SVG 里的文字：按页面实际字体量宽度，按宽度折行（中文逐字断，英文单词不从中间断）

let canvas: CanvasRenderingContext2D | null = null

export function svgFont(size: number, bold = false): string {
  return `${bold ? '700 ' : ''}${size}px ${getComputedStyle(document.body).fontFamily}`
}

export function textWidth(text: string, font: string): number {
  canvas ??= document.createElement('canvas').getContext('2d')
  if (!canvas) return text.length * Number.parseFloat(font.replace(/^700 /, ''))
  canvas.font = font
  return canvas.measureText(text).width
}

export function wrapText(text: string, width: number, font: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const char of text) {
    if (!line || textWidth(line + char, font) <= width) {
      line += char
      continue
    }
    const space = /\w/.test(char) && /\w$/.test(line) ? line.lastIndexOf(' ') : -1
    if (space > 0) {
      lines.push(line.slice(0, space))
      line = line.slice(space + 1) + char
    } else {
      lines.push(line)
      line = char === ' ' ? '' : char
    }
  }
  if (line) lines.push(line)
  return lines
}
