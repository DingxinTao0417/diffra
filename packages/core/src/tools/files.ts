import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runProcess, truncateLines } from '../process.js'
import { applyEdit } from './edit-match.js'
import { isProtectedFile, isUnderReadOnly, PROTECTED_GLOBS } from './protected.js'
import { similarPaths } from './suggest.js'
import { ToolError, type ToolContext, type ToolOutput } from './types.js'
import { contentHash, resolveToolPath } from './workspace.js'

function protectedFileError(display: string): ToolError {
  return new ToolError(
    `${display} is protected because it may contain secrets. Diffra does not let you read, search or edit it. ` +
      'If you need something from it, ask the user.',
  )
}

const MAX_READ_BYTES = 2 * 1024 * 1024
const DEFAULT_READ_LINES = 400
const MAX_READ_LINES = 2000
const MAX_LINE_CHARS = 2000
const MAX_LISTED_FILES = 500
const RG_TIMEOUT_MS = 30_000

export async function readFileTool(
  context: ToolContext,
  input: { path: string; offset?: number; limit?: number },
): Promise<ToolOutput> {
  const target = await resolveToolPath(context, input.path, 'read')
  if (isProtectedFile(target.display)) throw protectedFileError(target.display)
  const info = await stat(target.absolute).catch(() => null)
  if (!info) throw new ToolError(`File not found: ${target.display}.${await didYouMean(context, target.display)}`)
  if (info.isDirectory()) throw new ToolError(`${target.display} is a directory. Use list_files instead.`)
  if (info.size > MAX_READ_BYTES) {
    throw new ToolError(`${target.display} is too large (${info.size} bytes). Use search to find the relevant part.`)
  }
  const buffer = await readFile(target.absolute)
  if (buffer.subarray(0, 8000).includes(0)) throw new ToolError(`${target.display} looks like a binary file.`)

  const text = buffer.toString('utf8')
  context.readHashes.set(target.absolute, contentHash(text))
  const title = `读取 ${target.display}`
  if (text === '') return { text: `${target.display} is empty.`, title }

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const start = Math.max(1, input.offset ?? 1)
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_READ_LINES), MAX_READ_LINES)
  const end = Math.min(lines.length, start + limit - 1)
  if (start > lines.length) throw new ToolError(`${target.display} has only ${lines.length} lines.`)

  const body = lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} ...(line truncated)` : line}`)
    .join('\n')
  const more = end < lines.length ? `\n... ${lines.length - end} more lines. Use offset=${end + 1} to continue.` : ''
  return { text: `${target.display} (lines ${start}-${end} of ${lines.length})\n${body}${more}`, title }
}

export async function listFilesTool(context: ToolContext, input: { path?: string }): Promise<ToolOutput> {
  const target = await resolveToolPath(context, input.path ?? '.', 'read')
  const result = await runProcess(
    context.rgPath,
    ['--files', '--hidden', '--glob', '!.git', '--path-separator', '/', '--', target.display],
    { cwd: context.cwd, timeoutMs: RG_TIMEOUT_MS, signal: context.signal },
  )
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new ToolError(`list_files failed: ${result.output.trim()}`)
  const files = result.output.split(/\r?\n/).filter(Boolean).sort()
  const shown = files.slice(0, MAX_LISTED_FILES)
  const note =
    files.length > MAX_LISTED_FILES ? `\n... ${files.length - MAX_LISTED_FILES} more files. List a subdirectory to see them.` : ''
  return {
    text: files.length === 0 ? `No files under ${target.display} (ignored files are skipped).` : `${shown.join('\n')}${note}`,
    title: `列出 ${target.display}`,
  }
}

export async function searchTool(
  context: ToolContext,
  input: { pattern: string; path?: string; glob?: string; literal?: boolean },
): Promise<ToolOutput> {
  const target = await resolveToolPath(context, input.path ?? '.', 'read')
  if (isProtectedFile(target.display)) throw protectedFileError(target.display)
  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--hidden',
    '--glob',
    '!.git',
    '--smart-case',
    '--max-columns',
    '300',
    '--max-columns-preview',
    '--max-count',
    '20',
    '--path-separator',
    '/',
  ]
  // 只用排除规则：rg 里出现任何正向 glob 就会变成「只搜匹配的文件」
  for (const glob of PROTECTED_GLOBS) args.push('--glob', `!${glob}`)
  if (input.literal) args.push('--fixed-strings')
  if (input.glob) args.push('--glob', input.glob)
  args.push('--', input.pattern, target.display)

  const result = await runProcess(context.rgPath, args, { cwd: context.cwd, timeoutMs: RG_TIMEOUT_MS, signal: context.signal })
  if (result.exitCode === 1) return { text: 'No matches.', title: `搜索 ${input.pattern}` }
  if (result.exitCode !== 0) throw new ToolError(`search failed: ${result.output.trim()}`)
  return { text: truncateLines(result.output.trim(), 200, 20_000), title: `搜索 ${input.pattern}` }
}

