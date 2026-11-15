import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, startScriptedModel } from './scripted-model'

// 第 676 步：重新生成之前的那一次留着，能切换着看、并排对比，没改过文件的能换回来
test('重新生成过的一轮：能切到上一次只读地看、和现在这一次并排对比；没改文件的那一次能换回来，模型接着它；改过文件的换不回来；换回去要撤销这一次的文件时先说', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-versions-'))
  const model = await startScriptedModel([
    { text: '第一次：标题叫「早安」。' },
    { text: '第二次：标题叫「你好」。' },
    { text: '接着第一次往下写' },
    { toolCalls: [addFile('note.txt', 'D')] },
    { text: '写好了 note.txt' },
    { text: '这次不写文件了' },
    { text: '只说话的那一次' },
    { toolCalls: [addFile('g.txt', 'G')] },
    { text: '写了 g.txt' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '起个标题')
    await waitTaskDone(window)
    const actions = () => window.getByTestId('turn-actions').last()
    // 有文件要撤销时先弹确认（读完改动才弹）
    const regenerate = async (withFiles = false) => {
      await actions().getByRole('button', { name: '重新生成' }).click()
      if (withFiles) await window.getByTestId('restore-confirm').click()
    }
    const send = async (text: string) => {
      await taskInput(window).fill(text)
      await window.keyboard.press('Control+Enter')
    }

    await regenerate()
    await expect(window.getByTestId('agent-message').last()).toContainText('第二次')
    const turn = window.getByTestId('turn').last()
    const bar = turn.getByTestId('turn-versions')
    await expect(bar.getByTestId('turn-version-position')).toHaveText('第 2/2 次')

    // 切到上一次：只读地看第一次的回答，没有这一轮的操作栏
    await bar.getByRole('button', { name: '上一次' }).click()
    await expect(bar.getByTestId('turn-version-position')).toHaveText('第 1/2 次')
    await expect(turn).toContainText('这是重新生成之前的那一次，只能看')
    await expect(turn.getByTestId('agent-message')).toContainText('第一次')
    await expect(turn.getByTestId('turn-actions')).toHaveCount(0)

    // 并排对比：两次的回答和差异
    await bar.getByRole('button', { name: '并排对比' }).click()
    const compare = turn.getByTestId('version-compare')
    await expect(compare.getByRole('region', { name: '第 1 次' })).toContainText('早安')
    await expect(compare.getByRole('region', { name: '第 2 次（现在）' })).toContainText('你好')
    await expect(compare.getByTestId('diff-view')).toBeVisible()
    await compare.screenshot({ path: 'test-results/regenerate-compare.png' })
    await bar.getByRole('button', { name: '不对比' }).click()

    // 用这一次：第一次成了现在这一次，编号不变；模型下一轮看到的是第一次
    await bar.getByRole('button', { name: '用这一次' }).click()
    await expect(window.getByText('换回了那一次')).toBeVisible()
    await expect(bar.getByTestId('turn-version-position')).toHaveText('第 1/2 次')
    await expect(turn.getByTestId('agent-message')).toContainText('第一次')
    await expect(turn.getByTestId('turn-actions')).toHaveCount(1)
    await send('接着写')
    await expect(window.getByTestId('turn')).toHaveCount(2)
    await waitTaskDone(window)
    expect(model.bodies()[2]).toContain('早安')
    expect(model.bodies()[2]).not.toContain('你好')

    // 改过文件的一轮重新生成：那一次换不回来
    await send('写 note.txt')
    await expect(window.getByTestId('turn')).toHaveCount(3)
    await waitTaskDone(window)
    expect(existsSync(join(project, 'note.txt'))).toBe(true)
    await regenerate(true)
    await expect(window.getByTestId('agent-message').last()).toContainText('这次不写文件了')
    expect(existsSync(join(project, 'note.txt'))).toBe(false)
    const third = window.getByTestId('turn').last()
    await third.getByTestId('turn-versions').getByRole('button', { name: '上一次' }).click()
    await expect(third.getByTestId('turn-versions')).toContainText('那一次改过文件，换不回来')
    await expect(third.getByRole('button', { name: '用这一次' })).toHaveCount(0)

    // 这一次改了文件、上一次没改：换回去前说清楚要撤销几个文件
    await send('说点什么')
    await expect(window.getByTestId('turn')).toHaveCount(4)
    await waitTaskDone(window)
    await regenerate()
    await expect(window.getByTestId('agent-message').last()).toContainText('写了 g.txt')
    expect(existsSync(join(project, 'g.txt'))).toBe(true)
    const fourth = window.getByTestId('turn').last()
    await fourth.getByTestId('turn-versions').getByRole('button', { name: '上一次' }).click()
    await fourth.getByRole('button', { name: '用这一次' }).click()
    await expect(fourth.getByRole('alert')).toContainText('换回去会撤销现在这一次改的 1 个文件')
    await fourth.getByRole('button', { name: '撤销并换回' }).click()
    await expect(window.getByText('换回了那一次，这一次改的文件已经撤销')).toBeVisible()
    expect(existsSync(join(project, 'g.txt'))).toBe(false)
    await expect(fourth.getByTestId('agent-message')).toContainText('只说话的那一次')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
