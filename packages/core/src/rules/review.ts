import { type LanguageModel, type LanguageModelUsage, streamText } from 'ai'
import { MODEL_CALL_HEADERS } from '../models/operations.js'
import { streamParts } from '../models/stream.js'
import { languageOf } from './languages.js'

// 只看这么多 diff，超出的部分不看
const MAX_DIFF_CHARS = 60_000

export interface AnnotatedDiff {
  // 给评审模型看的 diff：新增行和上下文行前面标上新文件的行号
  text: string
  // 每个文件新增或修改过的行号
  addedLines: Map<string, Set<number>>
  truncated: boolean
}

// 只保留代码文件（能识别出语言的），并把 hunk 里的行号算好，弱模型自己数行号很容易错
export function annotateDiff(diff: string): AnnotatedDiff {
  const out: string[] = []
  const addedLines = new Map<string, Set<number>>()
  let path: string | null = null
  let keep = false
  let newLine = 0
  let size = 0
  let truncated = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = null
      keep = false
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim()
      path = target === '/dev/null' ? null : target.replace(/^b\//, '')
      keep = path !== null && languageOf(path) !== null
      if (keep && path) out.push(`=== ${path}`)
      continue
    }
    if (!keep || !path || line.startsWith('--- ') || line.startsWith('index ')) continue
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      newLine = Number(hunk[1])
      out.push(line)
      continue
    }
    let rendered: string
    if (line.startsWith('+')) {
      rendered = `${String(newLine).padStart(5)} + ${line.slice(1)}`
      let set = addedLines.get(path)
      if (!set) addedLines.set(path, (set = new Set()))
      set.add(newLine)
      newLine++
    } else if (line.startsWith(' ')) {
      rendered = `${String(newLine).padStart(5)}   ${line.slice(1)}`
      newLine++
    } else if (line.startsWith('-')) {
      rendered = `      - ${line.slice(1)}`
    } else {
      continue
    }
    if (size + rendered.length > MAX_DIFF_CHARS) {
      truncated = true
      break
    }
    size += rendered.length + 1
    out.push(rendered)
  }
  return { text: out.join('\n'), addedLines, truncated }
}

export async function callReviewer(
  model: LanguageModel,
  request: { system: string; prompt: string },
  signal: AbortSignal,
): Promise<{ text: string; usage: LanguageModelUsage | null }> {
  const attempt = new AbortController()
  const result = streamText({ model, ...request, maxRetries: 2, abortSignal: AbortSignal.any([signal, attempt.signal]), headers: MODEL_CALL_HEADERS })
  let text = ''
  let usage: LanguageModelUsage | null = null
  for await (const part of streamParts(result.fullStream, () => attempt.abort())) {
    if (part.type === 'text-delta') text += part.text
    if (part.type === 'finish-step') usage = part.usage
  }
  return { text, usage }
}
