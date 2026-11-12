import { execFile } from 'node:child_process'
import { isAbsolute, relative } from 'node:path'
import { promisify } from 'node:util'
import { listSessions } from '@diffra/core'
import { coreConnection } from './core-process'

const execFileAsync = promisify(execFile)
const READ_TIMEOUT_MS = 5000
const SWITCH_TIMEOUT_MS = 30_000
// 只认普通的本地分支名：不以 - 开头（不会被 git 当成选项）、没有 ..
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/

async function git(cwd: string, args: string[], timeout = READ_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout, windowsHide: true })
  return stdout.trim()
}

// 当前分支名，分离头指针时是提交号；不是 git 仓库或没装 git 时为 null。
// symbolic-ref 在还没有提交的新仓库里也能拿到分支名
export async function currentBranch(cwd: string): Promise<string | null> {
  const read = (args: string[]) => git(cwd, args).then((output) => output || null, () => null)
  return (await read(['symbolic-ref', '--short', '-q', 'HEAD'])) ?? (await read(['rev-parse', '--short', 'HEAD']))
}

// 本地分支（任务页底栏的分支菜单）；不是 git 仓库时是空的
export async function listBranches(cwd: string): Promise<{ current: string | null; branches: string[] }> {
  const output = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => '')
  return { current: await currentBranch(cwd), branches: output.split('\n').filter(Boolean).sort((a, b) => a.localeCompare(b)) }
}

// 切换到一个本地分支（本机和「可查看和操作」的远程设备都走这里）。项目里有任务在跑、工作区有未提交的改动时不切：
// 不替用户暂存或丢弃改动，也不在智能体改文件的时候把文件换掉
export async function switchBranch(cwd: string, branch: string): Promise<void> {
  if (!BRANCH_NAME.test(branch)) throw new Error('分支名不对')
  const { current, branches } = await listBranches(cwd)
  if (branch === current) return
  if (!branches.includes(branch)) throw new Error(`没有本地分支 ${branch}`)
  const sessions = await listSessions(await coreConnection())
  const inside = (path: string) => {
    const rel = relative(cwd, path)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  if (sessions.some((session) => session.running && inside(session.cwd))) throw new Error('项目里有任务在跑，跑完再切换分支')
  if (await git(cwd, ['status', '--porcelain'])) throw new Error('工作区有未提交的改动，先提交或暂存再切换分支')
  await git(cwd, ['switch', branch], SWITCH_TIMEOUT_MS).catch((error: unknown) => {
    throw new Error(`切换分支失败：${error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : String(error)}`)
  })
}
