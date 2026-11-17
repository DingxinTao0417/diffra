import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isProtectedFile, isUnderReadOnly } from './protected.js'
import { ToolError, type ToolContext, type ToolOutput } from './types.js'
import { realpathOfExisting, resolveToolPath } from './workspace.js'

// 改文件只有这一个工具，补丁格式和 Codex 的 apply_patch 一样（第 507 步）：
//   *** Begin Patch
//   *** Add File: <路径>          新文件，后面每行都以 + 开头
//   *** Delete File: <路径>
//   *** Update File: <路径>
//   *** Move to: <新路径>          可选，改名
//   @@ <定位用的一行，可选>
//    上下文行（空格开头）
//   -删掉的行
//   +加上的行
//   *** End of File               可选：这一块必须贴着文件末尾
//   *** End Patch
// 解析宽松（标记行先去掉首尾空白、能剥掉 heredoc 外壳、空行当成上下文）；匹配逐级放宽（完全一致 → 忽略行尾空白 → 忽略首尾空白 → 统一引号破折号），上下文行保留文件原样。
// 所有改动先在内存里算完，有一处对不上就整份不写；再逐个写盘，每个文件原来的换行符（CRLF/LF）保留

export const APPLY_PATCH_DESCRIPTION = [
  'Edit files by applying a patch. This is the only way to create, change, delete or rename files. The patch format:',
  '*** Begin Patch',
  '*** Add File: path/to/new.ts',
  '+first line of the new file',
  '*** Update File: path/to/existing.ts',
  '@@ optional line near the change, such as a function signature',
  ' unchanged context line',
  '-line to remove',
  '+line to add',
  '*** Delete File: path/to/old.ts',
  '*** End Patch',
  'Rules: paths are relative to the project directory. Give about 3 lines of unchanged context before and after each change so it can be located; use @@ lines to pick the right place when the context repeats. ' +
    'Every line inside an Update hunk starts with a space, - or +. Add "*** Move to: new/path" right after an Update File line to rename. Several files can be changed in one patch.',
].join('\n')

type Hunk = { header: string | null; lines: Array<{ kind: ' ' | '-' | '+'; text: string }>; endOfFile: boolean }
type FileOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; hunks: Hunk[] }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'

// 模型常把补丁包在 heredoc 里（apply_patch <<'EOF' ... EOF），剥掉外壳只留补丁本身
export function unwrapPatch(input: string): string {
  const lines = input.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => line.trim() === BEGIN)
  const end = lines.findLastIndex((line) => line.trim() === END)
  if (start < 0 || end <= start) throw new ToolError(`The patch must start with "${BEGIN}" and end with "${END}".`)
  return lines.slice(start, end + 1).join('\n')
}

