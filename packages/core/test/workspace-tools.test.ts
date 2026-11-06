import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Checkpoints } from '../src/checkpoint.js'
import { findRipgrep } from '../src/environment.js'
import { editFileTool, listFilesTool, readFileTool, searchTool } from '../src/tools/files.js'
import type { ToolContext } from '../src/tools/types.js'

let project: string
let context: ToolContext

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), 'diffra-tools-'))
  context = {
    cwd: project,
    rgPath: await findRipgrep(),
    bashPath: null,
    signal: new AbortController().signal,
    readHashes: new Map(),
    trustedCommands: [],
    readOnlyPaths: [],
    requestCommandPermission: async () => ({ allowed: true }),
  }
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

describe('文件工具', () => {
  test('read_file 返回带行号的内容，并支持分段', async () => {
    writeFileSync(join(project, 'a.txt'), 'one\ntwo\nthree\n')
    const result = await readFileTool(context, { path: 'a.txt', offset: 2, limit: 1 })
    expect(result.text).toBe('a.txt (lines 2-2 of 3)\n2\ttwo\n... 1 more lines. Use offset=3 to continue.')
  })

  test('没读过、读完后被改过的文件都不允许编辑', async () => {
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    await expect(editFileTool(context, { path: 'a.txt', old_string: 'hello', new_string: 'hi' })).rejects.toThrow('before editing')
    await readFileTool(context, { path: 'a.txt' })
    writeFileSync(join(project, 'a.txt'), 'hello world\n')
    await expect(editFileTool(context, { path: 'a.txt', old_string: 'hello', new_string: 'hi' })).rejects.toThrow('changed since')
  })

  test('编辑保留 CRLF 换行，并返回 diff', async () => {
    writeFileSync(join(project, 'a.txt'), 'a\r\nb\r\nc\r\n')
    await readFileTool(context, { path: 'a.txt' })
    const result = await editFileTool(context, { path: 'a.txt', old_string: 'a\nb', new_string: 'a\nB' })
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('a\r\nB\r\nc\r\n')
    expect(result.diff).toMatchObject({ oldText: 'a\r\nb\r\nc\r\n', newText: 'a\r\nB\r\nc\r\n' })
    expect(result.edited).toBe(true)
  })

  test('old_string 为空时新建文件，已存在则拒绝', async () => {
    await editFileTool(context, { path: 'src/new.ts', old_string: '', new_string: 'export {}\n' })
    expect(readFileSync(join(project, 'src', 'new.ts'), 'utf8')).toBe('export {}\n')
    await expect(editFileTool(context, { path: 'src/new.ts', old_string: '', new_string: 'x' })).rejects.toThrow('already exists')
  })

  test('项目目录以外的路径被拒绝', async () => {
    await expect(readFileTool(context, { path: '../outside.txt' })).rejects.toThrow('outside the project')
  })

  test('list_files 和 search 用 ripgrep，遵守 .gitignore', async () => {
    writeFileSync(join(project, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(project, 'ignored.txt'), 'needle\n')
    writeFileSync(join(project, 'kept.txt'), 'needle here\n')
    // rg 只在 git 仓库里读 .gitignore，用 .ignore 文件模拟同样的效果
    writeFileSync(join(project, '.ignore'), 'ignored.txt\n')
    const listed = await listFilesTool(context, {})
    expect(listed.text).toContain('kept.txt')
    expect(listed.text).not.toContain('ignored.txt\n')
    const found = await searchTool(context, { pattern: 'needle' })
    expect(found.text).toContain('kept.txt:1:needle here')
    expect(found.text).not.toContain('ignored.txt:')
  })
})

describe('检查点', () => {
  test('快照后改、增、删文件，能列出变化并按原样还原', async () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'diffra-cp-'))
    try {
      writeFileSync(join(project, 'keep.txt'), 'keep\r\n')
      writeFileSync(join(project, 'edit.txt'), 'before\r\n')
      writeFileSync(join(project, 'delete.txt'), 'gone soon\n')
      const checkpoints = await Checkpoints.open(gitDir, project)
      const commit = await checkpoints.snapshot()

      writeFileSync(join(project, 'edit.txt'), 'after\n')
      rmSync(join(project, 'delete.txt'))
      writeFileSync(join(project, 'added.txt'), 'new\n')

      const changes = await checkpoints.changesSince(commit)
      expect(changes.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: 'added.txt', change: 'added' },
        { path: 'delete.txt', change: 'deleted' },
        { path: 'edit.txt', change: 'modified' },
      ])

      await checkpoints.restore(commit, changes)
      expect(readFileSync(join(project, 'edit.txt'), 'utf8')).toBe('before\r\n')
      expect(readFileSync(join(project, 'delete.txt'), 'utf8')).toBe('gone soon\n')
      expect(() => readFileSync(join(project, 'added.txt'))).toThrow()
      expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('keep\r\n')
      expect(await checkpoints.changesSince(commit)).toEqual([])
    } finally {
      rmSync(gitDir, { recursive: true, force: true })
    }
  })

  // 同一个项目的多个任务共用一个检查点仓库；界面上任务监控、审阅面板、撤销确认框会同时读改动
  test('同一个仓库上同时快照、列变化、取 diff 不会撞上 git 的索引锁', async () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'diffra-cp-'))
    try {
      for (let index = 0; index < 20; index++) writeFileSync(join(project, `f${index}.txt`), `v${index}\n`)
      const first = await Checkpoints.open(gitDir, project)
      const second = await Checkpoints.open(gitDir, project)
      const commit = await first.snapshot()
      for (let index = 0; index < 20; index++) writeFileSync(join(project, `f${index}.txt`), `changed ${index}\n`)

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) => {
          const store = index % 2 === 0 ? first : second
          return [store.changesSince(commit), store.diffSince(commit), store.snapshot()][index % 3]
        }),
      )
      expect(results.filter((result) => result.status === 'rejected')).toEqual([])
      expect(await second.changesSince(commit)).toHaveLength(20)
    } finally {
      rmSync(gitDir, { recursive: true, force: true })
    }
  })
})

