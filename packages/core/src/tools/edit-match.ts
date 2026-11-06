// edit_file 的匹配逻辑，只处理已经统一成 \n 的文本。

export type EditMatch =
  | { kind: 'ok'; content: string; count: number; firstLine: number; fuzzy: boolean }
  | { kind: 'multiple'; lines: number[] }
  | { kind: 'none'; closest: { startLine: number; endLine: number; snippet: string } | null }

export function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): EditMatch {
  const exact = findAll(content, oldString)
  // 旧文本以空白开头、却落在某行缩进的中间：多半是模型把缩进抄少了，按行对齐并重排缩进才对
  if (exact.length > 0 && /^[ \t]/.test(oldString) && exact.every((index) => insideIndentation(content, index))) {
    const aligned = fuzzyEdit(content, oldString, newString, replaceAll)
    if (aligned.kind === 'ok') return aligned
  }
  if (exact.length > 1 && !replaceAll) return { kind: 'multiple', lines: exact.map((index) => lineOf(content, index)) }
  if (exact.length > 0) {
    const firstLine = lineOf(content, exact[0] ?? 0)
    const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString)
    return { kind: 'ok', content: updated, count: exact.length, firstLine, fuzzy: false }
  }
  return fuzzyEdit(content, oldString, newString, replaceAll)
}

// 弱模型常把缩进和行尾空白抄错：逐行比较 trim 后的内容，唯一命中时按文件里的缩进重排新内容
function fuzzyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): EditMatch {
  const fileLines = content.split('\n')
  const oldLines = trimBlankEdges(oldString.split('\n'))
  if (oldLines.length === 0) return { kind: 'none', closest: null }

  const windows: number[] = []
  for (let start = 0; start + oldLines.length <= fileLines.length; start++) {
    if (oldLines.every((line, offset) => (fileLines[start + offset] ?? '').trim() === line.trim())) windows.push(start)
  }

  if (windows.length === 0) return { kind: 'none', closest: closestWindow(fileLines, oldLines) }
  if (windows.length > 1 && !replaceAll) return { kind: 'multiple', lines: windows.map((start) => start + 1) }

  const oldIndent = leadingWhitespace(oldLines[0] ?? '')
  let result = fileLines
  // 从后往前替换，前面窗口的行号不受影响
  for (const start of [...windows].reverse()) {
    const fileIndent = leadingWhitespace(result[start] ?? '')
    const replacement = newString
      .split('\n')
      .map((line) => (line.startsWith(oldIndent) ? fileIndent + line.slice(oldIndent.length) : line))
    result = [...result.slice(0, start), ...replacement, ...result.slice(start + oldLines.length)]
  }
  return { kind: 'ok', content: result.join('\n'), count: windows.length, firstLine: (windows[0] ?? 0) + 1, fuzzy: true }
}

function closestWindow(fileLines: string[], oldLines: string[]): { startLine: number; endLine: number; snippet: string } | null {
  let best = { start: -1, score: 0 }
  for (let start = 0; start < fileLines.length; start++) {
    let score = 0
    for (let offset = 0; offset < oldLines.length && start + offset < fileLines.length; offset++) {
      const line = (oldLines[offset] ?? '').trim()
      if (line && (fileLines[start + offset] ?? '').trim() === line) score++
    }
    if (score > best.score) best = { start, score }
  }
  if (best.start < 0) return null
  const from = Math.max(0, best.start - 2)
  const to = Math.min(fileLines.length, best.start + oldLines.length + 2)
  const snippet = fileLines
    .slice(from, to)
    .map((line, index) => `${from + index + 1}\t${line}`)
    .join('\n')
  return { startLine: from + 1, endLine: to, snippet }
}

function findAll(content: string, needle: string): number[] {
  if (!needle) return []
  const indexes: number[] = []
  let index = content.indexOf(needle)
  while (index !== -1) {
    indexes.push(index)
    index = content.indexOf(needle, index + needle.length)
  }
  return indexes
}

function insideIndentation(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1
  return index > lineStart && /^[ \t]+$/.test(content.slice(lineStart, index))
}

function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++
  return line
}

function leadingWhitespace(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? ''
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start++
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--
  return lines.slice(start, end)
}
