import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('下一句建议：轮次结束后出现在占位符里，Tab 填入但不发送，填入后可撤销', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-suggest-'))
  const model = await startScriptedModel([{ text: '第一轮完成了' }, { text: '帮我把这次的改动补上测试' }])
  const app = await launchApp(userDataDir, { DIFFRA_SUGGESTIONS_OFF: '0' })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '建议测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '改一下登录')
    await waitTaskDone(window)

    const input = taskInput(window)
    await expect(input).toHaveAttribute('placeholder', /帮我把这次的改动补上测试.*Tab 填入/, { timeout: 15_000 })
    expect(model.requests()).toBe(2)

    await input.click()
    await input.press('Tab')
    await expect(input).toHaveValue('帮我把这次的改动补上测试')
    await expect(window.getByTestId('composer-undo')).toContainText('已填入建议')
    // 只填入，不自动发送
    await expect(window.getByTestId('turn')).toHaveCount(1)
    expect(model.requests()).toBe(2)

    // 之后清空也不会再出现同一条建议
    await input.fill('')
    await expect(input).toHaveAttribute('placeholder', /请输入指令/)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('关掉「推荐下一句」后不再请求预测，占位符保持原样', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-suggest-off-'))
  const model = await startScriptedModel([{ text: '做完了' }])
  const app = await launchApp(userDataDir, { DIFFRA_SUGGESTIONS_OFF: '0' })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '建议测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '常规', exact: true }).click()
    await window.getByRole('switch', { name: '推荐下一句' }).click()
    await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '返回', exact: true }).click()
    await startTask(window, '改一下登录')
    await waitTaskDone(window)
    await expect(taskInput(window)).toHaveAttribute('placeholder', /请输入指令/)
    expect(model.requests()).toBe(1)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