// 命令里写的是 apply_patch <<'EOF' … EOF（可以带 cd 目录 &&）：当成补丁处理，不起 shell。返回补丁和目录，不是就返回 null
export function patchFromCommand(command: string): { patch: string; workdir: string | null } | null {
  const match = /^\s*(?:cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*)?(?:apply_patch|applypatch)\s*<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\2\s*$/.exec(command)
  if (!match) return null
  const dir = match[1]?.replace(/^["']|["']$/g, '') ?? null
  return { patch: match[3]!, workdir: dir }
}

export function parsePatch(input: string): FileOp[] {
  const lines = unwrapPatch(input).split('\n')
  const ops: FileOp[] = []
  let index = 1
  const marker = (line: string, prefix: string) => (line.trim().startsWith(prefix) ? line.trim().slice(prefix.length).trim() : null)
  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === END) break
    if (line.trim() === '') {
      index++
      continue
    }
    const add = marker(line, '*** Add File:')
    const del = marker(line, '*** Delete File:')
    const update = marker(line, '*** Update File:')
    if (add !== null) {
      index++
      const body: string[] = []
      while (index < lines.length && !lines[index]!.trim().startsWith('*** ')) {
        const current = lines[index]!
        if (!current.startsWith('+')) throw new ToolError(`Line ${index + 1}: every line of an added file must start with "+".`)
        body.push(current.slice(1))
        index++
      }
      ops.push({ kind: 'add', path: add, content: body.length > 0 ? `${body.join('\n')}\n` : '' })
      continue
    }
    if (del !== null) {
      ops.push({ kind: 'delete', path: del })
      index++
      continue
    }
    if (update !== null) {
      index++
      let moveTo: string | null = null
      const move = index < lines.length ? marker(lines[index]!, '*** Move to:') : null
      if (move !== null) {
        moveTo = move
        index++
      }
      const hunks: Hunk[] = []
      let hunk: Hunk | null = null
      while (index < lines.length) {
        const current = lines[index]!
        const trimmed = current.trim()
        if (trimmed === END || (trimmed.startsWith('*** ') && trimmed !== '*** End of File')) break
        if (trimmed === '*** End of File') {
          if (hunk) hunk.endOfFile = true
          index++
          continue
        }
        if (current.startsWith('@@')) {
          hunk = { header: current.slice(2).trim() || null, lines: [], endOfFile: false }
          hunks.push(hunk)
          index++
          continue
        }
        if (!hunk) {
          hunk = { header: null, lines: [], endOfFile: false }
          hunks.push(hunk)
        }
        const kind = current[0]
        if (kind === ' ' || kind === '-' || kind === '+') hunk.lines.push({ kind, text: current.slice(1) })
        else if (current === '') hunk.lines.push({ kind: ' ', text: '' })
        else throw new ToolError(`Line ${index + 1}: lines in an Update File hunk must start with a space, "-" or "+": ${current}`)
        index++
      }
      if (hunks.every((item) => item.lines.length === 0) && moveTo === null) throw new ToolError(`Update File ${update} has no changes.`)
      ops.push({ kind: 'update', path: update, moveTo, hunks: hunks.filter((item) => item.lines.length > 0) })
      continue
    }
    throw new ToolError(`Line ${index + 1}: expected "*** Add File:", "*** Update File:", "*** Delete File:" or "${END}", got: ${line}`)
  }
  if (ops.length === 0) throw new ToolError('The patch has no file operations.')
  return ops
}

// 逐级放宽的比较：完全一致、忽略行尾空白、忽略首尾空白、把弯引号和各种破折号当成普通的
const PUNCTUATION: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/ /g, ' '],
]
const COMPARERS: Array<(line: string) => string> = [
  (line) => line,
  (line) => line.trimEnd(),
  (line) => line.trim(),
  (line) => PUNCTUATION.reduce((text, [pattern, to]) => text.replace(pattern, to), line.trim()),
]

function findLines(haystack: string[], needle: string[], from: number, atEnd: boolean): number {
  if (needle.length === 0) return -1
  for (const compare of COMPARERS) {
    const target = needle.map(compare)
    if (atEnd) {
      const start = haystack.length - needle.length
      if (start >= from && target.every((line, offset) => compare(haystack[start + offset]!) === line)) return start
      continue
    }
    for (let start = from; start + needle.length <= haystack.length; start++) {
      if (target.every((line, offset) => compare(haystack[start + offset]!) === line)) return start
    }
  }
  return -1
}

