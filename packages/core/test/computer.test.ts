import type { PermissionOption, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { ToolResultPart } from 'ai'
import type { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, test } from 'vitest'
import { type ComputerAction, type ComputerActionResult, LOCAL_ONLY_META_KEY, PERMISSION_OPTIONS, type PromptImage } from '../src/protocol.js'
import { toComputerAction } from '../src/session/computer.js'
import { runToolCall, runTurn } from '../src/session/loop.js'
import type { Session } from '../src/session/session.js'
import { makeSession, recordingIO, scriptedModel, useTempProject } from './loop-helpers.js'

// 电脑操控（v2 · M5）：工具什么时候给、参数、按权限模式确认（只在本机）、截图跟着发、失败和取消
useTempProject()

const SHOT: PromptImage = { mimeType: 'image/jpeg', data: 'c2NyZWVu' }

const withComputer = async (model: MockLanguageModelV4, options: { computer?: boolean; images?: boolean } = {}) => {
  const session = await makeSession(model)
  session.config = { ...session.config, computer: options.computer ?? true, model: { ...session.config.model, supportsImages: options.images ?? true } }
  return session
}

const call = (input: Record<string, unknown>) => ({ toolCalls: [{ name: 'computer', input }] })

function fakeComputer(replies: Array<ComputerActionResult | Error> = []) {
  const actions: ComputerAction[] = []
  return {
    actions,
    computer: async (action: ComputerAction) => {
      actions.push(action)
      const reply = replies.shift() ?? { text: 'ok', image: null }
      if (reply instanceof Error) throw reply
      return reply
    },
  }
}

// 记下每次确认请求的标题、选项和 _meta，按顺序给出选择
function askingIO(choices: Array<string | null>) {
  const asked: Array<{ title: string; options: string[]; meta: unknown }> = []
  const io = recordingIO()
  io.requestPermission = async (toolCall: ToolCallUpdate, options: PermissionOption[]) => {
    asked.push({ title: toolCall.title ?? '', options: options.map((option) => option.optionId), meta: toolCall._meta })
    return choices.shift() ?? null
  }
  return { io, asked }
}

const results = (session: Session) =>
  session.messages.flatMap((message) => (message.role === 'tool' ? message.content.filter((part): part is ToolResultPart => part.type === 'tool-result') : []))
const text = (part: ToolResultPart | undefined) => (part?.output.type === 'text' || part?.output.type === 'error-text' ? part.output.value : '')

describe('电脑操控', () => {
  test('设置里开了、模型能看图才给工具', async () => {
    expect(Object.keys((await withComputer(scriptedModel([]))).toolSet())).toContain('computer')
    expect(Object.keys((await withComputer(scriptedModel([]), { computer: false })).toolSet())).not.toContain('computer')
    expect(Object.keys((await withComputer(scriptedModel([]), { images: false })).toolSet())).not.toContain('computer')
    expect(Object.keys((await makeSession(scriptedModel([]))).toolSet())).not.toContain('computer')
  })

  test('只给主智能体：子智能体（带 scope）调了也不执行、不问', async () => {
    const session = await withComputer(scriptedModel([]))
    const fake = fakeComputer()
    const { io, asked } = askingIO([PERMISSION_OPTIONS.allowOnce])
    const scope = { beforeWrite: () => {}, onEdited: () => {} }
    await runToolCall(session, { toolCallId: 'c1', toolName: 'computer', input: { action: 'click', x: 1, y: 1 }, invalid: null }, new AbortController().signal, { ...io, computer: fake.computer }, scope)
    expect(fake.actions).toEqual([])
    expect(asked).toEqual([])
  })

  test('参数：点击、双击、右键、拖动、输入、按键、滚动；缺坐标、负坐标、乱写的按键报错', () => {
    expect(toComputerAction({ action: 'click', x: 10, y: 20 })).toEqual({ action: 'click', x: 10, y: 20, button: 'left', count: 1 })
    expect(toComputerAction({ action: 'double_click', x: 1, y: 2 })).toEqual({ action: 'click', x: 1, y: 2, button: 'left', count: 2 })
    expect(toComputerAction({ action: 'right_click', x: 1, y: 2 })).toEqual({ action: 'click', x: 1, y: 2, button: 'right', count: 1 })
    expect(toComputerAction({ action: 'drag', x: 1, y: 2, to_x: 30, to_y: 40 })).toEqual({ action: 'drag', x: 1, y: 2, toX: 30, toY: 40 })
    expect(toComputerAction({ action: 'type', text: '你好' })).toEqual({ action: 'type', text: '你好' })
    expect(toComputerAction({ action: 'key', keys: 'Ctrl+Shift+T' })).toEqual({ action: 'key', keys: 'Ctrl+Shift+T' })
    expect(toComputerAction({ action: 'scroll', x: 5, y: 5 })).toEqual({ action: 'scroll', x: 5, y: 5, direction: 'down', amount: 3 })
    expect(toComputerAction({ action: 'cursor_position' })).toEqual({ action: 'cursor' })
    expect(() => toComputerAction({ action: 'click', x: 10 })).toThrow('needs both x and y')
    expect(() => toComputerAction({ action: 'move', x: -1, y: 0 })).toThrow('must not be negative')
    expect(() => toComputerAction({ action: 'key', keys: 'Ctrl+ C; rm -rf' })).toThrow()
    expect(() => toComputerAction({ action: 'type' })).toThrow('needs text')
  })

  test('看屏幕问一次（可以本会话允许），截图跟在结果后面发给模型；动鼠标键盘每一步都问；确认只在本机弹', async () => {
    const model = scriptedModel([call({ action: 'screenshot' }), call({ action: 'click', x: 100, y: 50 }), call({ action: 'screenshot' }), call({ action: 'type', text: 'hello' }), { text: '好了' }])
    const session = await withComputer(model)
    const fake = fakeComputer([
      { text: '屏幕 1920×1080，截图 1280×720', image: SHOT, thumbnail: SHOT },
      { text: '点了', image: null },
      { text: '截好了', image: SHOT },
      { text: '输入了', image: null },
    ])
    const { io, asked } = askingIO([PERMISSION_OPTIONS.allowAlways, PERMISSION_OPTIONS.allowOnce, PERMISSION_OPTIONS.allowOnce])
    await runTurn(session, { id: 't', text: '点一下' }, { ...io, computer: fake.computer })
    expect(fake.actions).toEqual([{ action: 'screenshot' }, { action: 'click', x: 100, y: 50, button: 'left', count: 1 }, { action: 'screenshot' }, { action: 'type', text: 'hello' }])
    expect(asked.map((item) => item.title)).toEqual(['让智能体看你的屏幕（截图会发给模型）', '让智能体操作你的电脑：在 (100, 50) 单击', '让智能体操作你的电脑：输入「hello」'])
    expect(asked[0]!.options).toContain(PERMISSION_OPTIONS.allowAlways)
    expect(asked[1]!.options).not.toContain(PERMISSION_OPTIONS.allowAlways)
    expect(asked.every((item) => JSON.stringify(item.meta).includes(LOCAL_ONLY_META_KEY))).toBe(true)
    expect(text(results(session)[0])).toContain('The screenshot is attached in the next message')
    // 截图作为下一条消息里的图片发给模型
    const images = session.messages.filter((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image' || part.type === 'file'))
    expect(images).toHaveLength(2)
  })

  test('拒绝了不执行，告诉模型别再试；完全放行不问；等待在 core 里等、不发给客户端；客户端报错和取消', async () => {
    const model = scriptedModel([call({ action: 'key', keys: 'Ctrl+C' }), { text: '好' }])
    const session = await withComputer(model)
    const fake = fakeComputer()
    const { io } = askingIO([PERMISSION_OPTIONS.reject])
    await runTurn(session, { id: 't', text: '复制' }, { ...io, computer: fake.computer })
    expect(fake.actions).toEqual([])
    expect(text(results(session)[0])).toContain('did not allow this computer action')

    const fullModel = scriptedModel([call({ action: 'wait', seconds: 0.1 }), call({ action: 'scroll', x: 1, y: 1, direction: 'up' }), call({ action: 'move', x: 9, y: 9 }), { text: '好' }])
    const full = await withComputer(fullModel)
    full.permissionMode = 'full'
    const failing = fakeComputer([{ text: '滚了', image: null }, new Error('鼠标驱动 10 秒没有回应')])
    const quiet = askingIO([])
    await runTurn(full, { id: 't', text: '滚动' }, { ...quiet.io, computer: failing.computer })
    expect(quiet.asked).toEqual([])
    expect(failing.actions).toEqual([{ action: 'scroll', x: 1, y: 1, direction: 'up', amount: 3 }, { action: 'move', x: 9, y: 9 }])
    expect(text(results(full)[0])).toContain('Waited 0.1 seconds')
    expect(text(results(full)[2])).toBe('Computer action failed: 鼠标驱动 10 秒没有回应')

    // 客户端没有电脑操控
    const bare = await withComputer(scriptedModel([call({ action: 'screenshot' }), { text: '好' }]))
    bare.permissionMode = 'full'
    const updates: SessionUpdate[] = []
    await runTurn(bare, { id: 't', text: '看看' }, { ...recordingIO(), update: async (update) => void updates.push(update) })
    expect(text(results(bare)[0])).toBe('Computer control is not available in this client.')
  })
})
