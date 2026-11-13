import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Checkpoints } from '../src/checkpoint.js'
import { findBash, findRipgrep } from '../src/environment.js'
import { applyPatchTool, patchFromCommand } from '../src/tools/apply-patch.js'
import { truncateForModel } from '../src/process.js'
import { ExecSessions, execCommandTool, writeStdinTool } from '../src/tools/exec.js'
import type { ToolContext } from '../src/tools/types.js'
import { viewImageTool } from '../src/tools/view-image.js'

let project: string
let context: ToolContext
let execSessions: ExecSessions

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), 'diffra-tools-'))
  execSessions = new ExecSessions()
  context = {
    cwd: project,
    rgPath: await findRipgrep(),
    bashPath: await findBash(),
    signal: new AbortController().signal,
    execSessions,
    trustedCommands: [],
    readOnlyPaths: [],
    readRoots: [],
    requestCommandPermission: async () => ({ allowed: true }),
  }
})

afterEach(() => {
  execSessions.killAll(true)
  rmSync(project, { recursive: true, force: true })
})

const patch = (...lines: string[]) => ({ input: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') })

describe('apply_patch', () => {
  test('一个补丁里新建、修改、删除、改名，结果列出每个文件', async () => {
    writeFileSync(join(project, 'a.ts'), 'one\ntwo\nthree\n')
    writeFileSync(join(project, 'old.ts'), 'gone\n')
    writeFileSync(join(project, 'move.ts'), 'x\ny\n')
    const result = await applyPatchTool(
      context,
      patch(
        '*** Add File: src/new.ts',
        '+export {}',
        '*** Update File: a.ts',
        '@@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '*** Delete File: old.ts',
        '*** Update File: move.ts',
        '*** Move to: moved/move.ts',
        ' x',
        '-y',
        '+z',
      ),
    )
    expect(result.text).toBe('Success. Updated the following files:\nA src/new.ts\nM a.ts\nD old.ts\nA moved/move.ts\nD move.ts')
    expect(result.edited).toBe(true)
    expect(readFileSync(join(project, 'src', 'new.ts'), 'utf8')).toBe('export {}\n')
    expect(readFileSync(join(project, 'a.ts'), 'utf8')).toBe('one\nTWO\nthree\n')
    expect(existsSync(join(project, 'old.ts'))).toBe(false)
    expect(existsSync(join(project, 'move.ts'))).toBe(false)
    expect(readFileSync(join(project, 'moved', 'move.ts'), 'utf8')).toBe('x\nz\n')
    expect(result.diffs?.find((diff) => diff.path.endsWith('old.ts'))).toMatchObject({ oldText: 'gone\n', newText: '', deleted: true })
  })

  test('保留 CRLF 换行，返回改动前后的全文', async () => {
    writeFileSync(join(project, 'a.txt'), 'a\r\nb\r\nc\r\n')
    const result = await applyPatchTool(context, patch('*** Update File: a.txt', ' a', '-b', '+B'))
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('a\r\nB\r\nc\r\n')
    expect(result.diffs).toEqual([{ path: join(project, 'a.txt'), oldText: 'a\r\nb\r\nc\r\n', newText: 'a\r\nB\r\nc\r\n' }])
  })

  test('上下文对不上时逐级放宽：行尾空白、缩进、弯引号和破折号', async () => {
    writeFileSync(join(project, 'a.ts'), 'const a = 1   \n    say(“hi”) — ok\nend\n')
    await applyPatchTool(context, patch('*** Update File: a.ts', ' const a = 1', '-say("hi") - ok', '+say("bye")', ' end'))
    expect(readFileSync(join(project, 'a.ts'), 'utf8')).toBe('const a = 1   \nsay("bye")\nend\n')
  })

  test('@@ 行用来在重复的上下文里定位', async () => {
    writeFileSync(join(project, 'a.ts'), 'function a() {\n  return 1\n}\nfunction b() {\n  return 1\n}\n')
    await applyPatchTool(context, patch('*** Update File: a.ts', '@@ function b() {', '-  return 1', '+  return 2'))
    expect(readFileSync(join(project, 'a.ts'), 'utf8')).toBe('function a() {\n  return 1\n}\nfunction b() {\n  return 2\n}\n')
  })

  test('有一处对不上整份都不写，错误里说清哪几行没找到', async () => {
    writeFileSync(join(project, 'a.ts'), 'one\n')
    writeFileSync(join(project, 'b.ts'), 'two\n')
    await expect(applyPatchTool(context, patch('*** Update File: a.ts', '-one', '+ONE', '*** Update File: b.ts', '-missing', '+x'))).rejects.toThrow(
      'b.ts: these lines were not found:\nmissing',
    )
    expect(readFileSync(join(project, 'a.ts'), 'utf8')).toBe('one\n')
  })

  test('新建已存在的文件、修改不存在的文件、同一文件出现两次都被拒绝', async () => {
    writeFileSync(join(project, 'a.ts'), 'one\n')
    await expect(applyPatchTool(context, patch('*** Add File: a.ts', '+x'))).rejects.toThrow('already exists')
    await expect(applyPatchTool(context, patch('*** Update File: none.ts', '-x', '+y'))).rejects.toThrow('does not exist')
    await expect(applyPatchTool(context, patch('*** Update File: a.ts', '-one', '+1', '*** Update File: a.ts', '-1', '+2'))).rejects.toThrow('more than once')
    await expect(applyPatchTool(context, { input: 'no patch here' })).rejects.toThrow('must start with "*** Begin Patch"')
  })

  test('剥掉 heredoc 外壳；命令里的 apply_patch <<EOF 能认出补丁和目录', async () => {
    writeFileSync(join(project, 'a.ts'), 'one\n')
    await applyPatchTool(context, { input: "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: a.ts\n-one\n+two\n*** End Patch\nEOF" })
    expect(readFileSync(join(project, 'a.ts'), 'utf8')).toBe('two\n')
    expect(patchFromCommand("cd src && apply_patch <<'EOF'\n*** Begin Patch\n*** End Patch\nEOF")).toEqual({ patch: '*** Begin Patch\n*** End Patch', workdir: 'src' })
    expect(patchFromCommand('git apply x.patch')).toBeNull()
  })

  test('项目外的文件要批准，拒绝时不写入', async () => {
    const external = mkdtempSync(join(tmpdir(), 'diffra-external-'))
    const requested: Array<{ path: string; access: string }> = []
    let approved = false
    context.requestExternalPermission = async (path, access) => {
      requested.push({ path, access })
      return approved
    }
    try {
      const target = join(external, 'note.txt')
      await expect(applyPatchTool(context, patch(`*** Add File: ${target}`, '+hello'))).rejects.toThrow('rejected')
      expect(existsSync(target)).toBe(false)
      approved = true
      await applyPatchTool(context, patch(`*** Add File: ${target}`, '+hello'))
      expect(readFileSync(target, 'utf8')).toBe('hello\n')
      expect(requested.map((item) => item.access)).toEqual(['write', 'write'])
      expect(requested[1]!.path).toBe(await realpath(target))
    } finally {
      rmSync(external, { recursive: true, force: true })
    }
  })
})

describe('exec_command 和 write_stdin', () => {
  test('命令跑完返回退出码和输出', async () => {
    const result = await execCommandTool(context, { cmd: 'echo hello; exit 3' })
    expect(result.text).toMatch(/^Wall time: \d+\.\d{4} seconds\nProcess exited with code 3\nOutput:\nhello$/)
    expect(result.commandSucceeded).toBe(false)
    expect(execSessions.size).toBe(0)
  })

  test('到点没结束返回会话号，write_stdin 接着取输出，Ctrl-C 结束它', async () => {
    const started = await execCommandTool(context, { cmd: 'echo start; sleep 1; echo middle; sleep 30', yield_time_ms: 300 })
    const id = Number(/session ID (\d+)/.exec(started.text)?.[1])
    expect(started.text).toContain('start')
    expect(started.commandSucceeded).toBeUndefined()
    const polled = await writeStdinTool(context, { session_id: id, yield_time_ms: 5000 })
    expect(polled.text).toContain('middle')
    expect(polled.text).not.toContain('start')
    const stopped = await writeStdinTool(context, { session_id: id, chars: '\u0003', yield_time_ms: 2000 })
    // 我们结束的进程不算命令失败（第 524 步）
    expect(stopped.text).toContain('Process stopped (Ctrl-C)')
    expect(stopped.commandSucceeded).toBeUndefined()
    expect(stopped.terminalOutput?.startsWith('已停止')).toBe(true)
    await expect(writeStdinTool(context, { session_id: id })).rejects.toThrow(`No running process with session ID ${id}`)
  }, 20_000)

  // 第 522 步：评测里模型把 Ctrl-C 写成了六个字符的文字，停不掉服务
  test('Ctrl-C 写成转义的文字（\\u0003、\\x03、^C）也照样结束进程', async () => {
    for (const chars of ['\\u0003', '\\x03', '^C']) {
      const started = await execCommandTool(context, { cmd: 'sleep 30', yield_time_ms: 250 })
      const id = Number(/session ID (\d+)/.exec(started.text)?.[1])
      const stopped = await writeStdinTool(context, { session_id: id, chars })
      expect(stopped.text, chars).toContain('Process stopped (Ctrl-C)')
    }
    expect(execSessions.size).toBe(0)
  }, 30_000)

  // 第 528 步：到点没结束的命令转到后台，界面「运行中」列出来，用户能停、能看最近的输出
  test('到点没结束的命令列进后台列表；用户停止后模型看到是用户停的，列表变化都通知', async () => {
    const changes: number[] = []
    execSessions.onChange = () => changes.push(execSessions.background().length)
    const quick = await execCommandTool(context, { cmd: 'echo quick' })
    expect(quick.text).toContain('Process exited with code 0')
    expect(changes).toEqual([])
    const started = await execCommandTool(context, { cmd: 'echo serving; sleep 30', yield_time_ms: 300 })
    const id = Number(/session ID (\d+)/.exec(started.text)?.[1])
    expect(execSessions.background()).toEqual([{ id, command: 'echo serving; sleep 30', cwd: project, startedAt: expect.any(Number), url: null }])
    expect(changes).toEqual([1])
    // 看最近的输出不动交给模型的那份：模型下次取到的还是新来的输出
    expect(execSessions.recentOutput(id)).toEqual({ text: 'serving\n', running: true })
    execSessions.kill(id, true)
    await expect.poll(() => changes, { timeout: 10_000 }).toEqual([1, 0])
    expect(execSessions.background()).toEqual([])
    const polled = await writeStdinTool(context, { session_id: id })
    expect(polled.text).toContain('Process stopped by the user')
    expect(polled.commandSucceeded).toBeUndefined()
  }, 20_000)

  test('转到后台后才打出本地地址：列表带上地址（0.0.0.0 换成 localhost）并通知', async () => {
    const urls: Array<string | null> = []
    execSessions.onChange = () => urls.push(execSessions.background()[0]?.url ?? null)
    const started = await execCommandTool(context, { cmd: 'sleep 1; echo "  Local:   http://0.0.0.0:5173/"; sleep 30', yield_time_ms: 250 })
    const id = Number(/session ID (\d+)/.exec(started.text)?.[1])
    await expect.poll(() => urls, { timeout: 10_000 }).toEqual([null, 'http://localhost:5173/'])
    await writeStdinTool(context, { session_id: id, chars: '\u0003' })
  }, 20_000)

  test('没开输入的命令不能往里输入，报错说清用 stdin: true', async () => {
    const started = await execCommandTool(context, { cmd: 'sleep 5', yield_time_ms: 250 })
    const id = Number(/session ID (\d+)/.exec(started.text)?.[1])
    await expect(writeStdinTool(context, { session_id: id, chars: 'y\n' })).rejects.toThrow('start it again with exec_command and stdin: true')
  })

  // 第 523 步：stdin: true 时输入开着，能回答程序的提问；\u0004 结束输入
  test('stdin: true 时能往程序里输入，\\u0004 结束输入', async () => {
    const script = "let all = ''; process.stdin.on('data', (chunk) => { all += chunk; process.stdout.write('got:' + chunk) }); process.stdin.on('end', () => { console.log('lines=' + all.trim().split(/\\n/).length) })"
    writeFileSync(join(project, 'echo.js'), script)
    const started = await execCommandTool(context, { cmd: 'node echo.js', yield_time_ms: 500, stdin: true })
    const id = Number(/session ID (\d+)/.exec(started.text)?.[1])
    const first = await writeStdinTool(context, { session_id: id, chars: 'alice\n' })
    expect(first.text).toContain('got:alice')
    expect(first.title).toBe('输入 node echo.js')
    await writeStdinTool(context, { session_id: id, chars: 'bob\n' })
    const ended = await writeStdinTool(context, { session_id: id, chars: '\u0004', yield_time_ms: 5000 })
    expect(ended.text).toContain('Process exited with code 0')
    expect(ended.text).toContain('lines=2')
    expect(ended.commandSucceeded).toBe(true)
    // 开着输入也不影响普通命令：rg 不带路径照样搜当前目录（输入关着时不会去等输入）
    const searched = await execCommandTool(context, { cmd: 'rg -l alice' })
    expect(searched.text).toContain('Process exited')
  }, 30_000)

  test('用户停下时正在等的命令一起结束', async () => {
    const controller = new AbortController()
    const running = execCommandTool({ ...context, signal: controller.signal }, { cmd: 'sleep 30', yield_time_ms: 20_000 })
    setTimeout(() => controller.abort(), 300)
    await expect(running).rejects.toThrow('Cancelled by the user')
    expect(execSessions.size).toBe(0)
  })

  test('被拒绝的命令不执行', async () => {
    context.requestCommandPermission = async () => ({ allowed: false, reason: 'The user rejected this command.' })
    await expect(execCommandTool(context, { cmd: 'echo x > made.txt' })).rejects.toThrow('rejected')
    expect(existsSync(join(project, 'made.txt'))).toBe(false)
  })

  test('命令里的 apply_patch 照补丁处理，不起 shell', async () => {
    writeFileSync(join(project, 'a.ts'), 'one\n')
    const result = await execCommandTool(context, { cmd: "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: a.ts\n-one\n+two\n*** End Patch\nEOF" })
    expect(result.edited).toBe(true)
    expect(readFileSync(join(project, 'a.ts'), 'utf8')).toBe('two\n')
  })

  // 提示词让模型用 rg 搜索：本机没装 rg 时也能用内置的那个
  test('命令里能用内置的 rg', async () => {
    const result = await execCommandTool(context, { cmd: 'rg --version' })
    expect(result.text).toContain('Process exited with code 0')
    expect(result.text).toContain('ripgrep')
  })

  test('命令不存在时给出名字接近的命令', async () => {
    const typo = await execCommandTool(context, { cmd: 'grepp --version' })
    expect(typo.text).toMatch(/Similar commands that exist: .*\bgrep\b/)
    expect(typo.terminalOutput).not.toContain('Similar commands')
  })

  test('输出超过上限时按 token 头尾各留一半，说明原来有多长', () => {
    const text = `${'a'.repeat(400)}\n${'b'.repeat(400)}`
    const short = truncateForModel(text, 50)
    expect(short.truncated).toBe(true)
    expect(short.text.startsWith('Warning: truncated output (original token count: 201)\nTotal output lines: 2\n')).toBe(true)
    expect(short.text).toContain('…151 tokens truncated…')
    expect(short.text.endsWith('b'.repeat(100))).toBe(true)
    expect(truncateForModel('short', 50)).toEqual({ text: 'short', truncated: false, originalTokens: 2 })
  })
})

describe('view_image', () => {
  test('返回图片数据；不是图片或文件不存在时报错', async () => {
    writeFileSync(join(project, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(project, 'notes.txt'), 'x')
    const result = await viewImageTool(context, { path: 'shot.png' })
    expect(result.image).toEqual({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mimeType: 'image/png' })
    await expect(viewImageTool(context, { path: 'notes.txt' })).rejects.toThrow('not a supported image')
    await expect(viewImageTool(context, { path: 'missing.png' })).rejects.toThrow('not found')
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
  }, 30_000)
})

describe('受保护文件和禁写目录', () => {
  test('.env 不能改；.env.example 照常能改', async () => {
    writeFileSync(join(project, '.env'), 'API_KEY=super-secret-value\n')
    writeFileSync(join(project, '.env.example'), 'API_KEY=\n')
    await expect(applyPatchTool(context, patch('*** Update File: .env', '-API_KEY=super-secret-value', '+API_KEY=x'))).rejects.toThrow('protected')
    await expect(applyPatchTool(context, patch('*** Add File: config/.env', '+X=1'))).rejects.toThrow('protected')
    await applyPatchTool(context, patch('*** Update File: .env.example', '-API_KEY=', '+API_KEY=example'))
    expect(readFileSync(join(project, '.env'), 'utf8')).toBe('API_KEY=super-secret-value\n')
    expect(readFileSync(join(project, '.env.example'), 'utf8')).toBe('API_KEY=example\n')
  })

  test('禁写目录里的文件不能改，也不能新建', async () => {
    mkdirSync(join(project, 'data'))
    writeFileSync(join(project, 'data', 'db.json'), '{"users":[]}\n')
    const readOnlyContext = { ...context, readOnlyPaths: ['data'] }
    await expect(applyPatchTool(readOnlyContext, patch('*** Update File: data/db.json', '-{"users":[]}', '+{"users":[1]}'))).rejects.toThrow('read-only')
    await expect(applyPatchTool(readOnlyContext, patch('*** Add File: data/new.json', '+{}'))).rejects.toThrow('read-only')
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

  test('禁写目录本来就被忽略（node_modules、.gitignore 里的 data/）：检查点照样建得起来（第 632 步）', async () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'diffra-cp-'))
    try {
      for (const dir of ['node_modules', 'data', 'fixtures']) mkdirSync(join(project, dir))
      writeFileSync(join(project, '.gitignore'), 'data/\n')
      writeFileSync(join(project, 'node_modules', 'a.js'), 'x\n')
      writeFileSync(join(project, 'data', 'db.json'), 'v1\n')
      writeFileSync(join(project, 'fixtures', 'f.json'), 'v1\n')
      writeFileSync(join(project, 'app.ts'), 'a\n')
      const checkpoints = await Checkpoints.open(gitDir, project, ['node_modules', 'data', 'fixtures'])
      const commit = await checkpoints.snapshot()

      writeFileSync(join(project, 'fixtures', 'f.json'), 'v2\n')
      writeFileSync(join(project, 'app.ts'), 'b\n')
      expect(await checkpoints.changesSince(commit)).toEqual([{ path: 'app.ts', change: 'modified' }])
    } finally {
      rmSync(gitDir, { recursive: true, force: true })
    }
  })
})