function applyHunks(path: string, original: string, hunks: Hunk[]): string {
  const crlf = original.includes('\r\n')
  const lines = original.replace(/\r\n/g, '\n').split('\n')
  const trailingNewline = lines.at(-1) === ''
  if (trailingNewline) lines.pop()
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.header) {
      const at = findLines(lines, [hunk.header], cursor, false)
      if (at < 0) throw new ToolError(`${path}: could not find the @@ line "${hunk.header}".`)
      cursor = at + 1
    }
    const before = hunk.lines.filter((line) => line.kind !== '+').map((line) => line.text)
    const after = hunk.lines.filter((line) => line.kind !== '-').map((line) => line.text)
    if (before.length === 0) {
      // 只有加的行、没有上下文：有 @@ 就加在那一行后面，没有就加在文件末尾
      const at = hunk.header ? cursor : lines.length
      lines.splice(at, 0, ...after)
      cursor = at + after.length
      continue
    }
    const at = findLines(lines, before, cursor, hunk.endOfFile)
    if (at < 0) {
      throw new ToolError(`${path}: these lines were not found${hunk.header ? ` after "${hunk.header}"` : ''}:\n${before.join('\n')}\nCheck the current file content (for example with sed -n) and copy the lines exactly.`)
    }
    // 上下文行留文件里原来的样子：放宽匹配时补丁里的上下文可能少了行尾空白、引号不一样，不能顺手改掉没要改的行
    const matched = lines.slice(at, at + before.length)
    let position = 0
    const replacement: string[] = []
    for (const line of hunk.lines) {
      if (line.kind === '+') replacement.push(line.text)
      else {
        if (line.kind === ' ') replacement.push(matched[position]!)
        position++
      }
    }
    lines.splice(at, before.length, ...replacement)
    cursor = at + replacement.length
  }
  const text = lines.join('\n') + (trailingNewline ? '\n' : '')
  return crlf ? text.replace(/\n/g, '\r\n') : text
}

type PatchTarget = { display: string; absolute: string; key: string; fileKey: string | null }
type Planned = PatchTarget & { oldText: string | null; newText: string | null }

// 不同会话也共用；整批按真实路径排序取锁，避免交叉改名或多文件补丁互相等待
const pathLocks = new Map<string, Promise<void>>()
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path

async function physicalFileKey(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true })
    return info.ino === 0n ? null : `inode:${info.dev}:${info.ino}`
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

async function lockPaths(keys: string[]): Promise<() => void> {
  const releases: Array<() => void> = []
  for (const key of [...new Set(keys)].sort()) {
    const previous = pathLocks.get(key)
    const locked = new Promise<void>((unlock) => {
      releases.push(() => {
        unlock()
        if (pathLocks.get(key) === locked) pathLocks.delete(key)
      })
    })
    pathLocks.set(key, locked)
    await previous
  }
  return () => { for (const release of releases.reverse()) release() }
}