export async function editFileTool(
  context: ToolContext,
  input: { path: string; old_string: string; new_string: string; replace_all?: boolean },
): Promise<ToolOutput> {
  const target = await resolveToolPath(context, input.path, 'write')
  if (isProtectedFile(target.display)) throw protectedFileError(target.display)
  if (isUnderReadOnly(context.cwd, target.absolute, context.readOnlyPaths)) {
    throw new ToolError(
      `${target.display} is inside a directory the user marked as read-only (${context.readOnlyPaths.join(', ')}). ` +
        'Do not change anything there; ask the user if the task needs it.',
    )
  }
  context.beforeWrite?.(target)
  const existing = await readFile(target.absolute, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  })

  if (input.old_string === '') {
    if (existing !== null) {
      throw new ToolError(`${target.display} already exists. Read it, then pass the text to replace in old_string.`)
    }
    await mkdir(dirname(target.absolute), { recursive: true })
    await writeFile(target.absolute, input.new_string, 'utf8')
    context.readHashes.set(target.absolute, contentHash(input.new_string))
    return {
      text: `Created ${target.display}.`,
      title: `新建 ${target.display}`,
      diff: { path: target.absolute, oldText: null, newText: input.new_string },
      edited: true,
    }
  }

  if (existing === null) {
    throw new ToolError(`File not found: ${target.display}.${await didYouMean(context, target.display)} To create it, pass an empty old_string.`)
  }
  const known = context.readHashes.get(target.absolute)
  if (known === undefined) throw new ToolError(`Read ${target.display} with read_file before editing it.`)
  if (known !== contentHash(existing)) {
    throw new ToolError(`${target.display} changed since you last read it. Read it again before editing.`)
  }

  const crlf = existing.includes('\r\n')
  const normalize = (text: string) => text.replace(/\r\n/g, '\n')
  const oldString = normalize(input.old_string)
  const newString = normalize(input.new_string)
  if (oldString === newString) throw new ToolError('old_string and new_string are identical; nothing to change.')

  const match = applyEdit(normalize(existing), oldString, newString, input.replace_all ?? false)
  if (match.kind === 'multiple') {
    throw new ToolError(
      `old_string matches ${match.lines.length} places in ${target.display} (lines ${match.lines.join(', ')}). ` +
        'Include more surrounding lines to make it unique, or set replace_all to true.',
    )
  }
  if (match.kind === 'none') {
    const hint = match.closest
      ? `\nClosest text (lines ${match.closest.startLine}-${match.closest.endLine}):\n${match.closest.snippet}\n` +
        'Copy the exact text from read_file output, without the line numbers.'
      : ' Read the file again and copy the exact text.'
    throw new ToolError(`old_string was not found in ${target.display}.${hint}`)
  }

  const updated = crlf ? match.content.replace(/\n/g, '\r\n') : match.content
  await writeFile(target.absolute, updated, 'utf8')
  context.readHashes.set(target.absolute, contentHash(updated))
  const fuzzyNote = match.fuzzy ? ' (matched ignoring indentation and trailing whitespace)' : ''
  return {
    text:
      `Edited ${target.display}: replaced ${match.count} occurrence(s)${fuzzyNote}.\n` +
      excerpt(match.content, match.firstLine, newString.split('\n').length),
    title: `编辑 ${target.display}`,
    diff: { path: target.absolute, oldText: existing, newText: updated },
    edited: true,
  }
}

async function didYouMean(context: ToolContext, display: string): Promise<string> {
  const paths = await similarPaths(context, display)
  return paths.length > 0 ? ` Did you mean: ${paths.join(', ')}?` : ''
}

// 返回改动附近的几行，让模型确认改对了，不用再读一遍整个文件
function excerpt(content: string, firstLine: number, changedLines: number): string {
  const lines = content.split('\n')
  const from = Math.max(1, firstLine - 2)
  const to = Math.min(lines.length, firstLine + Math.min(changedLines, 12) + 1)
  const body = lines
    .slice(from - 1, to)
    .map((line, index) => `${from + index}\t${line}`)
    .join('\n')
  return `Lines ${from}-${to} after the edit:\n${body}`
}
