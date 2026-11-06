import { spawn } from 'node:child_process'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CheckpointChange } from './protocol.js'
import { cleanReadOnlyPath, PROTECTED_GLOBS } from './tools/protected.js'

const GIT_TIMEOUT_MS = 120_000
// 快照不经过用户的 git 配置：身份写死，换行符原样保存
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Diffra',
  GIT_AUTHOR_EMAIL: 'checkpoint@diffra.local',
  GIT_COMMITTER_NAME: 'Diffra',
  GIT_COMMITTER_EMAIL: 'checkpoint@diffra.local',
}
const REPO_CONFIG: Array<[string, string]> = [
  ['core.autocrlf', 'false'],
  ['core.safecrlf', 'false'],
  ['core.quotepath', 'false'],
  ['core.longpaths', 'true'],
  // 快照提交只靠 refs/diffra/* 保留，关掉自动 gc 以免误删
  ['gc.auto', '0'],
]
const DEFAULT_EXCLUDES = ['node_modules/']

// 检查点存在应用数据目录下的独立裸仓库里，用 --work-tree 指向项目，不碰项目自己的 .git。
// 受保护文件和禁写目录不进快照：密钥不会被复制到快照仓库，撤销时也不会还原用户在这些地方的改动。
export class Checkpoints {
  private readonly excludes: string[]

  private constructor(
    private readonly gitDir: string,
    private readonly workTree: string,
    readOnlyPaths: string[],
  ) {
    this.excludes = [
      ...PROTECTED_GLOBS.map((glob) => `:(exclude,glob)**/${glob}`),
      ...readOnlyPaths.map(cleanReadOnlyPath).filter(Boolean).map((path) => `:(exclude,literal)${path}`),
    ]
  }

  static async open(gitDir: string, workTree: string, readOnlyPaths: string[] = []): Promise<Checkpoints> {
    const store = new Checkpoints(gitDir, workTree, readOnlyPaths)
    const initialized = await access(join(gitDir, 'HEAD')).then(
      () => true,
      () => false,
    )
    if (!initialized) {
      await mkdir(gitDir, { recursive: true })
      await runGit(['init', '--bare', '--quiet', gitDir], workTree)
      for (const [key, value] of REPO_CONFIG) await runGit(['--git-dir', gitDir, 'config', key, value], workTree)
      await mkdir(join(gitDir, 'info'), { recursive: true })
      await writeFile(join(gitDir, 'info', 'exclude'), `${DEFAULT_EXCLUDES.join('\n')}\n`, 'utf8')
    }
    return store
  }

  async snapshot(): Promise<string> {
    const tree = await this.writeTree()
    const commit = (await this.git(['commit-tree', tree, '-m', 'diffra checkpoint'])).trim()
    await this.git(['update-ref', `refs/diffra/${commit}`, commit])
    return commit
  }

  async changesSince(commit: string): Promise<CheckpointChange[]> {
    const current = await this.writeTree()
    const output = await this.git(['diff-tree', '-r', '--no-renames', '--name-status', '-z', commit, current])
    const parts = output.split('\0').filter(Boolean)
    const changes: CheckpointChange[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i] ?? ''
      const path = parts[i + 1] ?? ''
      changes.push({ path, change: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified' })
    }
    return changes
  }

  // 快照之后的改动，unified diff 格式；受保护文件和禁写目录同样不在里面
  async diffSince(commit: string): Promise<string> {
    const current = await this.writeTree()
    return this.git(['diff-tree', '-p', '-r', '--no-renames', '--no-color', '-U3', commit, current])
  }

  // 只动 changesSince 列出的文件：改过和删掉的恢复成快照里的内容，快照之后新建的删掉
  async restore(commit: string, changes: CheckpointChange[]): Promise<void> {
    const restorable = changes.filter((item) => item.change !== 'added').map((item) => item.path)
    if (restorable.length > 0) {
      await this.git(['checkout', commit, '--pathspec-from-file=-', '--pathspec-file-nul'], restorable.join('\0'))
    }
    for (const item of changes.filter((change) => change.change === 'added')) {
      const target = resolve(this.workTree, item.path)
      const inside = relative(this.workTree, target)
      if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`检查点路径不在项目内：${item.path}`)
      await rm(target, { force: true })
    }
  }

  private async writeTree(): Promise<string> {
    await this.git(['add', '--all', '--', '.', ...this.excludes])
    return (await this.git(['write-tree'])).trim()
  }

  private git(args: string[], input?: string): Promise<string> {
    return runGit(['--git-dir', this.gitDir, '--work-tree', this.workTree, ...args], this.workTree, input)
  }
}

function runGit(args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString('utf8'))
      else reject(new Error(`git ${args.join(' ')} 失败（${code}）：${Buffer.concat(stderr).toString('utf8').trim()}`))
    })
    child.stdin.end(input ?? '')
  })
}
