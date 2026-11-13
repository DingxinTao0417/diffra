import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, exec, replaceLines, type ScriptStep, startScriptedModel } from './scripted-model'

test('计划通过斜杠菜单启用，改了计划再执行，编码模型按改过的计划做', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-plan-'))
  const model = await startScriptedModel([
    // 出计划：没配规划模型，用编码模型
    { toolCalls: [exec('ls')] },
    {
      toolCalls: [
        {
          name: 'submit_plan',
          input: { understanding: '给项目加一个 README', steps: [{ title: '新建 README.md', detail: '写一句项目简介', files: ['README.md'] }], risks: ['项目名还没定'] },
        },
      ],
    },
    // 按计划执行
    { toolCalls: [addFile('README.md', '# demo\n')] },
    { text: '加了 README' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)

    await expect(window.getByRole('button', { name: '先出计划', exact: true })).toHaveCount(0)
    const input = window.getByRole('textbox', { name: '任务', exact: true })
    await input.pressSequentially('/计划')
    await expect(window.getByRole('listbox', { name: '命令和 Skill' }).getByRole('option')).toHaveCount(1)
    await input.press('Enter')
    await expect(window.getByRole('button', { name: '移除计划', exact: true })).toBeVisible()
    await startTask(window, '给项目加个 README')

    const planCard = cards(window, 'plan')
    await expect(planCard).toHaveCount(1, { timeout: 20_000 })
    await expect(window.getByTestId('task-status')).toContainText('已完成')
    // 出计划不改文件，这一轮没有「重新生成」；计划模式用可移除标签提示
    expect(existsSync(join(project, 'README.md'))).toBe(false)
    await expect(window.getByTestId('turn-actions').getByRole('button', { name: '重新生成' })).toHaveCount(0)
    await expect(window.getByRole('button', { name: '移除计划', exact: true })).toBeVisible()
    // 任务监控里写明规划、备用用的模型
    const monitor = window.getByTestId('monitor-panel')
    await expect(monitor).toContainText('沿用编码模型')
    await expect(monitor).toContainText('不使用')

    const content = planCard.getByLabel('计划内容')
    await expect(content).toHaveValue(/1\. 新建 README\.md/)
    await expect(content).toHaveValue(/风险和需要确认的问题：\n- 项目名还没定/)
    await content.fill(`${await content.inputValue()}\n额外：标题用 demo`)
    await window.screenshot({ path: 'test-results/plan-card.png' })
    await planCard.getByRole('button', { name: '按计划执行' }).click()
    // 按计划执行的那一轮改了文件：做完后这一轮底部写着改了哪些文件（第 526 步起没有完成卡）
    await expect(window.getByTestId('turn-files').last()).toBeVisible({ timeout: 20_000 })
    await waitTaskDone(window)

    const request = window.getByTestId('user-message').last()
    await expect(request).toContainText('按下面的计划完成任务。')
    await expect(request).toContainText('需求：\n给项目加个 README')
    await expect(request).toContainText('额外：标题用 demo')
    expect(existsSync(join(project, 'README.md'))).toBe(true)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('兜底模型：编码模型卡住时换兜底模型接着做，对话里有提示，任务监控里显示兜底模型', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-fallback-'))
  // 每次结果都一样的失败调用：改一个不存在的文件
  const same: ScriptStep = { toolCalls: [replaceLines('missing.txt', 'TODO', 'DONE')] }
  const coder = await startScriptedModel([same, same, same, same, same, same, { text: '不会走到这里' }])
  const fallback = await startScriptedModel([{ text: '兜底模型接手做完了' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: coder.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await configureCoderModel(window, { name: '兜底供应商', baseUrl: fallback.baseUrl, apiKey: 'e2e-key-654321', modelId: 'fallback-model', role: '备用' })
    await chooseProject(app, window, project)
    await startTask(window, '找 TODO')
    await waitTaskDone(window)

    await expect(window.getByTestId('notice').filter({ hasText: '已换用备用模型 兜底供应商 / fallback-model' })).toBeVisible()
    await expect(window.getByTestId('agent-message').last()).toContainText('兜底模型接手做完了')
    await expect(window.getByTestId('monitor-panel')).toContainText('兜底供应商 / fallback-model')
    expect(coder.requests()).toBe(6)
    expect(fallback.requests()).toBe(1)
    await window.screenshot({ path: 'test-results/fallback.png' })
  } finally {
    await app.close()
    await coder.close()
    await fallback.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
