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

// 第 680 步：朗读。系统语音换成记录下来的替身，不真的出声
const STUB_SPEECH = `(() => {
  window.__spoken = []
  window.__cancelled = 0
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
  const synth = window.speechSynthesis
  synth.speak = (utterance) => { window.__spoken.push({ text: utterance.text, voice: utterance.voice ? utterance.voice.voiceURI : null }); setTimeout(() => utterance.onend && utterance.onend(), 200) }
  synth.cancel = () => { window.__cancelled += 1 }
  synth.getVoices = () => [{ name: '测试女声', lang: 'zh-CN', voiceURI: 'test-zh' }, { name: 'Test Voice', lang: 'en-US', voiceURI: 'test-en' }]
  synth.dispatchEvent(new Event('voiceschanged'))
})()`

test('朗读：读回答的文字，代码和表格线不念；读完按钮回到「朗读」；能选声音并记住；能中途停', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-speech-'))
  const answer = ['## 结论', '', '第一句话。第二句话！', '', '```ts', 'const secretNumber = 1', '```', '', '| 列 | 值 |', '| --- | --- |', '| a | 1 |', '', '最后一句。'].join('\n')
  const model = await startScriptedModel([{ text: answer }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '念给我听')
    await waitTaskDone(window)
    await window.evaluate(STUB_SPEECH)
    const actions = window.getByTestId('turn-actions')
    const spoken = () => window.evaluate<Array<{ text: string; voice: string | null }>>('window.__spoken')

    await actions.getByRole('button', { name: '朗读', exact: true }).click()
    await expect(actions.getByRole('button', { name: '停止朗读' })).toHaveAttribute('aria-pressed', 'true')
    await expect(actions.getByRole('button', { name: '朗读', exact: true })).toBeVisible({ timeout: 10_000 })
    const text = (await spoken()).map((item) => item.text).join('')
    expect(text).toContain('结论')
    expect(text).toContain('第一句话。第二句话！')
    expect(text).toContain('这里有一段代码。')
    expect(text).toContain('最后一句。')
    expect(text).not.toContain('secretNumber')
    expect(text).not.toContain('---')

    // 选声音：记住，下次朗读用它
    await actions.getByRole('button', { name: '选择朗读的声音' }).click()
    await window.getByRole('menuitemradio', { name: /测试女声/ }).click()
    expect(await window.evaluate(`localStorage.getItem('diffra.speechVoice')`)).toBe('test-zh')
    await window.evaluate('window.__spoken = []')
    await actions.getByRole('button', { name: '朗读', exact: true }).click()
    await expect.poll(async () => (await spoken())[0]?.voice).toBe('test-zh')

    // 中途停
    await actions.getByRole('button', { name: '停止朗读' }).click()
    await expect(actions.getByRole('button', { name: '朗读', exact: true })).toBeVisible()
    expect(await window.evaluate<number>('window.__cancelled')).toBeGreaterThan(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
