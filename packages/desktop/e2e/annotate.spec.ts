import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { RICH_SAMPLES } from '../../core/test/fixtures/rich-samples.ts'
import { chooseProject, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelCapabilities, openModelsPage } from './model-setup'
import { startScriptedModel } from './scripted-model'

const fence = '```'
// 160×90 的示意截图，和富块门槛的样例是同一张
const SAMPLE_PNG = Buffer.from((RICH_SAMPLES.annotate.valid as { image: string }).image.replace(/^data:image\/png;base64,/, ''), 'base64')
const ANSWER = [
  '看这里：',
  '',
  `${fence}annotate`,
  JSON.stringify({ title: '提问里的截图', image: '@图片1', marks: [{ shape: 'box', x: 0.3, y: 0.4, w: 0.4, h: 0.2, note: '按钮在这里' }, { shape: 'pin', x: 0.9, y: 0.8, note: '空白太多' }] }),
  fence,
  '',
  `${fence}annotate`,
  JSON.stringify({ title: '项目里的截图', image: 'shots/a.png', size: [160, 90], marks: [{ shape: 'arrow', x: 20, y: 80, x2: 48, y2: 56, note: '点不到' }] }),
  fence,
  '',
  `${fence}annotate`,
  JSON.stringify({ image: '@图片3', marks: [{ shape: 'pin', x: 0.5, y: 0.5, note: '没有这张' }] }),
  fence,
  '',
  '![项目截图](shots/a.png)',
].join('\n')

// 在输入框上粘贴一张 400×200 的图
const PASTE_IMAGE = `(async () => {
  const element = document.querySelector('textarea[aria-label="任务"]')
  const canvas = document.createElement('canvas')
  canvas.width = 400
  canvas.height = 200
  const context = canvas.getContext('2d')
  context.fillStyle = '#e8e8e4'
  context.fillRect(0, 0, 400, 200)
  context.fillStyle = '#2e6b57'
  context.fillRect(120, 80, 160, 40)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const data = new DataTransfer()
  data.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
  element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
})()`

// 在标注区域里按比例位置拖一下（from、to 是 0–1）
async function drag(window: Page, surface: Locator, from: [number, number], to: [number, number]) {
  const box = (await surface.boundingBox())!
  await window.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1])
  await window.mouse.down()
  await window.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2))
  await window.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1])
  await window.mouse.up()
}

