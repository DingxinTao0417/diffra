import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { LoadedPluginHook } from '../plugins.js'
import { killTree } from '../process.js'
import type { PluginHookEvent } from '../protocol.js'
import { parsePatch } from '../tools/apply-patch.js'
import { commandEnv } from '../tools/command.js'
import type { ToolOutput } from '../tools/types.js'

// 插件钩子（第 600 步）：兼容 Claude Code hooks/hooks.json 的五个时机。用户在装插件时看过命令、允许了才跑（见 plugins.ts 的 pluginHooks）。
// 跟 Claude Code 一样：命令用 bash -c 跑，标准输入是一段 JSON；退出码 2 表示拦下，理由在标准错误；
// 退出码 0 时标准输出是给模型的补充说明（只有 SessionStart、UserPromptSubmit），也可以输出一段 JSON 表达同样的意思。
// 钩子自己出错（别的退出码、超时、没跑起来）只记日志，不拦事情。项目钩子（hooks.ts）不受影响
const MAX_TIMEOUT_MS = 60_000
const MAX_STREAM_BYTES = 64 * 1024
const MAX_CONTEXT_CHARS = 20_000

export interface PluginHookContext {
  cwd: string
  bashPath: string | null
  sessionId: string
  signal?: AbortSignal
}

interface HookRun {
  hook: LoadedPluginHook
  exitCode: number | null
  stdout: string
  stderr: string
  json: Record<string, unknown> | null
}

// Diffra 的工具在钩子里叫什么、参数长什么样：执行命令是 Bash，补丁按文件拆成 Write（新建）和 Edit，其他用自己的名字
export interface HookToolCall {
  name: string
  input: Record<string, unknown>
}

export function hookToolCalls(cwd: string, toolName: string, input: unknown): HookToolCall[] {
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(cwd, path))
  if (toolName === 'exec_command') return [{ name: 'Bash', input: { ...fields, command: fields.cmd } }]
  if (toolName === 'apply_patch' && typeof fields.input === 'string') {
    try {
      return parsePatch(fields.input).map((op) =>
        op.kind === 'add' ? { name: 'Write', input: { file_path: absolute(op.path), content: op.content } } : { name: 'Edit', input: { file_path: absolute(op.path) } },
      )
    } catch {
      // 补丁格式不对，工具自己会报错；钩子按整个调用看
    }
  }
  return [{ name: toolName, input: fields }]
}

// matcher 是正则（Claude Code 的写法），空或 * 是全部；写错的正则当普通文字比
function matches(matcher: string, value: string): boolean {
  if (matcher === '' || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(value)
  } catch {
    return matcher === value
  }
}

const posixPath = (path: string) => path.replace(/\\/g, '/')

function capture(stream: NodeJS.ReadableStream, into: { text: string; bytes: number }) {
  stream.on('data', (chunk: Buffer) => {
    if (into.bytes >= MAX_STREAM_BYTES) return
    into.bytes += chunk.length
    into.text += chunk.toString('utf8')
  })
}

function execHook(hook: LoadedPluginHook, input: Record<string, unknown>, context: PluginHookContext): Promise<HookRun | null> {
  const { bashPath } = context
  if (!bashPath) return Promise.resolve(null)
  const timeoutMs = Math.min((hook.timeout ?? Number.POSITIVE_INFINITY) * 1000, MAX_TIMEOUT_MS)
  return new Promise((done) => {
    const root = posixPath(hook.root)
    const child = spawn(bashPath, ['-c', hook.command], {
      cwd: context.cwd,
      env: { ...commandEnv(), CLAUDE_PLUGIN_ROOT: root, DIFFRA_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: posixPath(context.cwd) },
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const stdout = { text: '', bytes: 0 }
    const stderr = { text: '', bytes: 0 }
    capture(child.stdout, stdout)
    capture(child.stderr, stderr)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)
    const onAbort = () => killTree(child.pid)
    context.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (run: HookRun | null) => {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', onAbort)
      done(run)
    }
    child.on('error', (error) => {
      console.error(`[hooks] 插件 ${hook.plugin} 的 ${hook.event} 钩子没跑起来`, error)
      finish(null)
    })
    child.on('close', (code) => {
      if (timedOut) console.error(`[hooks] 插件 ${hook.plugin} 的 ${hook.event} 钩子超过 ${timeoutMs / 1000} 秒，已结束`)
      const text = stdout.text.trim()
      let json: Record<string, unknown> | null = null
      if (text.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(text)
          if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>
        } catch {
          // 不是 JSON 就当普通文字
        }
      }
      if (!timedOut && code !== 0 && code !== 2) console.error(`[hooks] 插件 ${hook.plugin} 的 ${hook.event} 钩子退出码 ${code}：${stderr.text.trim()}`)
      finish(timedOut ? null : { hook, exitCode: code, stdout: text, stderr: stderr.text.trim(), json })
    })
    child.stdin.on('error', () => {
      // 钩子不读标准输入就退出时写入会失败，不影响结果
    })
    child.stdin.end(JSON.stringify(input))
  })
}

