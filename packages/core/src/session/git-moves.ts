import { runGit } from '../checkpoint.js'

// 只读项目自己的 Git 仓库（不是检查点仓库）；不拿可选锁，免得和用户同时跑的 git 抢 index.lock
const READ_ENV = { GIT_OPTIONAL_LOCKS: '0' }

// 项目当前的 HEAD；不是 Git 仓库、还没有提交或没装 git 时返回 null
export async function projectHead(cwd: string): Promise<string | null> {
  try {
    return (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], cwd, undefined, READ_ENV)).trim() || null
  } catch {
    return null
  }
}

// HEAD 从 before 挪到 after 时 Git 带进来的文件：两次提交之间变了、现在工作区里又和 after 一模一样的（没有未提交的改动，也没有同名的未跟踪文件）。
// 路径相对项目目录（检查点按项目目录记），项目在仓库的子目录里时只算这个子目录下的
export async function gitBroughtPaths(cwd: string, before: string, after: string): Promise<string[]> {
  const git = (args: string[]) => runGit(args, cwd, undefined, READ_ENV)
  // diff 和 status --porcelain 的路径都相对仓库根目录
  const prefix = (await git(['rev-parse', '--show-prefix'])).trim()
  const changed = (await git(['diff', '--name-only', '-z', '--no-renames', before, after])).split('\0').filter((path) => path && path.startsWith(prefix))
  if (changed.length === 0) return []
  // porcelain -z 每条是「XY 路径」，关了改名检测就没有第二段旧路径
  const dirty = new Set((await git(['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', '--', '.'])).split('\0').filter(Boolean).map((entry) => entry.slice(3)))
  return changed.filter((path) => !dirty.has(path)).map((path) => path.slice(prefix.length))
}
