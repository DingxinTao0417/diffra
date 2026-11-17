import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyPatchTool } from '../src/tools/apply-patch.js'
import type { ToolContext } from '../src/tools/types.js'
import { realpathOfExisting } from '../src/tools/workspace.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn(original.readFile), mkdir: vi.fn(original.mkdir) }
})

let scratch: string
let project: string
let context: ToolContext

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'diffra-patch-lock-'))
  project = join(scratch, 'project')
  mkdirSync(project)
  context = {
    cwd: project,
    bashPath: null,
    rgPath: '',
    signal: new AbortController().signal,
    trustedCommands: [],
    readOnlyPaths: [],
    readRoots: [],
    requestCommandPermission: async () => ({ allowed: true }),
  }
})

afterEach(() => {
  vi.mocked(fs.readFile).mockReset()
  vi.mocked(fs.mkdir).mockReset()
  vi.restoreAllMocks()
  rmSync(scratch, { recursive: true, force: true })
})

const patch = (...lines: string[]) => ({ input: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') })
const update = (path: string, before: string, after: string) => [`*** Update File: ${path}`, `-${before}`, `+${after}`]

function alias() {
  mkdirSync(join(project, 'actual'))
  symlinkSync(join(project, 'actual'), join(project, 'alias'), 'junction')
}

describe('补丁并发保护', () => {
  test('不同会话同时修改同一文件的不同 hunk，两个改动都保留', async () => {
    writeFileSync(join(project, 'file.txt'), 'first\nsecond\n')
    const results = await Promise.all([
      applyPatchTool({ ...context }, patch(...update('file.txt', 'first', 'FIRST'))),
      applyPatchTool({ ...context }, patch(...update('file.txt', 'second', 'SECOND'))),
    ])
    expect(results.every((result) => result.edited)).toBe(true)
    expect(readFileSync(join(project, 'file.txt'), 'utf8')).toBe('FIRST\nSECOND\n')
  })

  test('同一 hunk 的并发更新只有一份成功，不会用过期原文覆盖', async () => {
    writeFileSync(join(project, 'file.txt'), 'original\n')
    const results = await Promise.allSettled([
      applyPatchTool({ ...context }, patch(...update('file.txt', 'original', 'first'))),
      applyPatchTool({ ...context }, patch(...update('file.txt', 'original', 'second'))),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.reason).toBeInstanceOf(Error)
    expect(rejected?.reason.message).toContain('these lines were not found')
    expect(['first\n', 'second\n']).toContain(readFileSync(join(project, 'file.txt'), 'utf8'))
  })

  test('通过目录 alias 的跨会话更新使用同一把真实路径锁', async () => {
    alias()
    writeFileSync(join(project, 'actual', 'file.txt'), 'first\nsecond\n')
    await Promise.all([
      applyPatchTool({ ...context }, patch(...update('actual/file.txt', 'first', 'FIRST'))),
      applyPatchTool({ ...context }, patch(...update('alias/file.txt', 'second', 'SECOND'))),
    ])
    expect(readFileSync(join(project, 'actual', 'file.txt'), 'utf8')).toBe('FIRST\nSECOND\n')
  })

  test('硬链接 alias 的跨会话更新也不能丢失改动', async () => {
    writeFileSync(join(project, 'actual.txt'), 'first\nsecond\n')
    linkSync(join(project, 'actual.txt'), join(project, 'alias.txt'))
    await Promise.all([
      applyPatchTool(context, patch(...update('actual.txt', 'first', 'FIRST'))),
      applyPatchTool({ ...context }, patch(...update('alias.txt', 'second', 'SECOND'))),
    ])
    expect(readFileSync(join(project, 'actual.txt'), 'utf8')).toBe('FIRST\nSECOND\n')
    expect(readFileSync(join(project, 'alias.txt'), 'utf8')).toBe('FIRST\nSECOND\n')
  })

  test('逆序多文件批次不会死锁，也不会丢失任一 hunk', async () => {
    for (const path of ['a.txt', 'b.txt']) writeFileSync(join(project, path), 'first\nsecond\n')
    await Promise.all([
      applyPatchTool(context, patch(...update('a.txt', 'first', 'FIRST'), ...update('b.txt', 'first', 'FIRST'))),
      applyPatchTool({ ...context }, patch(...update('b.txt', 'second', 'SECOND'), ...update('a.txt', 'second', 'SECOND'))),
    ])
    for (const path of ['a.txt', 'b.txt']) expect(readFileSync(join(project, path), 'utf8')).toBe('FIRST\nSECOND\n')
  })

  test('并发 Add 不覆盖新文件，失败的补丁也会释放锁', async () => {
    const results = await Promise.allSettled([
      applyPatchTool(context, patch('*** Add File: file.txt', '+first')),
      applyPatchTool({ ...context }, patch('*** Add File: file.txt', '+second')),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')?.reason.message).toContain('already exists')
    const original = readFileSync(join(project, 'file.txt'), 'utf8').trim()
    await expect(applyPatchTool(context, patch(...update('file.txt', original, 'final')))).resolves.toMatchObject({ edited: true })
    expect(readFileSync(join(project, 'file.txt'), 'utf8')).toBe('final\n')
  })

  test('计划期间外部写入任一文件，整批在落盘前失败且不覆盖外部改动', async () => {
    const first = join(project, 'a.txt')
    const second = join(project, 'b.txt')
    writeFileSync(first, 'first\n')
    writeFileSync(second, 'second\n')
    const { readFile } = await vi.importActual<typeof fs>('node:fs/promises')
    let changed = false
    vi.mocked(fs.readFile).mockImplementation(async (path, options) => {
      const text = await readFile(path, options)
      if (path === second && !changed) {
        changed = true
        writeFileSync(first, 'external\n')
      }
      return text
    })
    await expect(applyPatchTool(context, patch(...update('a.txt', 'first', 'FIRST'), ...update('b.txt', 'second', 'SECOND')))).rejects.toThrow('file changed while preparing the patch')
    expect(changed).toBe(true)
    expect(readFileSync(first, 'utf8')).toBe('external\n')
    expect(readFileSync(second, 'utf8')).toBe('second\n')
  })

  test('写盘前再次复核 oldText，不覆盖创建目录期间发生的外部写入', async () => {
    const target = join(project, 'file.txt')
    writeFileSync(target, 'original\n')
    const { mkdir } = await vi.importActual<typeof fs>('node:fs/promises')
    vi.mocked(fs.mkdir).mockImplementation(async (path, options) => {
      writeFileSync(target, 'external\n')
      return mkdir(path, options)
    })
    await expect(applyPatchTool(context, patch(...update('file.txt', 'original', 'updated')))).rejects.toThrow('file changed while preparing the patch')
    expect(readFileSync(target, 'utf8')).toBe('external\n')
  })

  test('hunk 上下文仍必须匹配，失败时整批不写且可再次取锁', async () => {
    writeFileSync(join(project, 'a.txt'), 'first\n')
    writeFileSync(join(project, 'b.txt'), 'second\n')
    await expect(applyPatchTool(context, patch(...update('a.txt', 'first', 'FIRST'), ...update('b.txt', 'missing', 'SECOND')))).rejects.toThrow('these lines were not found')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('first\n')
    await expect(applyPatchTool(context, patch(...update('a.txt', 'first', 'FIRST')))).resolves.toMatchObject({ edited: true })
  })
})

describe('规范路径和原有安全边界', () => {
  test('同一补丁不能通过 alias 更新同一物理文件两次，失败时整批不写', async () => {
    alias()
    const file = join(project, 'actual', 'file.txt')
    writeFileSync(file, 'first\nsecond\n')
    await expect(applyPatchTool(context, patch(...update('actual/file.txt', 'first', 'FIRST'), ...update('alias/file.txt', 'second', 'SECOND')))).rejects.toThrow('more than once')
    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n')
  })

  test('Add 和 Move 的目标 alias 也不能重复出现', async () => {
    alias()
    await expect(applyPatchTool(context, patch('*** Add File: actual/new.txt', '+first', '*** Add File: alias/new.txt', '+second'))).rejects.toThrow('more than once')
    expect(existsSync(join(project, 'actual', 'new.txt'))).toBe(false)
    writeFileSync(join(project, 'source.txt'), 'source\n')
    await expect(applyPatchTool(context, patch('*** Update File: source.txt', '*** Move to: actual/new.txt', '*** Add File: alias/new.txt', '+second'))).rejects.toThrow('more than once')
    expect(readFileSync(join(project, 'source.txt'), 'utf8')).toBe('source\n')
  })

  test('同一补丁不能经硬链接对同一物理文件写入两次', async () => {
    writeFileSync(join(project, 'actual.txt'), 'first\nsecond\n')
    linkSync(join(project, 'actual.txt'), join(project, 'alias.txt'))
    await expect(applyPatchTool(context, patch(...update('actual.txt', 'first', 'FIRST'), ...update('alias.txt', 'second', 'SECOND')))).rejects.toThrow('more than once')
    expect(readFileSync(join(project, 'actual.txt'), 'utf8')).toBe('first\nsecond\n')
  })

  test('Windows 大小写 alias 拒绝重复，区分大小写的文件系统仍允许不同文件', async () => {
    writeFileSync(join(project, 'Case.txt'), 'first\n')
    if (process.platform === 'win32') {
      await expect(applyPatchTool(context, patch(...update('Case.txt', 'first', 'FIRST'), ...update('case.txt', 'first', 'SECOND')))).rejects.toThrow('more than once')
      expect(readFileSync(join(project, 'Case.txt'), 'utf8')).toBe('first\n')
    } else {
      writeFileSync(join(project, 'case.txt'), 'second\n')
      await applyPatchTool(context, patch(...update('Case.txt', 'first', 'FIRST'), ...update('case.txt', 'second', 'SECOND')))
      expect(readFileSync(join(project, 'Case.txt'), 'utf8')).toBe('FIRST\n')
      expect(readFileSync(join(project, 'case.txt'), 'utf8')).toBe('SECOND\n')
    }
  })

  test('写入归属检查收到真实路径，不能靠目录 alias 绕过认领', async () => {
    alias()
    const actual = join(project, 'actual', 'file.txt')
    writeFileSync(actual, 'original\n')
    const beforeWrite = vi.fn(() => { throw new Error('owned by another worker') })
    await expect(applyPatchTool({ ...context, beforeWrite }, patch(...update('alias/file.txt', 'original', 'updated')))).rejects.toThrow('owned by another worker')
    expect(beforeWrite).toHaveBeenCalledWith({ absolute: await realpathOfExisting(actual), display: 'alias/file.txt' })
    expect(readFileSync(actual, 'utf8')).toBe('original\n')
  })

  test('受保护文件和只读目录保留限制，alias 不能绕过只读规则', async () => {
    alias()
    await expect(applyPatchTool(context, patch('*** Add File: .env', '+placeholder'))).rejects.toThrow('protected')
    await expect(applyPatchTool({ ...context, readOnlyPaths: ['actual'] }, patch('*** Add File: alias/file.txt', '+new'))).rejects.toThrow('read-only')
    await expect(applyPatchTool({ ...context, readOnlyPaths: ['alias'] }, patch('*** Add File: alias/file.txt', '+new'))).rejects.toThrow('read-only')
    expect(existsSync(join(project, 'actual', 'file.txt'))).toBe(false)
  })

  test('项目外 symlink 仍需授权，拒绝不写；批准后才能更新临时外部数据', async () => {
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'file.txt'), 'original\n')
    symlinkSync(outside, join(project, 'outside-link'), 'junction')
    const input = patch(...update('outside-link/file.txt', 'original', 'updated'))
    await expect(applyPatchTool(context, input)).rejects.toThrow('outside the project')
    const deny = vi.fn(async () => false)
    await expect(applyPatchTool({ ...context, requestExternalPermission: deny }, input)).rejects.toThrow('rejected')
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('original\n')
    const approve = vi.fn(async () => true)
    await applyPatchTool({ ...context, requestExternalPermission: approve }, input)
    expect(approve).toHaveBeenCalledWith(await realpathOfExisting(join(outside, 'file.txt')), 'write')
    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('updated\n')
  })
})
