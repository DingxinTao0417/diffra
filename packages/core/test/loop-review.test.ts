import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionOption, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { SessionSecurity } from '../src/protocol.js'
import { runTurn, type TurnIO } from '../src/session/loop.js'
import type { Session } from '../src/session/session.js'
import {
  addFile,
  exec,
  lastTaskState,
  makeSession,
  project,
  read,
  recordingIO,
  replaceLines,
  scriptedModel,
  type Step,
  turnOutcomes,
  useTempProject,
} from './loop-helpers.js'

// 提交前问深度扫描，Git 带进来的改动不算这一轮的

useTempProject()

describe('提交前问深度扫描', () => {
  const deepScanOn: SessionSecurity = { deepScan: true }
  const editCode = (path: string): Step => ({ toolCalls: [addFile(path, 'export const run = () => 1')] })
  const commitCall = exec('git -c core.quotepath=false commit -m 改了')
  const commit: Step = { toolCalls: [commitCall] }
  const push: Step = { toolCalls: [exec('git push')] }
  // 和 core 一样先记下这一轮再跑：「本任务改动」从记下的第一轮的快照算起
  const run = async (session: Session, id: string, text: string, io: TurnIO) => {
    session.startTurn(id, text)
    try {
      return await runTurn(session, { id, text }, io)
    } finally {
      session.endTurn('end_turn')
    }
  }
  // 记下每次确认的标题和 scope；深度扫描的确认按 pick 选，其他的（命令确认）一律允许一次
  function askingIO(pick: 'deep-scan-first' | 'deep-scan-skip' | 'deep-scan-never') {
    const io = recordingIO()
    const asked: Array<{ title: string; scope: unknown; command: unknown }> = []
    io.requestPermission = async (toolCall: ToolCallUpdate, options: PermissionOption[]) => {
      io.permissionRequests++
      const raw = typeof toolCall.rawInput === 'object' && toolCall.rawInput !== null ? (toolCall.rawInput as Record<string, unknown>) : {}
      const scope = raw.scope ?? null
      asked.push({ title: toolCall.title ?? '', scope, command: raw.command ?? null })
      return scope === 'deep-scan-before-commit' ? pick : (options.find((option) => option.kind === 'allow_once')?.optionId ?? null)
    }
    return Object.assign(io, { asked })
  }
  const deepScanAsks = (asked: Array<{ title: string; scope: unknown; command: unknown }>) => asked.filter((item) => item.scope === 'deep-scan-before-commit')
  const commandCards = (io: { updates: SessionUpdate[] }, text: string) =>
    io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title.includes(text))

  test('开着深度扫描、本任务改过代码：exec_command 提交前先问；选先扫描时这条命令和同一步后面的调用都不执行，这一轮停下记 deep-scan，任务等待中', async () => {
    const model = scriptedModel([editCode('app.ts'), { toolCalls: [commitCall, exec('echo 提交之后')] }, { text: '不会走到这里' }])
    const session = await makeSession(model, undefined, [], undefined, deepScanOn)
    const io = askingIO('deep-scan-first')

    await expect(run(session, 't1', '改完提交', io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(deepScanAsks(io.asked)).toEqual([{ title: '提交前先做一次深度扫描？', scope: 'deep-scan-before-commit', command: 'git -c core.quotepath=false commit -m 改了' }])
    // 提交命令没走到命令确认
    expect(io.asked).toHaveLength(1)
    // 提交命令出一张没执行的卡，后面那条命令没开始
    expect(commandCards(io, 'commit')).toMatchObject([{ status: 'failed', kind: 'execute', title: '执行 git -c core.quotepath=false commit -m 改了' }])
    expect(JSON.stringify(commandCards(io, 'commit'))).toContain('先做深度扫描，这条命令没有执行')
    expect(commandCards(io, '提交之后')).toEqual([])
    const results = session.messages.at(-1)
    expect(results).toMatchObject({ role: 'tool' })
    expect(JSON.stringify(results)).toContain('The user wants a deep security scan')
    expect(JSON.stringify(results)).toContain('this batched call was not executed')
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'deep-scan' }])
    expect(lastTaskState(io)).toMatchObject({ status: 'waiting', reason: '提交前先做深度扫描：看完报告再决定修哪些、要不要提交。' })
  }, 30_000)

  test('选「这个任务不再问」照常执行，这个会话里再提交、推送都不问；选直接推送只放过这一次', async () => {
    const never = scriptedModel([editCode('app.ts'), commit, push, { text: '好了' }])
    const neverSession = await makeSession(never, undefined, [], undefined, deepScanOn)
    const neverIO = askingIO('deep-scan-never')
    await expect(run(neverSession, 't1', '改完提交推送', neverIO)).resolves.toBe('end_turn')
    expect(never.doStreamCalls).toHaveLength(4)
    expect(deepScanAsks(neverIO.asked)).toEqual([{ title: '提交前先做一次深度扫描？', scope: 'deep-scan-before-commit', command: 'git -c core.quotepath=false commit -m 改了' }])
    expect(neverSession.deepScanDeclined).toBe(true)
    // 两条命令都照常执行（走了命令确认）
    expect(neverIO.asked.filter((item) => item.scope === null).map((item) => item.command)).toEqual(['git -c core.quotepath=false commit -m 改了', 'git push'])
    expect(commandCards(neverIO, 'git push')).toMatchObject([{ status: 'in_progress' }])
    expect(turnOutcomes(neverIO)).toEqual([{ finish: null, stop: null }])

    const skip = scriptedModel([editCode('b.ts'), push, push, { text: '好了' }])
    const skipIO = askingIO('deep-scan-skip')
    await expect(run(await makeSession(skip, undefined, [], undefined, deepScanOn), 't1', '改完推送', skipIO)).resolves.toBe('end_turn')
    expect(skip.doStreamCalls).toHaveLength(4)
    expect(deepScanAsks(skipIO.asked).map((item) => item.title)).toEqual(['推送前先做一次深度扫描？', '推送前先做一次深度扫描？'])
    expect(commandCards(skipIO, 'git push')).toMatchObject([{ status: 'in_progress' }, { status: 'in_progress' }])
  }, 30_000)

  test('关着深度扫描、只改了非代码文件、扫过之后代码没再变时都不问', async () => {
    const off = scriptedModel([editCode('app.ts'), commit, { text: '好了' }])
    const offIO = askingIO('deep-scan-first')
    await run(await makeSession(off), 't1', '改完提交', offIO)
    expect(off.doStreamCalls).toHaveLength(3)
    expect(deepScanAsks(offIO.asked)).toEqual([])

    const docs = scriptedModel([{ toolCalls: [addFile('README.md', '# 说明')] }, commit, { text: '好了' }])
    const docsIO = askingIO('deep-scan-first')
    await run(await makeSession(docs, undefined, [], undefined, deepScanOn), 't1', '写说明并提交', docsIO)
    expect(docs.doStreamCalls).toHaveLength(3)
    expect(deepScanAsks(docsIO.asked)).toEqual([])

    const scanned = scriptedModel([editCode('c.ts'), { text: '改好了' }, commit, { text: '好了' }, editCode('d.ts'), commit, { text: '好了' }])
    const scannedSession = await makeSession(scanned, undefined, [], undefined, deepScanOn)
    await run(scannedSession, 't1', '改一下', recordingIO())
    // 深度扫描跑完时记下的工作区指纹（见 security/deep.ts）
    scannedSession.deepScannedFingerprint = await scannedSession.checkpoints!.fingerprint()
    const scannedIO = askingIO('deep-scan-first')
    await run(scannedSession, 't2', '提交', scannedIO)
    expect(deepScanAsks(scannedIO.asked)).toEqual([])
    expect(commandCards(scannedIO, 'commit')).toMatchObject([{ status: 'in_progress' }])
    // 扫过之后代码又变了：再问
    const changedIO = askingIO('deep-scan-skip')
    await run(scannedSession, 't3', '再改再提交', changedIO)
    expect(deepScanAsks(changedIO.asked)).toHaveLength(1)
    expect(scanned.doStreamCalls).toHaveLength(7)
  }, 30_000)
})

