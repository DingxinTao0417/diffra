import { describe, expect, test } from 'vitest'
import { runTurn } from '../src/session/loop.js'
import { makeSession, recordingIO, scriptedModel, useTempProject } from './loop-helpers.js'

// 下一句建议：用最后一轮最后一次请求的真实上下文做受控 Fork；不执行工具、不写会话
useTempProject()

describe('下一句建议', () => {
  test('正常结束后用完整上下文预测；不改会话，用量记在规划角色', async () => {
    const model = scriptedModel([{ text: '这一轮做完了' }, { text: '要不要把这次的改动补上测试？' }])
    const session = await makeSession(model)
    session.startTurn('turn-1', '改一下登录')
    await runTurn(session, { id: 'turn-1', text: '改一下登录' }, recordingIO())
    session.endTurn('end_turn')
    const messages = session.messages.length
    const usage: Array<{ role: string }> = []

    await expect(session.suggestNextPrompt('turn-1', async (call) => void usage.push({ role: call.role }))).resolves.toBe('要不要把这次的改动补上测试？')
    expect(session.messages).toHaveLength(messages)
    expect(usage).toEqual([{ role: 'planner' }])
    const prompt = model.doStreamCalls.at(-1)?.prompt
    expect(JSON.stringify(prompt)).toContain('这一轮做完了')
    expect(JSON.stringify(prompt)).toContain("propose the single most useful next message")
    expect(model.doStreamCalls.at(-1)?.toolChoice).toEqual({ type: 'none' })
  })

  test('任务还在跑、旧轮次、预测时返回工具调用都不给建议', async () => {
    const running = await makeSession(scriptedModel([]))
    running.startTurn('turn-1', '等等')
    expect(await running.suggestNextPrompt('turn-1')).toBeNull()

    const model = scriptedModel([{ text: '做完了' }, { toolCalls: [{ name: 'exec_command', input: { cmd: 'ls' } }] }])
    const session = await makeSession(model)
    session.startTurn('turn-1', '做点事')
    await runTurn(session, { id: 'turn-1', text: '做点事' }, recordingIO())
    session.endTurn('end_turn')
    expect(await session.suggestNextPrompt('turn-1')).toBeNull()
    expect(await session.suggestNextPrompt('old-turn')).toBeNull()
  })

  test('新一轮开始后旧建议不再可用', async () => {
    const model = scriptedModel([{ text: '第一轮完成' }])
    const session = await makeSession(model)
    session.startTurn('turn-1', '第一轮')
    await runTurn(session, { id: 'turn-1', text: '第一轮' }, recordingIO())
    session.endTurn('end_turn')
    session.startTurn('turn-2', '第二轮')
    expect(await session.suggestNextPrompt('turn-1')).toBeNull()
  })
})
