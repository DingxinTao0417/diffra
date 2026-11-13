import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { ToolResultPart } from 'ai'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findBash } from '../src/environment.js'
import type { LoadedPluginHook } from '../src/plugins.js'
import type { PluginHookEvent } from '../src/protocol.js'
import { runTurn } from '../src/session/loop.js'
import { sessionStartContext } from '../src/session/plugin-hooks.js'
import type { Session } from '../src/session/session.js'
import { addFile, exec, makeSession, project, recordingIO, scriptedModel, useTempProject } from './loop-helpers.js'

// 插件钩子（第 600 步）：Claude Code hooks.json 的五个时机，标准输入是 JSON，退出码 2 拦下
useTempProject()

let pluginRoot: string
beforeEach(() => {
  pluginRoot = mkdtempSync(join(tmpdir(), 'diffra-plugin-hooks-'))
})
afterEach(() => {
  rmSync(pluginRoot, { recursive: true, force: true })
})

const hook = (event: PluginHookEvent, command: string, matcher = ''): LoadedPluginHook => ({ event, matcher, command, timeout: null, plugin: 'kit', root: pluginRoot })
const toolResults = (session: Session) =>
  session.messages.flatMap((message) => (message.role === 'tool' ? message.content.filter((part): part is ToolResultPart => part.type === 'tool-result') : []))
const userTexts = (session: Session) => session.messages.flatMap((message) => (message.role === 'user' && typeof message.content === 'string' ? [message.content] : []))
const notices = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))

