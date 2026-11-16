import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { APICallError, simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, test } from 'vitest'
import type { RulePack, SkillInfo, SkillSource } from '../src/protocol.js'
import { DELEGATE_TOOL } from '../src/session/agents.js'
import { compactManually } from '../src/session/compact.js'
import { runDiagnose } from '../src/session/diagnose.js'
import { runTurn, type TurnIO } from '../src/session/loop.js'
import { MEMORY_HEADING, memoryPrompt, readMemory, rememberTurn } from '../src/session/memory.js'
import { formatPlan, runPlan } from '../src/session/plan.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { READ_ONLY_COMMAND_ERROR } from '../src/session/read-only.js'
import { Session } from '../src/session/session.js'
import type { ModelCallUsage } from '../src/usage/log.js'
import {
  exec,
  makeSession,
  NO_RULES,
  project,
  read,
  recordingIO,
  replaceLines,
  scriptedModel,
  serviceError,
  type Step,
  stepStream,
  turnOutcomes,
  usageOf,
  useTempProject,
  withoutContext,
} from './loop-helpers.js'

// 上下文相关：系统提示词、项目记忆、世界状态（环境和 AGENTS.md 作为对话里的上下文消息）、上下文分项、压缩，
// 以及带着对话只读跑的出计划和定位问题
type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never

useTempProject()

const promptOf = (model: MockLanguageModelV4, index: number) => model.doStreamCalls[index]!.prompt

// 会话里的消息（content 是字符串或分段）和发给模型的消息（分段）都取出文字
function textOf(message: { content: unknown }): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.map((part: { type: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
}

const FULL_CONTEXT = '[Diffra] Context for this task, set by Diffra (not written by the user).'
const CONTEXT_UPDATE = '[Diffra] Context update:'
const isContext = (message: { role: string; content: unknown }) => message.role === 'user' && textOf(message).startsWith('[Diffra] Context')
const SUMMARY_REQUEST = '[Diffra] You are performing a CONTEXT CHECKPOINT COMPACTION.'
const SUMMARY_HEADER = '[Diffra] Earlier parts of this conversation were compacted to save context.'

describe('项目记忆', () => {
  test('一轮结束后挑出要记的事追加到记忆文件：不重复、不记密钥；写进新会话的系统提示词；没开时不调模型', async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), 'diffra-loop-memory-'))
    try {
      const fakeKey = 'gh' + 'p_' + 'a'.repeat(36)
      const reviewer = scriptedModel([
        { text: ['- 这个项目用 pnpm，不用 npm', `- 密钥是 ${fakeKey}`, '随便一句不是条目的话'].join('\n') },
        { text: ['- 这个项目用 pnpm，不用 npm', '- 提交信息用中文'].join('\n') },
        { text: 'NONE' },
      ])
      const base = await makeSession(scriptedModel([]))
      const sessionWith = (dir: string | null, reviewModel: MockLanguageModelV4) =>
        new Session({ cwd: project, config: { ...base.config, memoryDir: dir }, environment: base.environment, checkpoints: null, rulePacks: [], systemPrompt: base.systemPrompt, model: scriptedModel([]), reviewModel })
      const session = sessionWith(memoryDir, reviewer)
      session.startTurn('t1', '以后这个项目都用 pnpm')
      session.recordUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的，改用 pnpm 了' } })
      const turn = session.turns[0]!
      const usage: ModelCallUsage[] = []
      const record = async (call: ModelCallUsage) => void usage.push(call)

      expect(await rememberTurn(session, turn, record)).toEqual(['- 这个项目用 pnpm，不用 npm'])
      expect(await rememberTurn(session, turn, record)).toEqual(['- 提交信息用中文'])
      expect(await rememberTurn(session, turn, record)).toEqual([])
      expect(await readMemory(memoryDir)).toEqual(['- 这个项目用 pnpm，不用 npm', '- 提交信息用中文'])
      expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).not.toContain(fakeKey)
      expect(usage.map((call) => call.role)).toEqual(['reviewer', 'reviewer', 'reviewer'])
      // 提取时带着已有的记忆和这一轮的问答
      const second = JSON.stringify(reviewer.doStreamCalls[1]?.prompt)
      expect(second).toContain('这个项目用 pnpm，不用 npm')
      expect(second).toContain('以后这个项目都用 pnpm')
      expect(second).toContain('好的，改用 pnpm 了')

      const prompt = await buildSystemPrompt(null, { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: NO_RULES }, [], {
        skills: [],
        frontend: null,
        memory: memoryPrompt(await readMemory(memoryDir)),
      })
      expect(prompt).toContain(`${MEMORY_HEADING}\n- 这个项目用 pnpm，不用 npm\n- 提交信息用中文`)

      const unused = scriptedModel([{ text: '- 不该被调用' }])
      expect(await rememberTurn(sessionWith(null, unused), turn, record)).toEqual([])
      expect(unused.doStreamCalls).toHaveLength(0)
    } finally {
      rmSync(memoryDir, { recursive: true, force: true })
    }
  })
})

describe('系统提示词', () => {
  const options = { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: NO_RULES }

  test('写明只做要求的事、失败先找原因、不走破坏性捷径、如实汇报；有 bash 时不让过滤测试输出，没有 bash 时说明跑不了命令', async () => {
    const withBash = await buildSystemPrompt('/usr/bin/bash', options, [])
    expect(withBash).toContain('Do what was asked and nothing more')
    expect(withBash).toContain('find the cause before changing approach')
    expect(withBash).toContain('--no-verify')
    expect(withBash).toContain('without piping their output through head, tail or grep')
    expect(withBash).toContain('Report results honestly: say which checks you actually ran and what they showed. If you could not verify something, say so.')
    const noBash = await buildSystemPrompt(null, options, [])
    expect(noBash).not.toContain('head, tail or grep')
    expect(noBash).toContain('exec_command is unavailable because bash was not found.')
  })

  test('配了检查命令时说明结束这一轮时 Diffra 自动跑（beforeFinish 优先）、没过就接着修，改的过程中不要自己跑', async () => {
    const prompt = await buildSystemPrompt(null, { ...options, checks: { afterEdit: 'pnpm typecheck', beforeFinish: 'pnpm test' } }, [])
    expect(prompt).toContain('When you end your turn after changing source, types, dependencies, build scripts or tests, Diffra runs `pnpm test` automatically.')
    expect(prompt).toContain('Turns that only answer, read, or change documentation do not run it.')
    expect(prompt).toContain('If it fails, you get the errors and continue: fix them and end your turn again.')
    expect(prompt).toContain('Do not run that command yourself while you are still changing code')
    expect(prompt).not.toContain('pnpm typecheck')
    const afterEditOnly = await buildSystemPrompt(null, { ...options, checks: { afterEdit: 'pnpm typecheck', beforeFinish: null } }, [])
    expect(afterEditOnly).toContain('Diffra runs `pnpm typecheck` automatically.')
  })

  test('牵动多个文件的改动用一个 apply_patch 一起改；改文件只能用 apply_patch', async () => {
    const prompt = await buildSystemPrompt('/usr/bin/bash', options, [])
    expect(prompt).toContain('apply_patch is the only way to create, change, delete or rename files; do not write files with shell commands.')
    expect(prompt).toContain('One patch can change several files: change everything a change touches (a signature, a type, a renamed export) in one patch.')
  })

  test('没有「做完了」的工具：做完就结束这一轮；提示词里不再提已删掉的工具', async () => {
    const prompt = await buildSystemPrompt('/usr/bin/bash', { ...options, checks: { afterEdit: null, beforeFinish: 'pnpm test' } }, [])
    expect(prompt).toContain('End your turn when the work is done, or when you genuinely need the user.')
    for (const removed of ['call finish', 'verify_changes', 'task_progress', 'todo_write', 'read_file', 'edit_file', 'run_command', 'list_files']) {
      expect(prompt).not.toContain(removed)
    }
  })

  test('update_plan 只用于多阶段或一次多件事；子智能体那一份没有计划、提问和派工，做完交报告', async () => {
    const main = await buildSystemPrompt('/usr/bin/bash', options, [])
    expect(main).toContain('Use update_plan for work with several distinct phases, or when the user asked for several things.')
    expect(main).toContain('Do not use it for questions or for simple changes you can make in a few actions')
    expect(main).toContain('ask with ask_user instead of guessing')
    const worker = await buildSystemPrompt('/usr/bin/bash', options, [], { skills: [], frontend: null, worker: true })
    expect(worker).toContain('Keep going until your part is fully done, then report.')
    expect(worker).not.toContain('## Planning')
    expect(worker).not.toContain('update_plan')
    expect(worker).not.toContain('ask_user')
    expect(worker).not.toContain('delegate')
  })

  test('没配检查命令时要求模型自己验证', async () => {
    const prompt = await buildSystemPrompt(null, options, [])
    expect(prompt).toContain('No project checks are configured: after changing code, verify it yourself, for example by running the relevant tests.')
  })

  test('AGENTS.md 和环境不在系统提示词里：只说明它们已经在上下文消息里、不用再读，[Diffra] 开头的消息不是用户写的', async () => {
    writeFileSync(join(project, 'AGENTS.md'), '用 pnpm，不要用 npm\n')
    const prompt = await buildSystemPrompt('/usr/bin/bash', options, [])
    expect(prompt).toContain('The files from the project root down to the working directory are already in your context; do not read them again.')
    expect(prompt).toContain('Messages that start with "[Diffra]" or that hold <environment_context>, AGENTS.md instructions or <turn_aborted> come from Diffra, not from the user')
    expect(prompt).not.toContain('用 pnpm')
    expect(prompt).not.toContain('<cwd>')
    expect(prompt).not.toContain('<current_date>')
    expect(prompt).not.toContain(project)
  })
})