// 同一个时机的钩子按顺序跑（Claude Code 是并行，顺序跑更容易看懂谁拦的）
async function runEvent(hooks: LoadedPluginHook[], event: PluginHookEvent, target: string | null, input: Record<string, unknown>, context: PluginHookContext): Promise<HookRun[]> {
  const runs: HookRun[] = []
  for (const hook of hooks) {
    if (hook.event !== event || (target !== null && !matches(hook.matcher, target))) continue
    if (context.signal?.aborted) break
    const run = await execHook(hook, { session_id: context.sessionId, cwd: context.cwd, hook_event_name: event, ...input }, context)
    if (run) runs.push(run)
  }
  return runs
}

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined)
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function additionalContext(run: HookRun): string {
  return text(field(run.json?.hookSpecificOutput, 'additionalContext'))
}

// 拦下的理由：退出码 2 时是标准错误；JSON 里 decision 是 block 时是 reason
function blockReason(run: HookRun): string | null {
  if (run.exitCode === 2) return run.stderr || run.stdout || `blocked by the ${run.hook.plugin} plugin`
  if (run.json?.decision === 'block') return text(run.json.reason) || `blocked by the ${run.hook.plugin} plugin`
  return null
}

function joinContext(parts: Array<{ plugin: string; text: string }>): string | null {
  const shown = parts.filter((part) => part.text !== '')
  if (shown.length === 0) return null
  return shown.map((part) => `[${part.plugin}]\n${part.text}`).join('\n\n').slice(0, MAX_CONTEXT_CHARS)
}

// 会话开始：返回要放进系统提示词的说明（标准输出，或 JSON 的 additionalContext）。
// 打开旧任务时系统提示词也是重新拼的，上次的说明不会留下来，所以每次都按 startup 跑（不少插件只匹配 startup）
export async function sessionStartContext(hooks: LoadedPluginHook[], context: PluginHookContext): Promise<string | null> {
  const runs = await runEvent(hooks, 'SessionStart', 'startup', { source: 'startup' }, context)
  return joinContext(runs.filter((run) => run.exitCode === 0).map((run) => ({ plugin: run.hook.plugin, text: additionalContext(run) || (run.json ? '' : run.stdout) })))
}

// 用户发消息时：拦下（理由给用户看），或者给这条消息补充说明
export async function promptSubmitHooks(hooks: LoadedPluginHook[], prompt: string, context: PluginHookContext): Promise<{ blocked: string | null; context: string | null }> {
  const runs = await runEvent(hooks, 'UserPromptSubmit', null, { prompt }, context)
  for (const run of runs) {
    const reason = blockReason(run)
    if (reason) return { blocked: `${run.hook.plugin}：${reason}`, context: null }
  }
  return { blocked: null, context: joinContext(runs.filter((run) => run.exitCode === 0).map((run) => ({ plugin: run.hook.plugin, text: additionalContext(run) || (run.json ? '' : run.stdout) }))) }
}

// 工具调用前：任何一个钩子拦下就不执行，返回给模型看的理由
export async function preToolHooks(hooks: LoadedPluginHook[], toolName: string, input: unknown, context: PluginHookContext): Promise<string | null> {
  if (!hooks.some((hook) => hook.event === 'PreToolUse')) return null
  for (const call of hookToolCalls(context.cwd, toolName, input)) {
    for (const run of await runEvent(hooks, 'PreToolUse', call.name, { tool_name: call.name, tool_input: call.input }, context)) {
      const decision = field(run.json?.hookSpecificOutput, 'permissionDecision')
      const reason = decision === 'deny' ? text(field(run.json?.hookSpecificOutput, 'permissionDecisionReason')) || 'denied' : blockReason(run)
      if (reason) return `Blocked by a hook of the ${run.hook.plugin} plugin: ${reason}`
    }
  }
  return null
}

// 工具调用后（成功的才跑）：钩子的反馈接在工具结果后面给模型看
export async function postToolHooks(hooks: LoadedPluginHook[], toolName: string, input: unknown, output: ToolOutput, context: PluginHookContext): Promise<string> {
  if (!hooks.some((hook) => hook.event === 'PostToolUse')) return ''
  // 补丁按实际改了的文件拆；新建的叫 Write
  const calls: HookToolCall[] =
    toolName === 'apply_patch' && output.diffs
      ? output.diffs.map((diff) => ({ name: diff.oldText === null ? 'Write' : 'Edit', input: { file_path: diff.path, ...(diff.oldText === null ? { content: diff.newText } : {}) } }))
      : hookToolCalls(context.cwd, toolName, input)
  const notes: string[] = []
  for (const call of calls) {
    for (const run of await runEvent(hooks, 'PostToolUse', call.name, { tool_name: call.name, tool_input: call.input, tool_response: { output: output.text } }, context)) {
      const note = blockReason(run) ?? additionalContext(run)
      if (note) notes.push(`[A hook of the ${run.hook.plugin} plugin after this call: ${note}]`)
    }
  }
  return notes.length > 0 ? `\n${notes.join('\n')}` : ''
}

// 智能体要停下时：钩子拦下就把理由交回去让它接着做。active 是这一轮已经因为 Stop 钩子接着做过
export async function stopHooks(hooks: LoadedPluginHook[], active: boolean, context: PluginHookContext): Promise<string | null> {
  for (const run of await runEvent(hooks, 'Stop', null, { stop_hook_active: active }, context)) {
    const reason = blockReason(run)
    if (reason) return `${run.hook.plugin}: ${reason}`
  }
  return null
}
