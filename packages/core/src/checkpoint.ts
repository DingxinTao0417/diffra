import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

// 快照、列变化、取 diff、还原都要写仓库的索引文件，同时跑会撞上 index.lock。
// 同一个项目的多个会话共用一个仓库，所以按仓库目录排队，不按实例；排空后从表里删掉
const repoQueues = new Map<string, Promise<void>>()

function exclusive<T>(gitDir: string, task: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? resolve(gitDir).toLowerCase() : resolve(gitDir)
  const run = (repoQueues.get(key) ?? Promise.resolve()).then(task)
  const tail = run.then(
    () => {},
    () => {},
  )
  repoQueues.set(key, tail)
  void tail.then(() => {
    if (repoQueues.get(key) === tail) repoQueues.delete(key)
  })
  return run
}

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
    await exclusive(gitDir, async () => {
      const initialized = await access(join(gitDir, 'HEAD')).then(
        () => true,
        () => false,
      )
      if (initialized) return
      await mkdir(gitDir, { recursive: true })
      await runGit(['init', '--bare', '--quiet', gitDir], workTree)
      for (const [key, value] of REPO_CONFIG) await runGit(['--git-dir', gitDir, 'config', key, value], workTree)
      await mkdir(join(gitDir, 'info'), { recursive: true })
      await writeFile(join(gitDir, 'info', 'exclude'), `${DEFAULT_EXCLUDES.join('\n')}\n`, 'utf8')
    })
    return store
  }

  fingerprint(): Promise<string> {
    return exclusive(this.gitDir, () => this.writeTree())
  }

  snapshot(): Promise<string> {
    return exclusive(this.gitDir, async () => {
      const tree = await this.writeTree()
      const commit = (await this.git(['commit-tree', tree, '-m', 'diffra checkpoint'])).trim()
      await this.git(['update-ref', `refs/diffra/${commit}`, commit])
      return commit
    })
  }

  changesSince(commit: string): Promise<CheckpointChange[]> {
    return exclusive(this.gitDir, async () => {
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
    })
  }

  // 快照之后的改动，unified diff 格式；受保护文件和禁写目录同样不在里面
  diffSince(commit: string): Promise<string> {
    return exclusive(this.gitDir, async () => {
      const current = await this.writeTree()
      return this.git(['diff-tree', '-p', '-r', '--no-renames', '--no-color', '-U3', commit, current])
    })
  }

  // base 里 paths 这些文件换成 source 里的内容（source 里没有的就删掉），其余照旧，存成一个快照提交。
  // 用来把 Git 带进来的文件（拉取、切分支这类挪了 HEAD 的命令）从「智能体改了什么」的基线里扣掉。用临时索引，不碰快照用的那个
  overlay(base: string, source: string, paths: string[]): Promise<{ commit: string; tree: string }> {
    return exclusive(this.gitDir, async () => {
      const env = { GIT_INDEX_FILE: join(this.gitDir, `overlay-${randomUUID()}.index`) }
      try {
        await this.git(['read-tree', base], undefined, env)
        const wanted = new Set(paths)
        const parts = (await this.git(['diff-tree', '-r', '-z', '--no-renames', base, source])).split('\0')
        const entries: string[] = []
        // -z 的输出一条两段：「:旧模式 新模式 旧对象 新对象 状态」和路径
        for (let i = 0; i + 1 < parts.length; i += 2) {
          const [, mode, , object, status] = (parts[i] ?? '').split(' ')
          const path = parts[i + 1] ?? ''
          if (!wanted.has(path)) continue
          entries.push(status === 'D' ? `0 ${'0'.repeat(40)}\t${path}` : `${mode} ${object}\t${path}`)
        }
        if (entries.length > 0) await this.git(['update-index', '-z', '--index-info'], `${entries.join('\0')}\0`, env)
        const tree = (await this.git(['write-tree'], undefined, env)).trim()
        const commit = (await this.git(['commit-tree', tree, '-m', 'diffra git baseline'])).trim()
        await this.git(['update-ref', `refs/diffra/${commit}`, commit])
        return { commit, tree }
      } finally {
        await rm(env.GIT_INDEX_FILE, { force: true })
      }
    })
  }

  // 两个快照之间变了的文件
  changedPaths(from: string, to: string): Promise<string[]> {
    return exclusive(this.gitDir, async () => (await this.git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to])).split('\0').filter(Boolean))
  }

  // 只动 changesSince 列出的文件：改过和删掉的恢复成快照里的内容，快照之后新建的删掉
  restore(commit: string, changes: CheckpointChange[]): Promise<void> {
    return exclusive(this.gitDir, async () => {
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
    })
  }

  private async writeTree(): Promise<string> {
    await this.git(['add', '--all', '--', '.', ...this.excludes])
    return (await this.git(['write-tree'])).trim()
  }

  private git(args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
    return runGit(['--git-dir', this.gitDir, '--work-tree', this.workTree, ...args], this.workTree, input, env)
  }
}

// 跑一条 git 命令，返回完整的标准输出（不截断），退出码非 0 时报错带上标准错误
export function runGit(args: string[], cwd: string, input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...GIT_ENV, ...env }, windowsHide: true })
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