describe('系统提示词里的 Skill 索引和前端做法', () => {
  const base = { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: NO_RULES }
  const skill = (name: string, source: SkillSource, description = '说明'): SkillInfo => ({ name, description, source, dir: `C:\\skills\\${name}` })

  test('没有 Skill、不是前端项目时都不写', async () => {
    const prompt = await buildSystemPrompt(null, base, [])
    expect(prompt).not.toContain('Skills: instructions')
    expect(prompt).not.toContain('Front-end work')
  })

  test('Skill 索引：名称、截短的描述和 SKILL.md 的位置；项目和内置的排在兼容读取的前面；放不下的只写条数', async () => {
    const long = 'x'.repeat(400)
    const skills = [
      skill('zeta', 'claude', long),
      skill('frontend-design', 'builtin', 'Guidance\nfor design'),
      skill('mine', 'project'),
      ...Array.from({ length: 30 }, (_, index) => skill(`extra-${index}`, 'codex', long)),
    ]
    const prompt = await buildSystemPrompt(null, base, [], { skills, frontend: null })
    const index = prompt.slice(prompt.indexOf('Skills: instructions'))
    expect(index).toContain("read its SKILL.md (cat it) before you start and follow it")
    expect(index).toContain('- mine: 说明 (C:/skills/mine/SKILL.md)')
    expect(index).toContain('- frontend-design: Guidance for design (C:/skills/frontend-design/SKILL.md)')
    expect(index.indexOf('- mine:')).toBeLessThan(index.indexOf('- frontend-design:'))
    expect(index.indexOf('- frontend-design:')).toBeLessThan(index.indexOf('- zeta:'))
    expect(index).toContain(`- zeta: ${'x'.repeat(150)}… (C:/skills/zeta/SKILL.md)`)
    const entries = index.split('\n').filter((line) => line.startsWith('- '))
    expect(entries.join('\n').length).toBeLessThanOrEqual(2000)
    expect(index).toContain(`(${skills.length - entries.length} more skills are installed but not listed here`)
  })

  test('前端项目：先跟着项目已有的设计走；开了浏览器才让它检查页面，能看图才让它截图；子智能体不开页面', async () => {
    const off = await buildSystemPrompt(null, base, [], { skills: [], frontend: { browser: false, screenshots: false } })
    expect(off).toContain('## Front-end work (this project has UI code)')
    expect(off).toContain('Reuse those components, colors, spacing and font sizes')
    expect(off).toContain('The built-in browser is off')
    expect(off).not.toContain('browser_check_layout')
    expect(off).not.toContain('frontend-design skill')

    const text = await buildSystemPrompt(null, base, [], { skills: [skill('frontend-design', 'builtin')], frontend: { browser: true, screenshots: false } })
    expect(text).toContain('run browser_check_layout')
    expect(text).toContain('(read the frontend-design skill listed below)')
    expect(text).not.toContain('browser_screenshot with width')
    expect(text.indexOf('Front-end work')).toBeLessThan(text.indexOf('Skills: instructions'))

    const vision = await buildSystemPrompt(null, base, [], { skills: [], frontend: { browser: true, screenshots: true } })
    expect(vision).toContain('browser_screenshot with width 1280 and with width 375')

    const worker = await buildSystemPrompt(null, base, [], { skills: [], frontend: { browser: true, screenshots: true }, worker: true })
    expect(worker).toContain('You cannot open pages yourself; after a visible change, say in your report which screens should be checked.')
    expect(worker).not.toContain('browser_check_layout')
  })
})

describe('系统提示词里的保护说明', () => {
  test('写明受保护文件；配了禁写目录时提示词只让模型看环境里的列表，具体目录在上下文消息的 <read_only_paths> 里', async () => {
    const options = { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: ['data', 'uploads'], rules: NO_RULES }
    const prompt = await buildSystemPrompt(null, options, [])
    expect(prompt).toContain('Files that may contain secrets (.env, private keys, credential files such as .npmrc) are protected: apply_patch cannot change them')
    expect(prompt).toContain("Never change anything under the read-only paths listed in the environment context: they hold the user's data. Reading them is fine.")
    expect(prompt).not.toContain('data, uploads')
    expect(await buildSystemPrompt(null, { ...options, readOnlyPaths: [] }, [])).not.toContain('read-only paths listed')

    const session = await makeSession(scriptedModel([{ text: '好的' }]), undefined, ['data', 'uploads'])
    await runTurn(session, { id: 't', text: '看看' }, recordingIO())
    expect(textOf(session.messages[0]!)).toContain('  <read_only_paths>data, uploads</read_only_paths>\n')
    // 用户用中文说话：环境上下文里写明用中文（第 624 步）
    expect(textOf(session.messages[0]!)).toContain('  <user_language>Chinese: ')
  })
})

describe('系统提示词里的编码规范', () => {
  const pack: RulePack = {
    id: 'sample',
    name: '示例',
    languages: ['*'],
    source: '',
    license: '',
    rules: [{ id: 'GEN-ERR-1', level: 'required', section: null, text: '不吞异常。' }],
  }
  const checks = { afterEdit: null, beforeFinish: null }

  test('排在提示词最后，写明优先级低于用户和 AGENTS.md、只约束写或改的代码；没开审查时不提审查', async () => {
    const prompt = await buildSystemPrompt('/usr/bin/bash', { checks, readOnlyPaths: [], rules: { packs: [pack], review: false } }, [pack], {
      skills: [{ name: 'mine', description: '说明', source: 'project', dir: '/skills/mine' }],
      frontend: null,
      memory: '- 用 pnpm',
    })
    const rulesAt = prompt.indexOf('Coding rules')
    expect(rulesAt).toBeGreaterThan(prompt.indexOf('## apply_patch'))
    expect(rulesAt).toBeGreaterThan(prompt.indexOf('Skills: instructions'))
    expect(rulesAt).toBeGreaterThan(prompt.indexOf(MEMORY_HEADING))
    const rules = prompt.slice(rulesAt)
    expect(rules).toContain("They rank below the user's instructions and AGENTS.md: when they conflict, follow those.")
    expect(rules).toContain('Apply them to the code you write or change; do not rewrite unrelated existing code just to satisfy them.')
    expect(rules.endsWith('### 示例\n- GEN-ERR-1: 不吞异常。')).toBe(true)
    expect(prompt).not.toContain('a reviewer checks your changes')
  })

  test('开了审查时告诉模型结束这一轮后会按规则审查；子智能体那一份不提审查；没有选中的包就不写这一段', async () => {
    const reviewed = await buildSystemPrompt(null, { checks, readOnlyPaths: [], rules: { packs: [pack], review: true } }, [pack])
    expect(reviewed).toContain('When you end your turn after changing code, a reviewer checks your changes against these rules and reports violations by rule ID.')
    const worker = await buildSystemPrompt(null, { checks, readOnlyPaths: [], rules: { packs: [pack], review: true } }, [pack], { skills: [], frontend: null, worker: true })
    expect(worker).toContain('- GEN-ERR-1: 不吞异常。')
    expect(worker).not.toContain('a reviewer checks your changes')
    const none = await buildSystemPrompt(null, { checks, readOnlyPaths: [], rules: { packs: [pack], review: true } }, [])
    expect(none).not.toContain('Coding rules')
  })
})

