import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { APICallError, simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach } from 'vitest'
import { Checkpoints } from '../src/checkpoint.js'
import { findBash, findRipgrep } from '../src/environment.js'
import type { RulePack, SessionChecks, SessionLimits, SessionSecurity, TaskProgressView, TurnOutcome } from '../src/protocol.js'
import type { TurnIO } from '../src/session/loop.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { Session, type SessionOptions } from '../src/session/session.js'
import type { ModelCallUsage } from '../src/usage/log.js'

// 主循环各个测试文件共用的：按剧本回复的模型、记录更新的 IO、临时项目和会话

// inputTokens 是这次调用报给 Diffra 的输入 token 数，默认 1000；truncated 时这次回复被输出上限截断；
// raw 是工具参数的原始文本（比如被截断的半截 JSON），不给就用 input 序列化。
// 第 504 步起没有 finish：模型只回文字（不调工具）就是想结束这一轮，结束门禁在这时跑
export type Step = ({ toolCalls: Array<{ name: string; input: unknown; raw?: string }> } | { text: string }) & { inputTokens?: number; truncated?: boolean }
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

export const usageOf = (inputTokens = 1000) => ({
  inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
})

// 按剧本一步一步返回：每次模型调用对应数组里的一项
export function scriptedModel(steps: Step[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: steps.map(stepStream) })
}

// 先说一段话（可以没有）再出错的回复：连接中途断开、服务出错
export function failingStream(text: string | null, error: Error) {
  return {
    stream: simulateReadableStream<StreamPart>({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        ...(text === null ? [] : [{ type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta: text }]),
        { type: 'error' as const, error },
      ],
    }),
  }
}

export const serviceError = (statusCode: number) =>
  new APICallError({ message: `HTTP ${statusCode}`, url: 'http://127.0.0.1:1/chat/completions', requestBodyValues: {}, statusCode, isRetryable: false })

export function stepStream(step: Step, index: number): StreamResult {
  return {
    stream: simulateReadableStream<StreamPart>({
      chunks:
        'text' in step
          ? [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: 't' },
              { type: 'text-delta' as const, id: 't', delta: step.text },
              { type: 'text-end' as const, id: 't' },
              { type: 'finish' as const, finishReason: { unified: step.truncated ? ('length' as const) : ('stop' as const), raw: undefined }, usage: usageOf(step.inputTokens) },
            ]
          : [
              { type: 'stream-start' as const, warnings: [] },
              ...step.toolCalls.map((call, callIndex) => ({
                type: 'tool-call' as const,
                toolCallId: `call-${index}-${callIndex}`,
                toolName: call.name,
                input: call.raw ?? JSON.stringify(call.input),
              })),
              { type: 'finish' as const, finishReason: { unified: step.truncated ? ('length' as const) : ('tool-calls' as const), raw: undefined }, usage: usageOf(step.inputTokens) },
            ],
    }),
  }
}

// 剧本里的工具调用。exec：跑命令；read：用 cat 读文件（第 508 步起没有 read_file）
export const exec = (cmd: string, extra: Record<string, unknown> = {}) => ({ name: 'exec_command', input: { cmd, ...extra } })
export const read = (path: string) => exec(`cat ${path}`)
// apply_patch：lines 是 *** Begin Patch 和 *** End Patch 之间的各行
export const patch = (...lines: string[]) => ({ name: 'apply_patch', input: { input: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') } })
// 新建文件；content 末尾有没有换行都一样，写出来的文件以换行结尾
export const addFile = (path: string, content: string) => patch(`*** Add File: ${path}`, ...content.replace(/\n$/, '').split('\n').map((line) => `+${line}`))
// 把文件里连续的几整行 from 换成 to（按行匹配，不是子串）
export const replaceLines = (path: string, from: string, to: string) =>
  patch(`*** Update File: ${path}`, ...from.split('\n').map((line) => `-${line}`), ...to.split('\n').map((line) => `+${line}`))
export const deleteFile = (path: string) => patch(`*** Delete File: ${path}`)

export function recordingIO(permissionChoice: string | null = 'allow_once'): TurnIO & {
  updates: SessionUpdate[]
  permissionRequests: number
  usage: ModelCallUsage[]
} {
  const io = {
    updates: [] as SessionUpdate[],
    permissionRequests: 0,
    usage: [] as ModelCallUsage[],
    update: async (update: SessionUpdate) => {
      io.updates.push(update)
    },
    requestPermission: async () => {
      io.permissionRequests++
      return permissionChoice
    },
    recordUsage: async (call: ModelCallUsage) => {
      io.usage.push(call)
    },
  }
  return io
}

// 每个测试一个临时项目和检查点目录；在测试文件顶层调一次 useTempProject()
export let project: string
export let checkpointDir: string

export function useTempProject(): void {
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'diffra-loop-'))
    checkpointDir = mkdtempSync(join(tmpdir(), 'diffra-loop-cp-'))
  })
  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(checkpointDir, { recursive: true, force: true })
  })
}

