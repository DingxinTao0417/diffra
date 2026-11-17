import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { SessionStore } from '../../core/src/session/store.ts'
import { chooseProject } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const TURNS = 40
const BURST = 300
const fence = '```'

const answer = (index: number) =>
  [
    `第 ${index + 1} 轮改好了，改的是 \`src/module-${index}.ts\`。`,
    '',
    `${fence}ts`,
    ...Array.from({ length: 12 }, (_, line) => `export const value${index}_${line} = compute(${line})`),
    fence,
    '',
    '| 文件 | 改动 |',
    '| --- | ---: |',
    ...Array.from({ length: 4 }, (_, row) => `| src/module-${row}.ts | +${row * 3} |`),
  ].join('\n')

async function seedLongSession(userDataDir: string, project: string, id: string): Promise<void> {
  const start = Date.parse('2026-11-01T08:00:00.000Z')
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString()
  await new SessionStore(join(userDataDir, 'sessions')).save({
    version: 1,
    id,
    cwd: project,
    title: '流式输出的长任务',
    createdAt: at(0),
    updatedAt: at(TURNS),
    archived: false,
    turns: Array.from({ length: TURNS }, (_, index) => ({
      id: `turn-${index + 1}`,
      kind: 'prompt' as const,
      prompt: `第 ${index + 1} 轮的问题`,
      startedAt: at(index),
      endedAt: at(index + 0.5),
      stopReason: 'end_turn' as const,
      updates: [{ sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text: answer(index) } }],
      skills: [],
      images: [],
      checkpoint: null,
      messageStart: null,
    })),
    messages: [],
    compaction: null,
  })
}

// 装一个假的 React DevTools 钩子：每次提交数一次，并数出这次提交里「不是最后一轮」的轮次下面有多少组件真的重画了。
// 只往这次重画过的子树里走（子节点还是上一版的同一个对象，说明整棵子树跳过了）；组件重画过会带 PerformedWork（flags & 1）
const RENDER_PROBE = `(() => {
  const stats = { commits: 0, oldRenders: 0, names: {} }
  window.__renderStats = stats
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
  const isTurn = (fiber) => fiber.memoizedProps && typeof fiber.memoizedProps === 'object' && 'turn' in fiber.memoizedProps && 'latestWork' in fiber.memoizedProps
  function walk(fiber, inOld) {
    for (let child = fiber.child; child; child = child.sibling) {
      const old = isTurn(child) ? child.memoizedProps.last === false : inOld
      if (old && COMPONENT_TAGS.has(child.tag) && (child.alternate === null || (child.flags & 1) === 1)) {
        stats.oldRenders++
        const type = child.type && (child.type.type ?? child.type.render ?? child.type)
        const name = (type && (type.displayName || type.name)) || 'anonymous'
        stats.names[name] = (stats.names[name] ?? 0) + 1
      }
      if (child.alternate === null || child.child !== child.alternate.child) walk(child, old)
    }
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot: (_id, root) => {
      stats.commits++
      walk(root.current, false)
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    checkDCE: () => undefined,
  }
})()`

// 长任务流式输出时：每来一条更新，前面已经结束的轮次不跟着重画；一口气到的几百条更新合成少数几次重画，
// 不再一条一次整段同步重画，也不会累计到 React 报 #185（Maximum update depth）把界面卡住
test('长任务流式输出：前面的轮次不跟着重画，一口气到的几百条更新合成少数几次重画，不报 #185', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-stream-render-'))
  const sessionId = randomUUID()
  await seedLongSession(userDataDir, project, sessionId)
  const model = await startScriptedModel([])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await app.context().addInitScript(RENDER_PROBE)
    await window.reload()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await window.getByTestId('sidebar').getByRole('button', { name: '流式输出的长任务' }).click()
    await expect(window.getByTestId('turn')).toHaveCount(TURNS, { timeout: 30_000 })
    await expect(window.getByTestId('turn').last()).toContainText(`第 ${TURNS} 轮改好了`)
    expect(await window.evaluate('typeof window.__renderStats')).toBe('object')

    // 主进程一口气转来 BURST 条回复片段，和 core 流式输出时转给界面的消息一样
    await window.evaluate('Object.assign(window.__renderStats, { commits: 0, oldRenders: 0, names: {} })')
    await app.evaluate(
      ({ BrowserWindow }, { sessionId, count }) => {
        const windows = BrowserWindow.getAllWindows()
        for (let index = 0; index < count; index++) {
          // 接在上一轮回答（末尾是表格）后面，先空一行另起一段
          const text = index === count - 1 ? '流式结束' : `${index === 0 ? '\n\n' : ''}片段${index} `
          for (const window of windows) window.webContents.send('session:update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
        }
      },
      { sessionId, count: BURST },
    )
    await expect(window.getByTestId('turn').last()).toContainText('流式结束', { timeout: 60_000 })
    await expect(window.getByTestId('turn').last()).toContainText(`片段${BURST - 2}`)

    const stats = (await window.evaluate('window.__renderStats')) as { commits: number; oldRenders: number; names: Record<string, number> }
    const top = Object.entries(stats.names).sort((a, b) => b[1] - a[1]).slice(0, 8)
    console.log(`流式 ${BURST} 条：提交 ${stats.commits} 次，前面的轮次里重画了 ${stats.oldRenders} 个组件`, top)
    const log = join(userDataDir, 'logs', 'renderer.log')
    const errors = existsSync(log) ? readFileSync(log, 'utf8') : ''
    expect(errors).not.toContain('#185')
    expect(stats.oldRenders).toBe(0)
    expect(stats.commits).toBeLessThan(BURST / 10)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