describe('世界状态', () => {
  const AGENTS = '用 pnpm，不要用 npm\n'
  const agentsBlock = (text: string) => `# AGENTS.md instructions for ${project}\n\n<INSTRUCTIONS>\n--- AGENTS.md ---\n${text}\n</INSTRUCTIONS>`

  test('第一轮对话的第一条是全量上下文消息（环境和 AGENTS.md），提问在它后面；系统提示词里没有这些', async () => {
    writeFileSync(join(project, 'AGENTS.md'), AGENTS)
    const model = scriptedModel([{ text: '好的' }])
    const session = await makeSession(model)
    await runTurn(session, { id: 't1', text: '介绍一下项目' }, recordingIO())

    const context = textOf(session.messages[0]!)
    expect(session.messages[0]?.role).toBe('user')
    expect(context.startsWith(`${FULL_CONTEXT} Later context updates replace the matching parts.\n\n<environment_context>\n  <cwd>${project}</cwd>\n  <operating_system>`)).toBe(true)
    expect(context).toContain('  <shell>')
    expect(context).toMatch(/ {2}<current_date>\d{4}-\d{2}-\d{2}<\/current_date>\n {2}<timezone>[^<]+<\/timezone>/)
    expect(context).toContain("  <approvals>Commands that only read run without asking. Other commands need the user's approval")
    expect(context).not.toContain('<read_only_paths>')
    expect(context.endsWith(`</environment_context>\n\n${agentsBlock('用 pnpm，不要用 npm')}`)).toBe(true)
    expect(session.messages[1]).toEqual({ role: 'user', content: '介绍一下项目' })

    const sent = promptOf(model, 0)
    expect(sent.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(textOf(sent[0]!)).toBe(session.systemPrompt)
    expect(textOf(sent[1]!)).toBe(context)
    expect(textOf(sent[2]!)).toBe('介绍一下项目')
    expect(session.systemPrompt).not.toContain('用 pnpm')
    expect(session.systemPrompt).not.toContain(project)
  })

  test('一轮中途 AGENTS.md 改了：下一步调模型前追加一条替换说明；下一轮开始前删掉了：提问前追加「不再适用」', async () => {
    writeFileSync(join(project, 'AGENTS.md'), AGENTS)
    const model = scriptedModel([{ toolCalls: [replaceLines('AGENTS.md', '用 pnpm，不要用 npm', '用 npm')] }, { text: '改好了' }, { text: '没有了' }])
    const session = await makeSession(model)
    await runTurn(session, { id: 't1', text: '把规则改成用 npm' }, recordingIO())

    const update = `${CONTEXT_UPDATE}\n\nThese AGENTS.md instructions replace all previously provided AGENTS.md instructions.\n\n${agentsBlock('用 npm')}`
    const second = promptOf(model, 1)
    expect(second.map((message) => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'user'])
    expect(textOf(second.at(-1)!)).toBe(update)

    rmSync(join(project, 'AGENTS.md'))
    await runTurn(session, { id: 't2', text: '还有项目规则吗' }, recordingIO())
    const turnStart = session.messages.findIndex((message) => message.content === '还有项目规则吗')
    expect(session.messages[turnStart - 1]).toEqual({ role: 'user', content: `${CONTEXT_UPDATE}\n\nThe previously provided AGENTS.md instructions no longer apply.` })
    expect(session.messages.filter(isContext).map(textOf)).toEqual([expect.stringMatching(/^\[Diffra\] Context for this task/), update, `${CONTEXT_UPDATE}\n\nThe previously provided AGENTS.md instructions no longer apply.`])
  }, 30_000)

  test('权限模式中途变了：下一步调模型前追加只含环境的更新，AGENTS.md 没变不重发', async () => {
    writeFileSync(join(project, 'AGENTS.md'), AGENTS)
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    const model = scriptedModel([{ toolCalls: [read('a.txt')] }, { text: '看完了' }])
    const session = await makeSession(model)
    const io = recordingIO()
    // 用户在模型跑命令时把权限切到完全放行
    const switching: TurnIO = {
      ...io,
      update: async (update) => {
        if (update.sessionUpdate === 'tool_call') session.permissionMode = 'full'
        await io.update(update)
      },
    }
    await runTurn(session, { id: 't1', text: '看看 a.txt' }, switching)

    const second = promptOf(model, 1)
    expect(second.map((message) => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'user'])
    const update = textOf(second.at(-1)!)
    expect(update.startsWith(`${CONTEXT_UPDATE}\n\n<environment_context>\n  <cwd>${project}</cwd>`)).toBe(true)
    expect(update).toContain('  <approvals>Commands run without asking, except dangerous ones that are always blocked and changes under read-only paths.</approvals>')
    expect(update.endsWith('</environment_context>')).toBe(true)
    expect(update).not.toContain('AGENTS.md')
  }, 30_000)

  test('环境和 AGENTS.md 都没变时不追加：两轮、多步下来对话里只有第一条上下文消息', async () => {
    writeFileSync(join(project, 'AGENTS.md'), AGENTS)
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    const model = scriptedModel([{ toolCalls: [read('a.txt')] }, { text: '看完了' }, { text: '还是 hello' }])
    const session = await makeSession(model)
    await runTurn(session, { id: 't1', text: '看看 a.txt' }, recordingIO())
    await runTurn(session, { id: 't2', text: '再说一遍' }, recordingIO())

    expect(session.messages.filter(isContext)).toHaveLength(1)
    expect(isContext(session.messages[0]!)).toBe(true)
    expect(withoutContext(session.messages).map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant'])
    for (let index = 0; index < 3; index++) expect(promptOf(model, index).filter(isContext)).toHaveLength(1)
  }, 30_000)

  test('子智能体从头开对话：第一条是全量上下文消息，第二条才是任务', async () => {
    writeFileSync(join(project, 'AGENTS.md'), AGENTS)
    const task = '看看 a.txt 里写了什么，交回一句话'
    const model = scriptedModel([
      { toolCalls: [{ name: DELEGATE_TOOL, input: { name: '读文件', task } }] },
      { toolCalls: [{ name: 'report', input: { summary: 'a.txt 不存在' } }] },
      { text: '它说 a.txt 不存在' },
    ])
    const session = await makeSession(model)
    await runTurn(session, { id: 't1', text: '派人看看 a.txt' }, recordingIO())

    const worker = promptOf(model, 1)
    expect(worker.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(textOf(worker[0]!).startsWith(session.workerPrompt)).toBe(true)
    expect(textOf(worker[0]!)).not.toContain('用 pnpm')
    const context = textOf(worker[1]!)
    expect(context.startsWith(`${FULL_CONTEXT} Later context updates replace the matching parts.\n\n<environment_context>\n  <cwd>${project}</cwd>`)).toBe(true)
    expect(context.endsWith(agentsBlock('用 pnpm，不要用 npm'))).toBe(true)
    expect(textOf(worker[2]!).startsWith(`${task}\n\n`)).toBe(true)
  }, 30_000)

  test('出计划时带着上下文：会话还没发过就补全量，发过且没变不重复，AGENTS.md 改了只补更新；都不写进会话的对话', async () => {
    writeFileSync(join(project, 'AGENTS.md'), AGENTS)
    const plan = { understanding: '理解', steps: [{ title: '改', detail: '改一下', files: ['a.txt'] }], risks: [] }
    const submit: Step = { toolCalls: [{ name: 'submit_plan', input: plan }] }
    const model = scriptedModel([submit, { text: '好的' }, submit, submit])
    const session = await makeSession(model)

    await runPlan(session, { id: 'plan-1', text: '出个计划' }, recordingIO())
    const first = promptOf(model, 0)
    expect(first.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(textOf(first[1]!).startsWith(FULL_CONTEXT)).toBe(true)
    expect(textOf(first[1]!)).toContain(agentsBlock('用 pnpm，不要用 npm'))
    expect(textOf(first[2]!)).toBe('出个计划')
    expect(session.messages).toEqual([])

    await runTurn(session, { id: 't1', text: '先聊一句' }, recordingIO())
    const before = JSON.stringify(session.messages)
    await runPlan(session, { id: 'plan-2', text: '再出个计划' }, recordingIO())
    expect(promptOf(model, 2).slice(1).map(textOf)).toEqual([textOf(session.messages[0]!), '先聊一句', '好的', '再出个计划'])

    writeFileSync(join(project, 'AGENTS.md'), '用 npm\n')
    await runPlan(session, { id: 'plan-3', text: '按新规则出计划' }, recordingIO())
    const third = promptOf(model, 3).slice(1).map(textOf)
    expect(third.slice(-2)).toEqual([`${CONTEXT_UPDATE}\n\nThese AGENTS.md instructions replace all previously provided AGENTS.md instructions.\n\n${agentsBlock('用 npm')}`, '按新规则出计划'])
    expect(JSON.stringify(session.messages)).toBe(before)
  }, 30_000)
})

describe('上下文分项', () => {
  type Breakdown = { system: number; rules: number; tools: number; messages: number }
  const breakdownOf = (io: { updates: SessionUpdate[] }) => {
    const usage = io.updates.find((update) => update.sessionUpdate === 'usage_update')
    return (usage as { _meta?: { diffra?: Breakdown } } | undefined)?._meta?.diffra
  }
  const sum = (breakdown: Breakdown) => breakdown.system + breakdown.rules + breakdown.tools + breakdown.messages

  test('usage_update 带各部分的估算，合计等于模型返回的输入 token 数；没有 AGENTS.md 和编码规范时 rules 为 0', async () => {
    const session = await makeSession(scriptedModel([{ text: '好的' }]))
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '介绍一下项目' }, io)
    const breakdown = breakdownOf(io)!
    expect(Math.abs(sum(breakdown) - 1000)).toBeLessThanOrEqual(2)
    expect(breakdown.tools).toBeGreaterThan(0)
    expect(breakdown.system).toBeGreaterThan(0)
    expect(breakdown.messages).toBeGreaterThan(0)
    expect(breakdown.rules).toBe(0)
  })

  test('AGENTS.md 在对话里，但算在 rules 里，不算进 messages', async () => {
    writeFileSync(join(project, 'AGENTS.md'), `${'项目规则：用 pnpm。'.repeat(1000)}\n`)
    const session = await makeSession(scriptedModel([{ text: '好的' }]))
    const io = recordingIO()
    await runTurn(session, { id: 't', text: '介绍一下项目' }, io)
    const breakdown = breakdownOf(io)!
    expect(Math.abs(sum(breakdown) - 1000)).toBeLessThanOrEqual(2)
    expect(breakdown.rules).toBeGreaterThan(0)
    // 对话里除了 AGENTS.md 只有环境和一句提问，AGENTS.md 要是算进 messages，messages 会比 rules 大
    expect(breakdown.rules).toBeGreaterThan(breakdown.messages * 5)
  })
})

describe('上下文压缩', () => {
  const compactionCards = (io: { updates: SessionUpdate[] }) => io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '上下文压缩')
  const cardText = (io: { updates: SessionUpdate[] }) =>
    io.updates
      .filter((update) => update.sessionUpdate === 'tool_call_update')
      .flatMap((update) => (update.content ?? []).flatMap((item) => (item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [])))
      .join('\n')
  const notices = (io: { updates: SessionUpdate[] }) => io.updates.flatMap((update) => (update.sessionUpdate === 'notice' ? [update.title] : []))
  const summaryCalls = (model: MockLanguageModelV4) => model.doStreamCalls.flatMap((call, index) => (call.toolChoice?.type === 'none' ? [index] : []))
  const limits = (compactAtPercent: number) => ({ compactAtPercent, maxSteps: 100, goalMaxRounds: 5 })

  const QUESTION = '找一找登录超时的 TODO 在哪'
  const SUMMARY = '摘要：a.txt 里记着登录超时的 TODO，接下来看 b.txt。'
  // 窗口 10 万、触发点 70%：第一步读 a.txt 时报 7.5 万，下一次调模型前估算超过 7 万，先写摘要；之后读 b.txt、答完。
  // 第二轮（turn-2）留给要接着聊的用例
  async function compactedTurn() {
    writeFileSync(join(project, 'a.txt'), 'MARKER-A 登录超时的 TODO\n')
    writeFileSync(join(project, 'b.txt'), 'MARKER-B\n')
    const model = scriptedModel([{ toolCalls: [read('a.txt')], inputTokens: 75_000 }, { text: SUMMARY }, { toolCalls: [read('b.txt')] }, { text: '找到了' }, { text: '没有别的了' }])
    const session = await makeSession(model)
    const io = recordingIO()
    session.startTurn('turn-1', QUESTION)
    expect(await runTurn(session, { id: 'turn-1', text: QUESTION }, io)).toBe('end_turn')
    return { model, session, io }
  }

  test('估算超过触发点时，下一次调模型前让编码模型写交接摘要：同样的系统提示词和对话前缀，末尾一条压缩要求，不让调工具，看得到工具输出原文', async () => {
    const { model, session, io } = await compactedTurn()
    expect(model.doStreamCalls).toHaveLength(4)
    expect(compactionCards(io)).toHaveLength(1)
    expect(summaryCalls(model)).toEqual([1])

    const request = promptOf(model, 1)
    // 前缀和刚才那次请求一样，能用上提示词缓存
    expect(request.slice(0, promptOf(model, 0).length)).toEqual(promptOf(model, 0))
    expect(request.map((message) => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'user'])
    expect(textOf(request[0]!)).toBe(session.systemPrompt)
    expect(JSON.stringify(request)).toContain('MARKER-A')
    const ask = textOf(request.at(-1)!)
    expect(ask.startsWith(`${SUMMARY_REQUEST} Create a handoff summary for another model`)).toBe(true)
    expect(ask).toContain('approaches that failed and why')
    expect(ask).toContain('the path of each SKILL.md you were following')
    expect(ask).toContain('Do not call tools.')

    expect(io.usage.map((call) => call.role)).toEqual(['coder', 'coder', 'coder', 'coder'])
    expect(cardText(io)).toMatch(/上下文用到约 \d+%。之前的对话压缩成了下面的交接摘要，你说过的话原样保留。/)
    expect(cardText(io)).toContain(SUMMARY)
  }, 30_000)

  test('压缩之后发给模型的是摘要（用户原话在前、交接摘要在后）、重新补的全量上下文和压缩点之后的消息；原文保留；存档恢复后一样；重新生成到压缩点之前时摘要作废', async () => {
    const { model, session } = await compactedTurn()
    const compaction = session.compaction!
    expect(compaction.upTo).toBe(4)
    const summary = compaction.summary
    expect(summary.startsWith(SUMMARY_HEADER)).toBe(true)
    expect(summary).toContain(`<user_message>\n${QUESTION}\n</user_message>`)
    expect(summary.indexOf(QUESTION)).toBeLessThan(summary.indexOf(SUMMARY))
    expect(summary).toContain('Continue from the current state without acknowledging or recapping this summary.')

    // 压缩后的第一步：摘要、重新补的全量上下文，压缩点之前的工具调用和输出都不发
    const afterCompaction = promptOf(model, 2)
    expect(afterCompaction.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(textOf(afterCompaction[1]!)).toBe(summary)
    expect(textOf(afterCompaction[2]!).startsWith(FULL_CONTEXT)).toBe(true)
    expect(textOf(afterCompaction[2]!)).toContain('<environment_context>')
    expect(textOf(session.messages[4]!)).toBe(textOf(afterCompaction[2]!))
    // 再下一步：压缩点之后的消息照常接上
    const next = promptOf(model, 3)
    expect(next.map((message) => message.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool'])
    expect(JSON.stringify(next)).toContain('MARKER-B')
    expect(JSON.stringify(next)).not.toContain('MARKER-A')
    // 原文都还在
    expect(JSON.stringify(session.messages)).toContain('MARKER-A')

    const record = JSON.parse(JSON.stringify(session.toRecord()))
    const resumed = scriptedModel([{ text: '接着找' }])
    const restored = new Session({ cwd: project, config: session.config, environment: session.environment, checkpoints: null, rulePacks: [], systemPrompt: session.systemPrompt, model: resumed, record })
    expect(restored.compaction).toEqual(compaction)
    expect(restored.contextMessages()).toEqual(JSON.parse(JSON.stringify(session.contextMessages())))
    // 重新打开的任务不知道发过什么上下文，补一份全量
    await runTurn(restored, { id: 'turn-2', text: '接着找' }, recordingIO())
    const restoredPrompt = promptOf(resumed, 0)
    expect(textOf(restoredPrompt[1]!)).toBe(summary)
    expect(JSON.stringify(restoredPrompt)).not.toContain('MARKER-A')
    expect(textOf(restoredPrompt.at(-2)!).startsWith(FULL_CONTEXT)).toBe(true)
    expect(textOf(restoredPrompt.at(-1)!)).toBe('接着找')

    // 重新生成压缩点之后开始的一轮，摘要还在；重新生成到压缩点之前，摘要作废
    session.startTurn('turn-2', '还有别的吗')
    await runTurn(session, { id: 'turn-2', text: '还有别的吗' }, recordingIO())
    await session.rewind('turn-2')
    expect(session.compaction).toEqual(compaction)
    await session.rewind('turn-1')
    expect(session.compaction).toBeNull()
    expect(session.messages).toEqual([])
  }, 30_000)

  test('触发点按设置来，最高 90%：设成 90% 时 7.5 万不压缩；设成 95% 时按 90% 算，9.2 万就压缩', async () => {
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    const below = scriptedModel([{ toolCalls: [read('a.txt')], inputTokens: 75_000 }, { text: '看完了' }])
    const belowIO = recordingIO()
    await expect(runTurn(await makeSession(below, undefined, undefined, undefined, undefined, limits(90)), { id: 't', text: '看看 a.txt' }, belowIO)).resolves.toBe('end_turn')
    expect(compactionCards(belowIO)).toHaveLength(0)
    expect(below.doStreamCalls).toHaveLength(2)

    const capped = scriptedModel([{ toolCalls: [read('a.txt')], inputTokens: 92_000 }, { text: '摘要：看了 a.txt。' }, { text: '看完了' }])
    const cappedIO = recordingIO()
    await expect(runTurn(await makeSession(capped, undefined, undefined, undefined, undefined, limits(95)), { id: 't', text: '看看 a.txt' }, cappedIO)).resolves.toBe('end_turn')
    expect(compactionCards(cappedIO)).toHaveLength(1)
    expect(summaryCalls(capped)).toEqual([1])
  }, 30_000)

  test('压缩后 3 步内不再压缩，之后又超过触发点时照样再压；第二次写摘要时看得到上一份摘要', async () => {
    for (const name of ['f1', 'f2', 'f3', 'f4']) writeFileSync(join(project, `${name}.txt`), `${name}\n`)
    const model = scriptedModel([
      { toolCalls: [read('f1.txt')], inputTokens: 75_000 },
      { text: '摘要一：读了 f1。' },
      { toolCalls: [read('f2.txt')], inputTokens: 80_000 },
      { toolCalls: [read('f3.txt')], inputTokens: 80_000 },
      { toolCalls: [read('f4.txt')], inputTokens: 80_000 },
      { text: '摘要二：读了 f1 到 f4。' },
      { text: '都读完了' },
    ])
    const session = await makeSession(model)
    const io = recordingIO()
    session.startTurn('t', '把四个文件都读一遍')
    await expect(runTurn(session, { id: 't', text: '把四个文件都读一遍' }, io)).resolves.toBe('end_turn')

    expect(model.doStreamCalls).toHaveLength(7)
    expect(compactionCards(io)).toHaveLength(2)
    expect(summaryCalls(model)).toEqual([1, 5])
    expect(JSON.stringify(promptOf(model, 5))).toContain('摘要一：读了 f1。')
    expect(session.compaction?.summary).toContain('摘要二：读了 f1 到 f4。')
    expect(session.compaction?.summary).toContain('<user_message>\n把四个文件都读一遍\n</user_message>')
  }, 30_000)

  test('摘要前附上用户每一轮的原话：从最近往前约 2 万 token，放不下的那条截短、更早的略去；Diffra 补的上下文不算用户的话', async () => {
    const prompts = ['第一轮：先看看项目', `第二轮开头 ${'长'.repeat(30_000)} 第二轮结尾`, '第三轮：别动 b.txt', '第四轮：改成用 pnpm']
    const model = scriptedModel([...prompts.map((): Step => ({ text: '好' })), { text: '摘要：按用户要求改用 pnpm。' }])
    const session = await makeSession(model)
    for (const [index, text] of prompts.entries()) {
      session.startTurn(`t${index}`, text)
      await runTurn(session, { id: `t${index}`, text }, recordingIO())
    }
    expect(await compactManually(session, recordingIO())).toBe('end_turn')

    const summary = session.compaction?.summary ?? ''
    expect(summary.match(/<user_message>/g)).toHaveLength(3)
    expect(summary).not.toContain('第一轮')
    // 第二轮 9 万多字节，约 2.25 万 token：截成头尾两段
    expect(summary).toContain('<user_message>\nWarning: truncated output (original token count: 22508)\nTotal output lines: 1\n第二轮开头 长')
    expect(summary).toMatch(/长…\d+ tokens truncated…长/)
    expect(summary).toContain('长 第二轮结尾\n</user_message>')
    expect(summary).toContain('<user_message>\n第三轮：别动 b.txt\n</user_message>\n<user_message>\n第四轮：改成用 pnpm\n</user_message>')
    expect(summary.indexOf('第二轮开头')).toBeLessThan(summary.indexOf('第三轮'))
    expect(summary.indexOf('第四轮')).toBeLessThan(summary.indexOf('摘要：按用户要求改用 pnpm。'))
    expect(Buffer.byteLength(summary)).toBeLessThan(20_000 * 4 + 2_000)
    expect(summary).not.toContain('<environment_context>')
    expect(summary).not.toContain('[Diffra] Context')
  }, 30_000)

  test('写摘要失败时停下并说明，不留半截摘要', async () => {
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    const model = scriptedModel([{ toolCalls: [read('a.txt')], inputTokens: 75_000 }, { text: '' }])
    const session = await makeSession(model)
    const io = recordingIO()

    await expect(runTurn(session, { id: 'turn-1', text: '看看 a.txt' }, io)).resolves.toBe('max_tokens')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(notices(io)).toEqual(['上下文压缩失败，已停止'])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'context-limit' }])
    expect(cardText(io)).toContain('压缩失败：')
    expect(session.compaction).toBeNull()
    expect(session.taskState.status).toBe('blocked')
  }, 30_000)

  test('用户的话本身太长、压缩后仍超过 95% 时停下', async () => {
    writeFileSync(join(project, 'a.txt'), 'hello\n')
    // 约 1.35 万 token 的日志，摘要里原样保留，压缩省不出地方
    const question = `帮我看看这段日志\n${'2026-11-12 ERROR request timed out\n'.repeat(1500)}`
    const model = scriptedModel([{ toolCalls: [read('a.txt')], inputTokens: 97_000 }, { text: '摘要：在看日志。' }, { text: '不会走到这里' }])
    const session = await makeSession(model)
    const io = recordingIO()

    session.startTurn('turn-1', question)
    await expect(runTurn(session, { id: 'turn-1', text: question }, io)).resolves.toBe('max_tokens')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(summaryCalls(model)).toEqual([1])
    expect(notices(io)).toEqual(['上下文压缩后仍然太大，已停止'])
    expect(turnOutcomes(io)).toEqual([{ finish: null, stop: 'context-limit' }])
  }, 30_000)

  test('手动压缩不看百分比：写交接摘要，对话原文和任务状态不变，界面上的用量跟着变小；之后发给模型的是摘要、重新补的上下文和新提问', async () => {
    writeFileSync(join(project, 'a.txt'), 'const value = 1\n'.repeat(150))
    const model = scriptedModel([{ toolCalls: [read('a.txt')] }, { text: '看完了' }, { text: '摘要：看过 a.txt，没有改动。' }, { text: '按摘要接着做' }])
    const session = await makeSession(model)
    session.startTurn('t1', '看看 a.txt')
    await runTurn(session, { id: 't1', text: '看看 a.txt' }, recordingIO())
    const original = JSON.stringify(session.messages)
    const taskState = JSON.stringify(session.taskState)
    const io = recordingIO()

    expect(await compactManually(session, io)).toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(summaryCalls(model)).toEqual([2])
    expect(textOf(promptOf(model, 2).at(-1)!).startsWith(SUMMARY_REQUEST)).toBe(true)
    expect(session.compaction?.upTo).toBe(session.messages.length)
    expect(session.compaction?.summary).toContain('<user_message>\n看看 a.txt\n</user_message>')
    expect(session.compaction?.summary).toContain('摘要：看过 a.txt，没有改动。')
    expect(JSON.stringify(session.messages)).toBe(original)
    expect(JSON.stringify(session.taskState)).toBe(taskState)
    const usage = io.updates.find((update) => update.sessionUpdate === 'usage_update')
    if (usage?.sessionUpdate !== 'usage_update') throw new Error('没有更新上下文用量')
    expect(usage.used).toBeGreaterThan(0)
    expect(usage.used).toBeLessThan(1000)
    expect(cardText(io)).toContain('已手动压缩上下文')
    expect(session.running).toBe(false)

    await runTurn(session, { id: 't2', text: '继续' }, recordingIO())
    const next = promptOf(model, 3)
    expect(next.map((message) => message.role)).toEqual(['system', 'user', 'user', 'user'])
    expect(textOf(next[1]!)).toBe(session.compaction!.summary)
    expect(textOf(next[2]!).startsWith(FULL_CONTEXT)).toBe(true)
    expect(textOf(next[3]!)).toBe('继续')
  }, 30_000)

  test('手动压缩：上次压缩之后没有新的模型回复时不调模型、原样保留；任务进行中不能压缩', async () => {
    const model = scriptedModel([{ text: '摘要：只聊了一句。' }])
    const session = await makeSession(model)
    session.messages.push({ role: 'user', content: '只说了一句，模型还没回' })
    const empty = recordingIO()
    expect(await compactManually(session, empty)).toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(0)
    expect(session.compaction).toBeNull()
    expect(cardText(empty)).toContain('没有可压缩的内容；未调用模型')

    session.messages.push({ role: 'assistant', content: `答复：${'细节'.repeat(500)}` })
    expect(await compactManually(session, recordingIO())).toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(1)
    const compaction = session.compaction
    expect(compaction?.upTo).toBe(2)
    const again = recordingIO()
    expect(await compactManually(session, again)).toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(session.compaction).toBe(compaction)
    expect(cardText(again)).toContain('上次压缩之后还没有新的对话')

    session.activeTurn = new AbortController()
    await expect(compactManually(session, recordingIO())).rejects.toThrow('任务还在进行中')
    session.activeTurn = null
  })

  test('手动压缩：摘要没让上下文变短就不采用', async () => {
    const model = scriptedModel([{ text: `摘要：${'很长的摘要'.repeat(400)}` }])
    const session = await makeSession(model)
    session.messages.push({ role: 'user', content: '改一下标题' }, { role: 'assistant', content: '改好了' })
    const io = recordingIO()
    expect(await compactManually(session, io)).toBe('end_turn')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(session.compaction).toBeNull()
    expect(cardText(io)).toContain('摘要没有让上下文变短，已保留原上下文。')
  })

  test('手动压缩失败或被停止时，已有摘要和消息原文保持不变', async () => {
    const model = scriptedModel([{ text: '' }])
    const session = await makeSession(model)
    session.messages.push({ role: 'user', content: '早期'.repeat(3000) }, { role: 'assistant', content: '回复' }, { role: 'user', content: '最新请求' }, { role: 'assistant', content: '最新回复' })
    const original = JSON.stringify(session.messages)
    const io = recordingIO()
    expect(await compactManually(session, io)).toBe('end_turn')
    expect(session.compaction).toBeNull()
    expect(JSON.stringify(session.messages)).toBe(original)
    expect(cardText(io)).toContain('压缩失败，原上下文保持不变')

    const cancelledIO = recordingIO()
    cancelledIO.update = async (update) => {
      cancelledIO.updates.push(update)
      if (update.sessionUpdate === 'tool_call') session.cancel()
    }
    expect(await compactManually(session, cancelledIO)).toBe('cancelled')
    expect(model.doStreamCalls).toHaveLength(1)
    expect(session.compaction).toBeNull()
    expect(JSON.stringify(session.messages)).toBe(original)
    expect(cardText(cancelledIO)).toContain('已停止，原上下文保持不变。')
    expect(session.running).toBe(false)
  })

  test('重启后没有 lastContext 时，手动压缩仍按存下来的最近用量更新上下文百分比', async () => {
    const model = scriptedModel([{ text: '摘要：保留项目偏好。' }])
    const session = await makeSession(model)
    session.messages.push({ role: 'user', content: `早期需求 ${'历史细节'.repeat(3000)}` }, { role: 'assistant', content: '早期回复' }, { role: 'user', content: '最新请求' })
    session.startTurn('old-turn', '早期需求')
    session.recordUpdate({ sessionUpdate: 'usage_update', used: 1000, size: 10_000, _meta: { diffra: { system: 10, rules: 10, tools: 10, messages: 970 }, cache: { read: 600, write: 20, input: 1000 } } })
    session.recordUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '早期回复' } })
    session.endTurn('end_turn')
    // 重启后 lastContext 只在内存里，加载会话时是空的
    session.lastContext = null
    const io = recordingIO()
    expect(await compactManually(session, io)).toBe('end_turn')
    const usage = io.updates.find((update) => update.sessionUpdate === 'usage_update')
    if (usage?.sessionUpdate !== 'usage_update') throw new Error('没有更新上下文用量')
    expect(usage.used).toBeGreaterThan(0)
    expect(usage.used).toBeLessThan(1000)
    expect(usage._meta).toMatchObject({ cache: { read: 600, write: 20, input: 1000 } })
  })

  test('写摘要的请求本身超出窗口时，每次从最早的消息丢一成再试；从模型回复处切开时前面补一句说明；摘要里用户的原话照样完整', async () => {
    const overflow = () =>
      new APICallError({ message: "This model's maximum context length is 100000 tokens", url: 'http://127.0.0.1:1/chat/completions', requestBodyValues: {}, statusCode: 400, isRetryable: false })
    const answers = ['答一', '答二', '答三'].map((answer) => `${answer}：${'细节'.repeat(100)}`)
    const replies: Array<Step | 'overflow'> = [...answers.map((text): Step => ({ text })), 'overflow', 'overflow', { text: '摘要：三个问题都答了。' }]
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const index = calls++
        const reply = replies[index]
        if (!reply || reply === 'overflow') throw overflow()
        return stepStream(reply, index)
      },
    })
    const session = await makeSession(model)
    for (const [index, text] of ['问题一', '问题二', '问题三'].entries()) {
      session.startTurn(`t${index}`, text)
      await runTurn(session, { id: `t${index}`, text }, recordingIO())
    }
    const context = textOf(session.messages[0]!)
    const io = recordingIO()
    expect(await compactManually(session, io)).toBe('end_turn')

    expect(model.doStreamCalls).toHaveLength(6)
    // 去掉系统提示词和末尾的压缩要求，看每次请求带了哪些对话
    const sent = (index: number) => promptOf(model, index).slice(1, -1).map(textOf)
    expect(sent(3)).toEqual([context, '问题一', answers[0], '问题二', answers[1], '问题三', answers[2]])
    expect(sent(4)).toEqual(['问题一', answers[0], '问题二', answers[1], '问题三', answers[2]])
    expect(sent(5)).toEqual(['[Diffra] Earlier messages were left out to fit the context window.', answers[0], '问题二', answers[1], '问题三', answers[2]])
    expect(session.compaction?.summary).toContain('<user_message>\n问题一\n</user_message>\n<user_message>\n问题二\n</user_message>\n<user_message>\n问题三\n</user_message>')
    expect(session.compaction?.summary).toContain('摘要：三个问题都答了。')
  }, 30_000)

  // 超窗最常见的是一轮里读了很多、很大的输出：这时对话里提问之后全是工具调用和结果，没有别的用户消息
  test('一轮里步骤很多时写摘要的请求超窗：同样从最早的步骤开始丢掉再试，工具调用和结果不拆开', async () => {
    const files = Array.from({ length: 12 }, (_, index) => `f${index + 1}.txt`)
    for (const file of files) writeFileSync(join(project, file), `${file}\n`)
    const replies: Array<Step | 'overflow'> = [
      ...files.map((file, index): Step => ({ toolCalls: [read(file)], inputTokens: index === files.length - 1 ? 75_000 : 1000 })),
      'overflow',
      { text: '摘要：十二个文件都读了。' },
      { text: '读完了' },
    ]
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const index = calls++
        const reply = replies[index]
        if (!reply || reply === 'overflow') {
          throw new APICallError({ message: "This model's maximum context length is 100000 tokens", url: 'http://127.0.0.1:1/chat/completions', requestBodyValues: {}, statusCode: 400, isRetryable: false })
        }
        return stepStream(reply, index)
      },
    })
    const session = await makeSession(model)
    const io = recordingIO()
    session.startTurn('t', '把这些文件都读一遍')

    await expect(runTurn(session, { id: 't', text: '把这些文件都读一遍' }, io)).resolves.toBe('end_turn')
    expect(notices(io)).toEqual([])
    expect(model.doStreamCalls).toHaveLength(15)
    const failed = promptOf(model, 12)
    const retried = promptOf(model, 13)
    expect(textOf(retried.at(-1)!).startsWith(SUMMARY_REQUEST)).toBe(true)
    expect(retried.length).toBeLessThan(failed.length)
    // 丢的是最早的步骤，最近的还在
    expect(JSON.stringify(retried)).not.toContain('f1.txt')
    expect(JSON.stringify(retried)).toContain('f12.txt')
    // 留下的每个工具结果前面都有发起它的那次调用
    const callIds = new Set(retried.flatMap((message) => (message.role === 'assistant' ? message.content.flatMap((part) => (part.type === 'tool-call' ? [part.toolCallId] : [])) : [])))
    const resultIds = retried.flatMap((message) => (message.role === 'tool' ? message.content.flatMap((part) => (part.type === 'tool-result' ? [part.toolCallId] : [])) : []))
    expect(resultIds.length).toBeGreaterThan(0)
    expect(resultIds.filter((id) => !callIds.has(id))).toEqual([])
    expect(session.compaction?.summary).toContain('<user_message>\n把这些文件都读一遍\n</user_message>')
    expect(session.compaction?.summary).toContain('摘要：十二个文件都读了。')
  }, 30_000)
})

