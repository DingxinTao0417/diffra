import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const section = (name: string) => `${name}这一节讲了很多细节，要一步步看。`.repeat(18)
const LONG = ['# 总览', section('总览'), '## 安装', section('安装'), '## 配置', section('配置'), '### 环境变量', section('环境变量'), '## 部署', section('部署'), '```md', '## 代码里的标题不算', '```'].join('\n\n')
const SHORT = ['## 只有一个标题', '短回答，不需要目录。'].join('\n\n')

// 第 674 步：长回答顶上的目录；选中一段文字或一张卡，「解释这个 / 展开这个 / 换个说法」填进输入框
test('长回答有目录，点了跳过去，短回答没有；选中一段文字能让它解释、展开、换个说法；卡片上能「问问这张卡」', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-answer-tools-'))
  const model = await startScriptedModel([{ text: LONG }, { text: SHORT }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '讲讲怎么部署')
    await waitTaskDone(window)

    const answer = window.getByTestId('agent-message').first()
    const toc = answer.getByTestId('answer-toc')
    await expect(toc.getByRole('link')).toHaveText(['总览', '安装', '配置', '环境变量', '部署'])
    // 三级标题缩进
    const indent = (name: string) => toc.getByRole('listitem').filter({ hasText: name }).evaluate((item) => (item as unknown as { style: { paddingLeft: string } }).style.paddingLeft)
    expect(await indent('环境变量')).not.toBe(await indent('配置'))
    await toc.screenshot({ path: 'test-results/answer-toc.png' })
    await toc.getByRole('link', { name: '部署' }).click()
    await expect(answer.getByRole('heading', { name: '部署' })).toBeInViewport()

    // 选中「安装」那一节的一段：浮出三个按钮，点「展开这个」把这段引用进输入框
    const paragraph = answer.locator('p').filter({ hasText: '安装这一节' })
    await paragraph.scrollIntoViewIfNeeded()
    await paragraph.selectText()
    await paragraph.dispatchEvent('pointerup')
    const menu = window.getByTestId('selection-ask')
    await expect(menu.getByRole('button')).toHaveText(['解释这个', '展开这个', '换个说法'])
    await menu.screenshot({ path: 'test-results/selection-ask.png' })
    await menu.getByRole('button', { name: '展开这个' }).click()
    await expect(menu).toHaveCount(0)
    await expect(taskInput(window)).toHaveValue(/^展开讲讲这段：\n> 安装这一节讲了很多细节/)

    // 卡片：本轮报告上有「问问这张卡」
    await taskInput(window).fill('')
    await window.getByTestId('turn-actions').getByRole('button', { name: '本轮报告' }).click()
    await window.getByRole('button', { name: '问问这张卡' }).first().click()
    await expect(taskInput(window)).toHaveValue(/^关于这张卡片：\n> /)

    // 短回答没有目录
    await taskInput(window).fill('再短一点')
    await window.keyboard.press('Control+Enter')
    await expect(window.getByTestId('agent-message')).toHaveCount(2)
    await waitTaskDone(window)
    await expect(window.getByTestId('agent-message').last()).toContainText('短回答')
    await expect(window.getByTestId('agent-message').last().getByTestId('answer-toc')).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