export const NO_RULES = { packs: [], review: false }

export async function makeSession(
  model: MockLanguageModelV4,
  checks: SessionChecks = { afterEdit: null, beforeFinish: null },
  readOnlyPaths: string[] = [],
  review?: { packs: RulePack[]; model: MockLanguageModelV4 },
  security: SessionSecurity = { staticCheck: false, lightScan: false },
  limits: SessionLimits = { compactAtPercent: 70, maxSteps: 100, goalMaxRounds: 5 },
  // 规划、兜底角色的模拟模型；不给就是没配
  roles: { plan?: MockLanguageModelV4; fallback?: MockLanguageModelV4 } = {},
  extra: Partial<SessionOptions> = {},
) {
  const bashPath = await findBash()
  const rules = review ? { packs: review.packs, review: true } : NO_RULES
  const roleModel = (modelId: string, name: string) => ({
    endpoint: { protocol: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:1', apiKey: 'k' },
    modelId,
    contextWindow: 100_000,
    provider: { id: modelId, name },
  })
  return new Session({
    cwd: project,
    config: {
      model: { endpoint: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, modelId: 'mock', contextWindow: 100_000, provider: null },
      reviewModel: null,
      planModel: roles.plan ? roleModel('planner', '规划供应商') : null,
      fallbackModel: roles.fallback ? roleModel('fallback', '兜底供应商') : null,
      checks,
      readOnlyPaths,
      rules,
      permissionMode: 'ask',
      security,
      limits,
      plugins: [],
      checkpointDir,
    },
    environment: { bashPath, rgPath: await findRipgrep() },
    checkpoints: await Checkpoints.open(checkpointDir, project, readOnlyPaths),
    rulePacks: rules.packs,
    systemPrompt: await buildSystemPrompt(bashPath, { checks, readOnlyPaths, rules }, rules.packs),
    model,
    reviewModel: review?.model,
    planModel: roles.plan,
    fallbackModel: roles.fallback,
    ...extra,
  })
}

export function toolUpdates(io: { updates: SessionUpdate[] }, status: 'completed' | 'failed') {
  return io.updates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === status)
}

export const diffraMeta = (update: SessionUpdate) => (update._meta?.diffra ?? {}) as { result?: string; verification?: string }

// 标题以 title 开头的检查卡片，每次结束时记的 result，按出现顺序
export function checkResults(io: { updates: SessionUpdate[] }, title: string) {
  const ids = new Set(io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update.title.startsWith(title) ? [update.toolCallId] : [])))
  return io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call_update' && ids.has(update.toolCallId) ? [diffraMeta(update).result] : []))
}

// 完成卡（结束门禁的结论）的 verification，按出现顺序
export function verifications(io: { updates: SessionUpdate[] }, title = '完成') {
  return io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update.title === title ? [diffraMeta(update).verification] : []))
}

export const infoMeta = (update: SessionUpdate) =>
  (update.sessionUpdate === 'session_info_update' ? update._meta?.diffra ?? {} : {}) as { taskState?: TaskProgressView; turnOutcome?: TurnOutcome }

// 每轮结束时随任务状态发出的 turnOutcome，按出现顺序；一轮只发一次
export function turnOutcomes(io: { updates: SessionUpdate[] }) {
  return io.updates.flatMap((update) => {
    const outcome = infoMeta(update).turnOutcome
    return outcome ? [outcome] : []
  })
}

export function lastTaskState(io: { updates: SessionUpdate[] }) {
  return io.updates
    .flatMap((update) => {
      const state = infoMeta(update).taskState
      return state ? [state] : []
    })
    .at(-1)
}

// 发给模型的对话里 Diffra 补的上下文消息（环境、AGENTS.md）之外的部分：断言消息顺序时用
export function withoutContext<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  return messages.filter((message) => !(message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[Diffra] Context')))
}