describe('拉取代码这类 Git 带进来的改动', () => {
  const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' })
  let upstream: string

  // 项目是 Git 仓库，上游是它的克隆：上游多了一个提交（改了 app.ts、新加带 eval 的 lib.ts），项目还没拉
  beforeEach(() => {
    git(project, 'init', '-q', '-b', 'main')
    writeFileSync(join(project, 'app.ts'), 'export const a = 1\n')
    git(project, 'add', '.')
    git(project, 'commit', '-qm', 'init')
    upstream = mkdtempSync(join(tmpdir(), 'diffra-loop-upstream-'))
    git(upstream, 'clone', '-q', project, '.')
    writeFileSync(join(upstream, 'app.ts'), 'export const a = 2\n')
    writeFileSync(join(upstream, 'lib.ts'), 'export const run = (input: string) => eval(input)\n')
    git(upstream, 'add', '.')
    git(upstream, 'commit', '-qm', 'upstream')
  })

  afterEach(() => {
    rmSync(upstream, { recursive: true, force: true })
  })

  const pull = (): Step => ({ toolCalls: [exec(`git pull -q --ff-only "${upstream.replace(/\\/g, '/')}" main`)] })
  const done: Step = { text: '好了' }
  const security: SessionSecurity = {}

  test('只用 exec_command 拉代码：拉下来的文件不算这一轮的改动', async () => {
    const model = scriptedModel([pull(), done])
    const session = await makeSession(model, undefined, [], undefined, security)
    const io = recordingIO()

    await expect(runTurn(session, { id: 't1', text: '拉一下最新代码' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(readFileSync(join(project, 'lib.ts'), 'utf8')).toContain('eval(input)')
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(lastTaskState(io)).toMatchObject({ status: 'completed' })
    expect(await session.checkpointChanges('t1')).toEqual([])
  }, 30_000)

  test('拉了代码又改了文件：这一轮的改动只算智能体改的；撤销这一轮只退回它改的，拉下来的代码留着，记录重新载入后照样', async () => {
    const model = scriptedModel([pull(), { toolCalls: [read('app.ts')] }, { toolCalls: [replaceLines('app.ts', 'export const a = 2', 'export const a = 3')] }, done])
    const session = await makeSession(model, undefined, [], undefined, security)
    session.startTurn('t1', '拉代码再改')
    const io = recordingIO()

    await expect(runTurn(session, { id: 't1', text: '拉代码再改' }, io)).resolves.toBe('end_turn')
    session.endTurn('end_turn')
    expect(model.doStreamCalls).toHaveLength(4)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    const diff = await session.checkpointDiff('t1')
    expect(diff).toContain('+export const a = 3')
    expect(diff).toContain('-export const a = 2')
    expect(diff).not.toContain('lib.ts')
    expect(await session.checkpointChanges('t1')).toEqual([{ path: 'app.ts', change: 'modified' }])

    // 存盘再载入：基线跟着记录走，撤销时还认得哪些是拉下来的
    const reloaded = await makeSession(scriptedModel([]), undefined, [], undefined, security, undefined, {}, { record: session.toRecord() })
    expect(await reloaded.restoreCheckpoint('t1')).toEqual([{ path: 'app.ts', change: 'modified' }])
    // 退回到拉取后磁盘上的样子；全局开了 core.autocrlf 时拉下来的是 CRLF
    expect(readFileSync(join(project, 'app.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('export const a = 2\n')
    expect(readFileSync(join(project, 'lib.ts'), 'utf8')).toContain('eval(input)')
    // 工作区和拉下来的提交一致，不会留下一堆把上游改动反着撤掉的改动
    expect(git(project, 'status', '--porcelain')).toBe('')
  }, 30_000)

  test('没挪 HEAD 的 git 命令照旧：用命令改的文件仍算这一轮的改动', async () => {
    const model = scriptedModel([{ toolCalls: [exec('git checkout -q -b topic && echo "export const b = 1" > b.ts')] }, done])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 't1', text: '开个分支写 b.ts' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: null }])
    expect(await session.checkpointChanges('t1')).toEqual([{ path: 'b.ts', change: 'added' }])
  }, 30_000)
})
