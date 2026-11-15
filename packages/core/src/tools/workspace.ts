import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isProtectedFile } from './protected.js'
import { ToolError, type ToolContext } from './types.js'

export interface WorkspacePath {
  absolute: string
  // 相对项目根目录、用 / 分隔，给模型和界面看
  display: string
}

// 只允许项目目录里的路径；符号链接解析后也必须还在项目里
export async function resolveInWorkspace(root: string, input: string): Promise<WorkspacePath> {
  const absolute = resolve(root, fromMsysPath(input))
  if (!isInside(relative(root, absolute))) throw new ToolError(`Path is outside the project: ${input}`)
  const realRoot = await realpath(root)
  const realTarget = await realpathOfExisting(absolute)
  if (!isInside(relative(realRoot, realTarget))) {
    throw new ToolError(`Path resolves outside the project through a symlink: ${input}`)
  }
  return { absolute, display: relative(root, absolute).split(sep).join('/') || '.' }
}

// 只读工具用：项目里的路径照常；项目外的绝对路径落在 readRoots 某个目录里也可以
export async function resolveReadable(root: string, readRoots: string[], input: string): Promise<WorkspacePath> {
  try {
    return await resolveInWorkspace(root, input)
  } catch (error) {
    const absolute = resolve(root, fromMsysPath(input))
    if (!(error instanceof ToolError) || !isAbsolute(fromMsysPath(input))) throw error
    for (const readRoot of readRoots) {
      const realRoot = await realpath(readRoot).catch(() => null)
      if (!realRoot) continue
      if (isInside(relative(realRoot, await realpathOfExisting(absolute)))) return { absolute, display: absolute.split(sep).join('/') }
    }
    throw error
  }
}

// 授权只覆盖规范化后的确切目标，不把整个磁盘或父目录加入允许列表。
export async function resolveToolPath(context: ToolContext, input: string, access: 'read' | 'write'): Promise<WorkspacePath> {
  const requested = resolve(context.cwd, fromMsysPath(input))
  const absolute = await realpathOfExisting(requested)
  const projectRoot = await realpath(context.cwd)
  if (isInside(relative(context.cwd, requested)) && isInside(relative(projectRoot, absolute))) {
    return { absolute: requested, display: relative(context.cwd, requested).split(sep).join('/') || '.' }
  }
  if (access === 'read' && isAbsolute(fromMsysPath(input))) {
    for (const readRoot of context.readRoots) {
      const allowedRoot = await realpathOfExisting(readRoot)
      if (isInside(relative(allowedRoot, absolute))) return { absolute, display: absolute.split(sep).join('/') }
    }
  }
  if (!context.requestExternalPermission) throw new ToolError(`Path is outside the project: ${input}`)
  if (isProtectedFile(absolute)) throw new ToolError('Protected files cannot be accessed, even with external path permission.')
  if (context.signal.aborted) throw new ToolError('External path access was cancelled.')
  if (!await context.requestExternalPermission(absolute, access)) throw new ToolError('The user rejected external path access. Do not retry without new instructions.')
  if (context.signal.aborted) throw new ToolError('External path access was cancelled.')
  const verified = await realpathOfExisting(requested)
  if (verified !== absolute) throw new ToolError('The external path changed during approval. Request access again.')
  return { absolute, display: absolute.split(sep).join('/') }
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// 模型在 Git Bash 里看到的是 /d/workspace/... 这种路径，转成 Windows 路径
export function fromMsysPath(input: string): string {
  if (process.platform !== 'win32') return input
  const match = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(input)
  return match ? `${match[1]}:/${match[3]}` : input
}

function isInside(relativePath: string): boolean {
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

// 目标可能还不存在（新建文件），就解析最近一个存在的上级目录
export async function realpathOfExisting(path: string): Promise<string> {
  let current = path
  for (;;) {
    try {
      return resolve(await realpath(current), relative(current, path))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      const parent = dirname(current)
      if (parent === current) return path
      current = parent
    }
  }
}