describe('先出计划', () => {
  const plan = {
    understanding: '把 a.txt 里的 broken 改成 fixed',
    steps: [{ title: '改 a.txt', detail: '把 broken 换成 fixed\n改完跑一下检查', files: ['a.txt'] }],
    risks: ['b.txt 也引用了这个值，要不要一起改？'],
  }
  const submit: Step = { toolCalls: [{ name: 'submit_plan', input: plan }] }
  const planCards = (io: { updates: SessionUpdate[] }) => io.updates.filter((update) => update.sessionUpdate === 'tool_call' && update.title === '计划')

  test('规划模型只用 exec_command 跑只读命令看代码、交计划：改文件的命令不执行、apply_patch 不可用；计划不进编码模型的对话，用量记成规划', async () => {
    writeFileSync(join(project, 'a.txt'), 'value = broken\n')
    const coder = scriptedModel([])
    const planner = scriptedModel([
      { toolCalls: [exec('ls')] },
      { toolCalls: [read('a.txt')] },
      { toolCalls: [exec("sed -i 's/broken/fixed/' a.txt")] },
      { toolCalls: [replaceLines('a.txt', 'value = broken', 'value = fixed')] },
      submit,
    ])
    const session = await makeSession(coder, undefined, [], undefined, undefined, undefined, { plan: planner })
    const io = recordingIO()

    await expect(runPlan(session, { id: 'plan-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('value = broken\n')
    // 只读命令不用问
    expect(io.permissionRequests).toBe(0)
    const system = promptOf(planner, 0)[0]!
    expect(system.role).toBe('system')
    expect(textOf(system).startsWith(session.systemPrompt)).toBe(true)
    expect(textOf(system)).toContain('PLANNING MODE: this turn only plans the task; nothing gets changed yet.')
    expect(textOf(system)).toContain('run read-only commands with exec_command')
    expect(planner.doStreamCalls[0]?.tools?.map((tool) => tool.name)).toEqual(['exec_command', 'write_stdin', 'submit_plan'])
    expect(JSON.stringify(promptOf(planner, 2))).toContain('value = broken')
    expect(JSON.stringify(promptOf(planner, 3))).toContain(READ_ONLY_COMMAND_ERROR)
    // 不在规划工具里的调用，AI SDK 直接答复模型这个工具不可用
    expect(JSON.stringify(promptOf(planner, 4))).toContain("unavailable tool 'apply_patch'")
    expect(coder.doStreamCalls).toHaveLength(0)
    expect(session.messages).toEqual([])
    expect(io.usage.map((call) => [call.role, call.modelId])).toEqual(Array.from({ length: 5 }, () => ['planner', 'planner']))

    const card = planCards(io)[0]
    expect(card && card.sessionUpdate === 'tool_call' ? card.content : null).toEqual([{ type: 'content', content: { type: 'text', text: formatPlan(plan) } }])
    expect(formatPlan(plan)).toBe(
      ['把 a.txt 里的 broken 改成 fixed', '', '1. 改 a.txt', '   把 broken 换成 fixed', '   改完跑一下检查', '   涉及：a.txt', '', '风险和需要确认的问题：', '- b.txt 也引用了这个值，要不要一起改？'].join('\n'),
    )
  }, 30_000)

  test('上下文快满时要求直接交计划', async () => {
    const planner = scriptedModel([{ toolCalls: [exec('ls')], inputTokens: 85_000 }, submit])
    const session = await makeSession(scriptedModel([]), undefined, [], undefined, undefined, undefined, { plan: planner })

    await expect(runPlan(session, { id: 'plan-1', text: '修复 a.txt' }, recordingIO())).resolves.toBe('end_turn')
    expect(planner.doStreamCalls[0]?.toolChoice).toEqual({ type: 'auto' })
    expect(planner.doStreamCalls[1]?.toolChoice).toEqual({ type: 'tool', toolName: 'submit_plan' })
  })

  test('服务不接受指定工具的 tool_choice（DeepSeek 思考模式）：要求交计划的那一步改用 auto 再发一次', async () => {
    const planner = scriptedModel([{ toolCalls: [exec('ls')], inputTokens: 85_000 }, submit])
    const forward = planner.doStream.bind(planner)
    let rejected = 0
    planner.doStream = async (options) => {
      if (options.toolChoice?.type === 'tool') {
        rejected++
        throw new APICallError({ message: 'Thinking mode does not support this tool_choice', url: 'http://model', requestBodyValues: {}, statusCode: 400, isRetryable: false })
      }
      return forward(options)
    }
    const session = await makeSession(scriptedModel([]), undefined, [], undefined, undefined, undefined, { plan: planner })
    const io = recordingIO()

    await expect(runPlan(session, { id: 'plan-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    expect(rejected).toBe(1)
    expect(planner.doStreamCalls.map((call) => call.toolChoice)).toEqual([{ type: 'auto' }, { type: 'auto' }])
    expect(planCards(io)).toHaveLength(1)
  })

  test('没配规划模型时用编码模型；看得到之前的对话和补上的上下文，提问在最后', async () => {
    const coder = scriptedModel([submit])
    const session = await makeSession(coder)
    session.messages.push({ role: 'user', content: '之前说过：不要动 b.txt' }, { role: 'assistant', content: '好的' })
    const io = recordingIO()

    await expect(runPlan(session, { id: 'plan-1', text: '修复 a.txt' }, io)).resolves.toBe('end_turn')
    const sent = promptOf(coder, 0).slice(1).map(textOf)
    expect(sent).toHaveLength(4)
    expect(sent.slice(0, 2)).toEqual(['之前说过：不要动 b.txt', '好的'])
    expect(sent[2]!.startsWith(FULL_CONTEXT)).toBe(true)
    expect(sent[3]).toBe('修复 a.txt')
    expect(io.usage.map((call) => [call.role, call.modelId])).toEqual([['planner', 'mock']])
    expect(session.messages).toHaveLength(2)
  })
})

describe('定位问题', () => {
  const toolStream = (toolCallId: string, toolName: string, input: unknown) =>
    simulateReadableStream<StreamPart>({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: usageOf() },
      ],
    })
  // 先跑一轮：用 cat 读了 hello.txt，然后模型报错停下；会话照 core 的做法把这一轮记下来。之后的几次调用是定位
  async function stoppedTurn(...diagnosisSteps: Array<ReadableStream<StreamPart> | 'throw'>) {
    writeFileSync(join(project, 'hello.txt'), 'hello\n')
    const steps: Array<ReadableStream<StreamPart> | 'throw'> = [toolStream('call-read', 'exec_command', { cmd: 'cat hello.txt' }), 'throw', ...diagnosisSteps]
    let call = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const step = steps[call++]
        if (!step || step === 'throw') throw serviceError(400)
        return { stream: step }
      },
    })
    const session = await makeSession(model)
    const io = recordingIO()
    const recorded: TurnIO = { ...io, update: async (update) => (session.recordUpdate(update), io.update(update)) }
    session.startTurn('t1', '读一下 hello.txt')
    session.endTurn(await runTurn(session, { id: 't1', text: '读一下 hello.txt' }, recorded))
    session.startTurn('d1', '定位问题：上一轮为什么停下', 'diagnose')
    return { session, model }
  }
  const diagnosisOf = (io: { updates: SessionUpdate[] }) =>
    io.updates.flatMap((update) => (update.sessionUpdate === 'tool_call' && update._meta?.diffra ? [(update._meta.diffra as { diagnosis?: Record<string, unknown> }).diagnosis] : [])).find(Boolean) as
      | { cause: string; evidence: Array<{ itemId: string }>; prompt: string; fallback: boolean; target: { turnId: string } }
      | undefined

  test('带着停下的原因、提示和每一步问当前模型；证据对回对话里那一步，默认答案那一行一定在提示词里', async () => {
    const { session, model } = await stoppedTurn(
      toolStream('call-diagnose', 'submit_diagnosis', {
        cause: '模型服务出错，任务本身没问题',
        evidence: [{ step: 's1', note: '文件已经读过' }, { step: 's9', note: '不存在的步骤' }],
        done: ['读过 hello.txt'],
        remaining: ['回答用户'],
        prompt: '继续，直接回答。',
        questions: [{ question: '要改文件吗？', options: [{ label: '不改', text: '只回答，不改文件。' }, { label: '改', text: '顺手把 hello 改成大写。' }] }],
      }),
    )
    const io = recordingIO()
    expect(await runDiagnose(session, { turnId: 't1', cardId: null }, io)).toBe('end_turn')
    const facts = JSON.stringify(model.doStreamCalls[2]?.prompt)
    expect(facts).toContain('How it ended: 模型调用出错（unknown）')
    expect(facts).toContain('s1 [completed] 执行 cat hello.txt → Exit code: 0 hello')
    expect(facts).toContain('模型调用失败：请求失败：HTTP 400')
    const diagnosis = diagnosisOf(io)!
    expect(diagnosis.cause).toBe('模型服务出错，任务本身没问题')
    expect(diagnosis.evidence.map((item) => item.itemId)).toEqual(['call-read'])
    expect(diagnosis.prompt).toBe('继续，直接回答。\n只回答，不改文件。')
    expect(diagnosis.fallback).toBe(false)
    expect(diagnosis.target.turnId).toBe('t1')
    // 探索过程不进编码模型的对话
    expect(JSON.stringify(session.messages)).not.toContain('submit_diagnosis')
  }, 30_000)

  test('定位只能跑只读命令：改文件的命令不执行，模型收到只能读的说明', async () => {
    const { session, model } = await stoppedTurn(
      toolStream('call-rm', 'exec_command', { cmd: 'rm hello.txt' }),
      toolStream('call-diagnose', 'submit_diagnosis', { cause: '模型服务出错', evidence: [], done: [], remaining: [], prompt: '继续。', questions: [] }),
    )
    const io = recordingIO()
    expect(await runDiagnose(session, { turnId: 't1', cardId: null }, io)).toBe('end_turn')
    expect(readFileSync(join(project, 'hello.txt'), 'utf8')).toBe('hello\n')
    expect(io.permissionRequests).toBe(0)
    expect(JSON.stringify(model.doStreamCalls[3]?.prompt)).toContain(READ_ONLY_COMMAND_ERROR)
    expect(diagnosisOf(io)?.fallback).toBe(false)
  }, 30_000)

  test('定位时模型也出错：提示定位失败，给一份按记录拼的通用提示词', async () => {
    const { session } = await stoppedTurn('throw')
    const io = recordingIO()
    expect(await runDiagnose(session, { turnId: 't1', cardId: null }, io)).toBe('end_turn')
    expect(io.updates.some((update) => update.sessionUpdate === 'notice' && update.title === '定位失败')).toBe(true)
    const diagnosis = diagnosisOf(io)!
    expect(diagnosis.fallback).toBe(true)
    expect(diagnosis.prompt).toContain('上一轮停在了')
    expect(diagnosis.prompt).toContain('已经完成的不要重做')
  }, 30_000)
})