describe('受保护文件和禁写目录', () => {
  test('.env 不能读、不能改，搜索结果里也没有；.env.example 照常可读', async () => {
    writeFileSync(join(project, '.env'), 'API_KEY=super-secret-value\n')
    writeFileSync(join(project, '.env.example'), 'API_KEY=\n')
    writeFileSync(join(project, 'config.ts'), 'export const key = process.env.API_KEY\n')
    await expect(readFileTool(context, { path: '.env' })).rejects.toThrow('protected')
    await expect(editFileTool(context, { path: '.env', old_string: '', new_string: 'X=1' })).rejects.toThrow('protected')
    await expect(searchTool(context, { pattern: 'API_KEY', path: '.env' })).rejects.toThrow('protected')
    const found = await searchTool(context, { pattern: 'API_KEY' })
    expect(found.text).toContain('config.ts')
    expect(found.text).not.toContain('super-secret-value')
    expect((await readFileTool(context, { path: '.env.example' })).text).toContain('API_KEY=')
  })

  test('禁写目录里的文件不能改，也不能新建', async () => {
    mkdirSync(join(project, 'data'))
    writeFileSync(join(project, 'data', 'db.json'), '{"users":[]}\n')
    const readOnlyContext = { ...context, readOnlyPaths: ['data'] }
    await readFileTool(readOnlyContext, { path: 'data/db.json' })
    await expect(
      editFileTool(readOnlyContext, { path: 'data/db.json', old_string: '[]', new_string: '[1]' }),
    ).rejects.toThrow('read-only')
    await expect(editFileTool(readOnlyContext, { path: 'data/new.json', old_string: '', new_string: '{}' })).rejects.toThrow('read-only')
    expect(readFileSync(join(project, 'data', 'db.json'), 'utf8')).toBe('{"users":[]}\n')
  })

  test('检查点不包含受保护文件和禁写目录，撤销时不动它们', async () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'diffra-cp-'))
    try {
      mkdirSync(join(project, 'data'))
      writeFileSync(join(project, '.env'), 'TOKEN=old\n')
      writeFileSync(join(project, 'data', 'db.json'), 'v1\n')
      writeFileSync(join(project, 'app.ts'), 'a\n')
      const checkpoints = await Checkpoints.open(gitDir, project, ['data'])
      const commit = await checkpoints.snapshot()

      // 这一轮里用户自己改了 .env 和数据目录，agent 改了 app.ts
      writeFileSync(join(project, '.env'), 'TOKEN=new\n')
      writeFileSync(join(project, 'data', 'db.json'), 'v2\n')
      writeFileSync(join(project, 'app.ts'), 'b\n')

      const changes = await checkpoints.changesSince(commit)
      expect(changes).toEqual([{ path: 'app.ts', change: 'modified' }])
      await checkpoints.restore(commit, changes)
      expect(readFileSync(join(project, 'app.ts'), 'utf8')).toBe('a\n')
      expect(readFileSync(join(project, '.env'), 'utf8')).toBe('TOKEN=new\n')
      expect(readFileSync(join(project, 'data', 'db.json'), 'utf8')).toBe('v2\n')
    } finally {
      rmSync(gitDir, { recursive: true, force: true })
    }
  })
})