describe('插件钩子', () => {
  test('SessionStart：标准输出或 JSON 的 additionalContext 是给系统提示词的说明，按 startup 匹配；钩子拿到插件根目录和会话信息', async () => {
    writeFileSync(join(pluginRoot, 'start.sh'), 'echo "plain from $(basename "$CLAUDE_PLUGIN_ROOT")"\n')
    const hooks = [
      hook('SessionStart', 'bash "${CLAUDE_PLUGIN_ROOT}/start.sh"', 'startup'),
      hook('SessionStart', `cat > "\${CLAUDE_PLUGIN_ROOT}/input.json"; echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"use skills"}}'`),
      hook('SessionStart', 'echo only on resume', 'resume'),
      hook('SessionStart', 'echo broken; exit 1'),
    ]
    const context = await sessionStartContext(hooks, { cwd: project, bashPath: await findBash(), sessionId: 's-1' })
    expect(context).toBe(`[kit]\nplain from ${pluginRoot.split(/[\\/]/).at(-1)}\n\n[kit]\nuse skills`)
    expect(JSON.parse(readFileSync(join(pluginRoot, 'input.json'), 'utf8'))).toEqual({ session_id: 's-1', cwd: project, hook_event_name: 'SessionStart', source: 'startup' })
    expect(await sessionStartContext([], { cwd: project, bashPath: await findBash(), sessionId: 's-1' })).toBeNull()
  }, 30_000)

  test('UserPromptSubmit：标准输出接在这条消息后面给模型；退出码 2 拦下，不调模型，理由告诉用户', async () => {
    const model = scriptedModel([{ text: '好的' }])
    const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, {
      pluginHooks: [hook('UserPromptSubmit', 'input=$(cat); case "$input" in *secret*) echo "不许发密钥" >&2; exit 2;; esac; echo "remember KIT"')],
    })
    await runTurn(session, { id: 't1', text: '做一下' }, recordingIO())
    expect(userTexts(session)).toContain('[Diffra] Context from plugin hooks for this message:\n[kit]\nremember KIT')

    const io = recordingIO()
    await expect(runTurn(session, { id: 't2', text: '这是 secret' }, io)).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(notices(io)).toContain('插件钩子拦下了这条消息')
    expect(userTexts(session).some((text) => text.includes('secret'))).toBe(false)
    expect(session.taskState.status).toBe('blocked')
  }, 30_000)

  test('PreToolUse 按 Bash 匹配执行命令，退出码 2 不执行、理由给模型；PostToolUse 按 Write 匹配新建的文件，拿到文件路径，JSON 的 reason 接在结果后面', async () => {
    const model = scriptedModel([{ toolCalls: [exec('echo deploy > deployed.txt')] }, { toolCalls: [exec('echo fine')] }, { toolCalls: [addFile('a.txt', 'x')] }, { text: '好了' }])
    const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, {
      pluginHooks: [
        hook('PreToolUse', 'input=$(cat); case "$input" in *deploy*) echo "no deploy" >&2; exit 2;; esac', 'Bash'),
        hook('PreToolUse', 'echo should not run for commands >&2; exit 2', 'Edit|Write'),
        hook('PostToolUse', `cat > "\${CLAUDE_PLUGIN_ROOT}/post.json"; echo '{"decision":"block","reason":"run the formatter"}'`, 'Write'),
      ],
    })
    session.permissionMode = 'full'
    await runTurn(session, { id: 't', text: '做一下' }, recordingIO())
    const results = toolResults(session)
    expect(results[0]?.output).toEqual({ type: 'error-text', value: 'Blocked by a hook of the kit plugin: no deploy' })
    expect(existsSync(join(project, 'deployed.txt'))).toBe(false)
    expect(results[1]?.output.type).toBe('text')
    // 改文件的 PreToolUse 钩子拦下了补丁
    expect(results[2]?.output).toEqual({ type: 'error-text', value: 'Blocked by a hook of the kit plugin: should not run for commands' })
    expect(existsSync(join(project, 'a.txt'))).toBe(false)
    expect(existsSync(join(pluginRoot, 'post.json'))).toBe(false)
  }, 30_000)

  test('PostToolUse：改了的文件按 Write、Edit 拆开，标准输入带文件路径；反馈接在工具结果后面', async () => {
    const model = scriptedModel([{ toolCalls: [addFile('a.txt', 'x')] }, { text: '好了' }])
    const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, {
      pluginHooks: [hook('PostToolUse', `cat > "\${CLAUDE_PLUGIN_ROOT}/post.json"; echo '{"decision":"block","reason":"run the formatter"}'`, 'Edit|Write')],
    })
    session.permissionMode = 'full'
    await runTurn(session, { id: 't', text: '做一下' }, recordingIO())
    const result = toolResults(session)[0]
    expect(result?.output.type === 'text' && result.output.value.endsWith('\n[A hook of the kit plugin after this call: run the formatter]')).toBe(true)
    const input = JSON.parse(readFileSync(join(pluginRoot, 'post.json'), 'utf8')) as { tool_name: string; tool_input: { file_path: string; content: string } }
    expect(input.tool_name).toBe('Write')
    expect(input.tool_input).toEqual({ file_path: join(project, 'a.txt'), content: 'x\n' })
  }, 30_000)

  test('Stop：拦下时把理由交回去接着做，下次 stop_hook_active 为 true；钩子一直拦也最多接着做 3 次', async () => {
    const model = scriptedModel([{ text: '好了' }, { text: '补上测试了' }])
    const session = await makeSession(model, undefined, [], undefined, undefined, undefined, {}, {
      pluginHooks: [hook('Stop', 'input=$(cat); case "$input" in *\'"stop_hook_active":false\'*) echo "先写测试" >&2; exit 2;; esac')],
    })
    await expect(runTurn(session, { id: 't', text: '做一下' }, recordingIO())).resolves.toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(userTexts(session)).toContain('[Diffra] A plugin hook asked you to keep going before ending the turn: kit: 先写测试')
    expect(session.taskState.status).toBe('completed')

    const stubborn = scriptedModel([{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }])
    const stuck = await makeSession(stubborn, undefined, [], undefined, undefined, undefined, {}, { pluginHooks: [hook('Stop', 'echo "还不行" >&2; exit 2')] })
    await runTurn(stuck, { id: 't', text: '做一下' }, recordingIO())
    expect(stubborn.doStreamCalls).toHaveLength(4)
    expect(stuck.taskState.status).toBe('completed')
  }, 30_000)
})
