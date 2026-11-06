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