export async function applyPatchTool(context: ToolContext, input: { input: string }, workdir: string | null = null): Promise<ToolOutput> {
  const ops = parsePatch(input.input)
  const base = workdir ? { ...context, cwd: (await resolveToolPath(context, workdir, 'read')).absolute } : context
  const realRoot = await realpathOfExisting(context.cwd)
  const planned: Planned[] = []
  const seen = new Set<string>()
  const target = async (path: string): Promise<PatchTarget> => {
    const resolved = await resolveToolPath(base, path, 'write')
    const realPath = await realpathOfExisting(resolved.absolute)
    if (isProtectedFile(resolved.display) || isProtectedFile(realPath)) {
      throw new ToolError(`${resolved.display} is protected because it may contain secrets. Diffra does not let you change it; ask the user if you need something there.`)
    }
    if (isUnderReadOnly(context.cwd, resolved.absolute, context.readOnlyPaths) || isUnderReadOnly(realRoot, realPath, context.readOnlyPaths)) {
      throw new ToolError(`${resolved.display} is inside a directory the user marked as read-only (${context.readOnlyPaths.join(', ')}). Do not change anything there; ask the user if the task needs it.`)
    }
    const key = pathKey(realPath)
    // realpath 统一符号链接，文件标识再覆盖硬链接指向同一个物理文件的情况
    const fileKey = await physicalFileKey(realPath)
    if (seen.has(key) || (fileKey !== null && seen.has(fileKey))) throw new ToolError(`The patch changes ${resolved.display} more than once. Put all changes to a file in one Update File section.`)
    seen.add(key)
    if (fileKey !== null) seen.add(fileKey)
    context.beforeWrite?.({ absolute: realPath, display: resolved.display })
    return { ...resolved, key, fileKey }
  }
  const current = (absolute: string) =>
    readFile(absolute, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    })
  const prepared: Array<{ op: FileOp; resolved: PatchTarget; moved: PatchTarget | null }> = []
  for (const op of ops) {
    const resolved = await target(op.path)
    const moved = op.kind === 'update' && op.moveTo ? await target(op.moveTo) : null
    prepared.push({ op, resolved, moved })
  }
  const targets = prepared.flatMap(({ resolved, moved }) => moved ? [resolved, moved] : [resolved])
  const verifyPath = async (item: PatchTarget) => {
    if (pathKey(await realpathOfExisting(item.absolute)) !== item.key || (item.fileKey !== null && await physicalFileKey(item.absolute) !== item.fileKey)) {
      throw new ToolError(`${item.display}: the path changed while preparing the patch. Check the current path and try again.`)
    }
  }
  const verifyOriginal = async (item: Planned) => {
    await verifyPath(item)
    if (await current(item.absolute) !== item.oldText) {
      throw new ToolError(`${item.display}: the file changed while preparing the patch. Read the current content and apply a new patch.`)
    }
  }
  const release = await lockPaths(targets.flatMap((item) => item.fileKey === null ? [item.key] : [item.key, item.fileKey]))
  try {
    for (const item of targets) await verifyPath(item)
    // 锁内再读原文、匹配 hunk；另一会话先写完后不能再拿旧版本覆盖
    for (const { op, resolved, moved } of prepared) {
      const existing = await current(resolved.absolute)
      if (op.kind === 'add') {
        if (existing !== null) throw new ToolError(`${resolved.display} already exists. Use "*** Update File:" to change it.`)
        planned.push({ ...resolved, oldText: null, newText: op.content })
      } else if (op.kind === 'delete') {
        if (existing === null) throw new ToolError(`${resolved.display} does not exist, so it cannot be deleted.`)
        planned.push({ ...resolved, oldText: existing, newText: null })
      } else {
        if (existing === null) throw new ToolError(`${resolved.display} does not exist. Use "*** Add File:" to create it.`)
        const updated = applyHunks(resolved.display, existing, op.hunks)
        if (moved) {
          if ((await current(moved.absolute)) !== null) throw new ToolError(`${moved.display} already exists; cannot move ${resolved.display} there.`)
          planned.push({ ...moved, oldText: null, newText: updated })
          planned.push({ ...resolved, oldText: existing, newText: null })
        } else {
          planned.push({ ...resolved, oldText: existing, newText: updated })
        }
      }
    }
    // 先整批复核，防止计划期间工具以外的写入被覆盖；落盘前也再检查一次
    for (const item of planned) await verifyOriginal(item)
    for (const item of planned) {
      if (item.newText === null) {
        await verifyOriginal(item)
        await rm(item.absolute, { force: true })
      } else {
        await mkdir(dirname(item.absolute), { recursive: true })
        await verifyOriginal(item)
        await writeFile(item.absolute, item.newText, 'utf8')
      }
    }
  } finally {
    release()
  }
  const summary = planned.map((item) => `${item.oldText === null ? 'A' : item.newText === null ? 'D' : 'M'} ${item.display}`)
  return {
    text: `Success. Updated the following files:\n${summary.join('\n')}`,
    title: `${planned.length === 1 ? (planned[0]!.oldText === null ? '新建' : planned[0]!.newText === null ? '删除' : '编辑') : '修改'} ${planned.map((item) => item.display).join('、')}`,
    // 删除的文件在界面上照样是一张改动卡片：新内容为空
    diffs: planned.map((item) => ({ path: item.absolute, oldText: item.oldText, newText: item.newText ?? '', ...(item.newText === null ? { deleted: true } : {}) })),
    edited: true,
  }
}
