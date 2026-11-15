export interface DiffLine {
  kind: 'add' | 'remove' | 'context'
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface FileDiff {
  path: string
  status: 'added' | 'deleted' | 'modified'
  binary: boolean
  added: number
  removed: number
  hunks: DiffLine[][]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// 解析 git diff-tree -p 的输出（检查点仓库关掉了 quotepath，--no-renames 不会有改名）
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: DiffLine[] | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // 路径先按 a/x b/x 猜一个，后面的 ---/+++ 行更准
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      file = { path: match?.[2] ?? line.slice(11), status: 'modified', binary: false, added: 0, removed: 0, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (hunk === null) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('Binary files')) file.binary = true
      else if (line.startsWith('+++ b/')) file.path = stripTab(line.slice(6))
      else if (line.startsWith('--- a/') && file.status === 'deleted') file.path = stripTab(line.slice(6))
    }
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      hunk = []
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('+')) {
      hunk.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLine++ })
      file.added += 1
    } else if (line.startsWith('-')) {
      hunk.push({ kind: 'remove', text: line.slice(1), oldLine: oldLine++, newLine: null })
      file.removed += 1
    } else if (line.startsWith(' ')) {
      hunk.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return files
}

// 路径里有空格时 git 会在 ---/+++ 行末尾加一个制表符
function stripTab(path: string): string {
  return path.endsWith('\t') ? path.slice(0, -1) : path
}

export interface LooseDiffFile {
  path: string | null
  added: number
  removed: number
  hunks: DiffLine[][]
}

const DEV_NULL = '/dev/null'

// 回答里 ```diff 的内容：有 diff --git 头的按 git 的格式解析；没有的放宽，--- / +++ 换文件，@@ 带行号，
// 只有 +/- 行、没有 @@ 的也算一段（没有行号）
export function parseLooseDiff(text: string): LooseDiffFile[] {
  const normalized = text.replace(/\r\n/g, '\n')
  if (/^diff --git /m.test(normalized)) return parseUnifiedDiff(normalized).map(({ path, added, removed, hunks }) => ({ path, added, removed, hunks }))
  const files: LooseDiffFile[] = []
  let file: LooseDiffFile | null = null
  let hunk: DiffLine[] | null = null
  let oldLine: number | null = null
  let newLine: number | null = null
  const lines = normalized.replace(/\n+$/, '').split('\n')
  const currentFile = () => {
    if (!file) {
      file = { path: null, added: 0, removed: 0, hunks: [] }
      files.push(file)
    }
    return file
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
      const oldPath = stripPrefix(line.slice(4))
      const newPath = stripPrefix(lines[index + 1]!.slice(4))
      file = { path: newPath === DEV_NULL ? oldPath : newPath, added: 0, removed: 0, hunks: [] }
      files.push(file)
      hunk = null
      index += 1
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      hunk = []
      currentFile().hunks.push(hunk)
      continue
    }
    // 「\ No newline at end of file」不是代码行
    if (line.startsWith('\\')) continue
    if (!hunk) {
      // 第一段之前 git 的头信息（index、new file mode）不算代码行
      if (/^(index |new file mode|deleted file mode|similarity |rename (from|to) )/.test(line)) continue
      oldLine = null
      newLine = null
      hunk = []
      currentFile().hunks.push(hunk)
    }
    const target = currentFile()
    if (line.startsWith('+')) {
      hunk.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLine === null ? null : newLine++ })
      target.added += 1
    } else if (line.startsWith('-')) {
      hunk.push({ kind: 'remove', text: line.slice(1), oldLine: oldLine === null ? null : oldLine++, newLine: null })
      target.removed += 1
    } else {
      hunk.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line, oldLine: oldLine === null ? null : oldLine++, newLine: newLine === null ? null : newLine++ })
    }
  }
  return files.filter((item) => item.hunks.some((lines) => lines.length > 0))
}

// --- a/src/x.ts、+++ b/src/x.ts 去掉 a/ b/ 前缀和末尾的时间戳
function stripPrefix(path: string): string {
  const clean = stripTab(path).split('\t')[0]!.trim()
  return clean === DEV_NULL ? clean : clean.replace(/^[ab]\//, '')
}
