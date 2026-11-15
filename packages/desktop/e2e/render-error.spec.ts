import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, startScriptedModel } from './scripted-model'

// 0.5.2 上界面渲染出错整窗白屏，只能开开发者工具看原因。现在应用根上有错误边界：显示原因和「重新加载界面」，
// 错误连同组件栈记进 logs/renderer.log；重新加载只重载页面，后台在跑的任务照常跑完（core 里跑完，界面跟不上进度）
test('界面渲染出错：显示兜底页、记进 renderer.log，重新加载后照常用，后台任务不停', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-render-error-'))
  writeFileSync(join(project, 'README.md'), '# 示例\n')
  writeFileSync(join(project, 'tick.js'), "let i = 0\nconst timer = setInterval(() => {\n  console.log('tick ' + ++i)\n  if (i >= 60) clearInterval(timer)\n}, 250)\n")
  const model = await startScriptedModel([
    { text: '这是回答' },
    { toolCalls: [exec('node tick.js', { yield_time_ms: 30_000 })] },
    { text: '跑完了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '说一句')
    await waitTaskDone(window)

    // 另起一个任务在后台跑十几秒的命令
    const sidebar = window.getByTestId('sidebar')
    await sidebar.getByRole('button', { name: '新任务', exact: true }).click()
    await window.getByTestId('permission-mode').click()
    await window.getByRole('menuitemradio', { name: /完全访问/ }).click()
    await startTask(window, '跑一下')
    await expect(window.getByTestId('task-status')).toHaveAttribute('data-tone', 'running')

    // 朗读按钮渲染时读系统的声音列表：换成会抛错的，再打开有回答的任务，界面渲染出错
    await window.evaluate(`window.speechSynthesis.getVoices = () => { throw new Error('e2e：声音列表读不了') }`)
    await sidebar.getByRole('button', { name: /说一句/ }).click()
    const crash = window.getByTestId('app-crash')
    await expect(crash).toContainText('界面出错了')
    await expect(crash).toContainText('e2e：声音列表读不了')
    // 顶栏随应用一起没了，兜底页顶上留着能拖动窗口的一条
    await expect(window.locator('.title-bar')).toHaveCSS('-webkit-app-region', 'drag')
    await window.screenshot({ path: test.info().outputPath('render-error.png') })

    const log = join(userDataDir, 'logs', 'renderer.log')
    await expect.poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : '')).toContain('e2e：声音列表读不了')
    expect(readFileSync(log, 'utf8')).toMatch(/组件：[\s\S]*SpeakButton/)

    await crash.getByRole('button', { name: '重新加载界面' }).click()
    await expect(crash).toHaveCount(0)
    await expect(sidebar.getByRole('button', { name: /说一句/ })).toBeVisible()
    // 后台的任务照常跑完（看 core 存下的会话；重载后的界面跟不上它的进度，见 AppErrorBoundary）
    const sessions = join(userDataDir, 'sessions')
    const runState = () => {
      for (const name of readdirSync(sessions).filter((file) => file.endsWith('.json') && file !== 'index.json')) {
        const session = JSON.parse(readFileSync(join(sessions, name), 'utf8')) as { title: string; turns: Array<{ stopReason: string | null }> }
        if (session.title.includes('跑一下')) return session.turns.at(-1)?.stopReason ?? 'running'
      }
      return 'missing'
    }
    await expect.poll(runState, { timeout: 60_000 }).toBe('end_turn')
    expect(model.requests()).toBe(3)
  } finally {
    await app.close()
    await model.close()
  }
})