// 第 685 步：图上标注——模型给的标注、在回答的图上自己标、在输入框的附件上标；导出带着图和标注，分享版不带项目里的图
test('图上标注：模型的标注叠在提问的图和项目的图上，编号和说明对得上；能接着标、在大图上标、在附件上标，填进输入框；导出带着标注', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-annotate-'))
  const downloads = mkdtempSync(join(tmpdir(), 'diffra-e2e-annotate-out-'))
  mkdirSync(join(project, 'shots'))
  writeFileSync(join(project, 'shots', 'a.png'), SAMPLE_PNG)
  const model = await startScriptedModel([{ text: ANSWER }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await openModelsPage(window)
    const capabilities = await openModelCapabilities(window, '脚本模型', 'scripted')
    await capabilities.getByRole('checkbox', { name: '视觉', exact: true }).click()
    await capabilities.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(capabilities).toBeHidden()
    await window.getByRole('button', { name: '返回' }).click()
    await chooseProject(app, window, project)

    const input = taskInput(window)
    await input.click()
    await window.evaluate(PASTE_IMAGE)
    await expect(window.getByTestId('composer-image')).toHaveCount(1)
    await input.fill('@图片1 这个页面哪里不对')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByTestId('task-title')).toBeVisible()
    await waitTaskDone(window)

    // 三个标注块：提问的图（两处）、项目的图（一处）、写错的图片编号
    const answer = window.getByTestId('agent-message').last()
    const blocks = answer.locator('[data-kind="annotate"]')
    await expect(blocks).toHaveCount(3)
    const first = blocks.nth(0)
    await expect(first.getByTestId('annotate-image')).toBeVisible()
    await expect(first.getByTestId('annotation-mark')).toHaveCount(2)
    await expect(first.getByTestId('annotate-notes')).toContainText('按钮在这里')
    await expect(first.getByTestId('annotate-notes')).toContainText('空白太多')
    // 点说明，图上那一处变粗；点图上的编号也一样
    await first.getByTestId('annotate-notes').getByRole('button', { name: /空白太多/ }).click()
    await expect(first.getByTestId('annotation-mark').nth(1)).toHaveAttribute('data-active', '')
    await first.getByRole('button', { name: '标注 1：按钮在这里' }).click()
    await expect(first.getByTestId('annotation-mark').nth(0)).toHaveAttribute('data-active', '')
    await expect(first.getByTestId('annotate-notes').getByRole('button', { name: /按钮在这里/ })).toHaveAttribute('aria-pressed', 'true')
    await first.screenshot({ path: 'test-results/annotate-block.png' })
    const second = blocks.nth(1)
    await expect(second.getByTestId('annotate-image')).toBeVisible()
    await expect(second.getByTestId('annotation-mark')).toHaveAttribute('data-shape', 'arrow')
    await expect(blocks.nth(2).getByTestId('annotate-missing')).toContainText('这一轮提问里没有@图片3')
    await expect(blocks.nth(2).getByTestId('annotate-notes')).toContainText('没有这张')

    // 接着标：带着模型的两处，再画一个圈、放一个编号，撤销编号，给圈写说明，填进输入框
    await first.getByRole('button', { name: '在图上接着标' }).click()
    const editor = window.getByTestId('image-annotator')
    await expect(editor).toBeVisible()
    const notes = editor.getByTestId('annotator-notes')
    await expect(notes.getByRole('textbox')).toHaveCount(2)
    await expect(notes.getByRole('textbox').first()).toHaveValue('按钮在这里')
    const surface = editor.getByTestId('annotator-surface')
    await editor.getByRole('radio', { name: '圈' }).click()
    await drag(window, surface, [0.1, 0.1], [0.3, 0.35])
    await expect(notes.getByRole('textbox')).toHaveCount(3)
    // 手滑的一下不留
    await drag(window, surface, [0.5, 0.5], [0.505, 0.505])
    await expect(notes.getByRole('textbox')).toHaveCount(3)
    await editor.getByRole('radio', { name: '编号' }).click()
    const box = (await surface.boundingBox())!
    await window.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.2)
    await expect(notes.getByRole('textbox')).toHaveCount(4)
    await expect(editor.getByTestId('annotation-mark')).toHaveCount(4)
    await window.keyboard.press('Control+z')
    await expect(notes.getByRole('textbox')).toHaveCount(3)
    await editor.getByRole('textbox', { name: '标注 3 的说明' }).fill('这个也不对')
    await editor.screenshot({ path: 'test-results/annotate-editor.png' })
    await editor.getByRole('button', { name: '填进输入框' }).click()
    await expect(editor).toBeHidden()
    const composer = window.getByLabel('任务', { exact: true })
    await expect(composer).toHaveValue(/我在这张图上标了 3 处，编号和图上一致：\n1\. 框：按钮在这里\n2\. 编号：空白太多\n3\. 圈：这个也不对/)
    await expect(composer).toHaveValue(/@图片1/)
    await expect(window.getByTestId('composer-image')).toHaveCount(1)

    // 在附件上标：点缩略图预览，「在图上标注」，画一个框，换成标注后的图，说明接在后面
    const before = await window.getByTestId('composer-image').locator('img').getAttribute('src')
    await window.getByRole('button', { name: '预览图片 1', exact: true }).click()
    await window.getByRole('button', { name: '在图上标注' }).click()
    await expect(editor).toBeVisible()
    await expect(notes.getByRole('textbox')).toHaveCount(0)
    await expect(editor.getByRole('button', { name: '换成标注后的图' })).toBeDisabled()
    await drag(window, editor.getByTestId('annotator-surface'), [0.2, 0.2], [0.6, 0.7])
    await editor.getByRole('button', { name: '换成标注后的图' }).click()
    await expect(editor).toBeHidden()
    await expect(composer).toHaveValue(/@图片1 上标了 1 处，编号和图上一致：\n1\. 框\n$/)
    await expect(window.getByTestId('composer-image')).toHaveCount(1)
    await expect.poll(() => window.getByTestId('composer-image').locator('img').getAttribute('src')).not.toBe(before)
    await window.getByRole('button', { name: '移除图片 1' }).click()
    await composer.fill('')

    // 回答里的图：看大图，「标注」，标完填进输入框
    await answer.getByRole('button', { name: '查看大图：项目截图' }).click()
    await window.getByTestId('lightbox').getByRole('button', { name: '标注' }).click()
    await expect(window.getByTestId('lightbox')).toBeHidden()
    await expect(editor).toBeVisible()
    await editor.getByRole('radio', { name: '箭头' }).click()
    await drag(window, editor.getByTestId('annotator-surface'), [0.1, 0.9], [0.4, 0.5])
    await expect(editor.getByTestId('annotation-mark')).toHaveAttribute('data-shape', 'arrow')
    await editor.getByRole('button', { name: '填进输入框' }).click()
    await expect(composer).toHaveValue(/^我在这张图上标了 1 处，编号和图上一致：\n1\. 箭头/)
    await expect(window.getByTestId('composer-image')).toHaveCount(1)

    // 窄窗口：标注编辑上下排，图不超出窗口
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(420, 900))
    await first.getByRole('button', { name: '在图上接着标' }).click()
    await expect(editor).toBeVisible()
    const image = (await editor.getByTestId('annotator-image').boundingBox())!
    const viewport = await window.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)
    expect(image.x + image.width).toBeLessThanOrEqual(viewport)
    await window.screenshot({ path: 'test-results/annotate-editor-narrow.png' })
    await editor.getByRole('button', { name: '取消' }).click()
    await expect(editor).toBeHidden()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900))

    // 导出：提问的图和项目的图都带着标注；分享版不带项目里的图
    await app.evaluate(({ session }, target) => {
      session.defaultSession.on('will-download', (_event, item) => item.setSavePath(`${target}/${item.getFilename()}`))
    }, downloads)
    await window.getByTestId('turn-actions').last().getByRole('button', { name: '导出这一轮' }).click()
    await window.getByRole('menuitem', { name: 'HTML', exact: true }).click()
    const exported = () => readdirSync(downloads).filter((name) => name.endsWith('.html'))
    await expect.poll(exported, { timeout: 20_000 }).toHaveLength(1)
    const html = readFileSync(join(downloads, exported()[0]!), 'utf8')
    expect(html.match(/data-testid="annotate-image"/g)).toHaveLength(2)
    expect(html.match(/data-testid="annotation-mark"/g)).toHaveLength(3)
    expect(html.match(/data-testid="answer-image"/g)).toHaveLength(1)
    // 分享版：提问的图、项目的图都不带，写明原因；说明还在
    await window.getByTestId('turn-actions').last().getByRole('button', { name: '导出这一轮' }).click()
    await window.getByRole('menuitem', { name: '分享版（脱敏 HTML）' }).click()
    await expect.poll(exported, { timeout: 20_000 }).toHaveLength(2)
    const sharedHtml = readFileSync(join(downloads, exported().find((name) => name.includes('分享版'))!), 'utf8')
    expect(sharedHtml).toContain('提问里的图片没有带过来')
    expect(sharedHtml).toContain('分享版和远程任务的导出不带项目里的图片')
    expect(sharedHtml).not.toContain('data-testid="annotation-mark"')
    expect(sharedHtml).toContain('按钮在这里')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
