import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelsPage, providerCard } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 在输入框上触发一次粘贴，剪贴板里是一张 3000x1500 的 PNG。页面里跑的代码，e2e 的类型配置里没有 DOM 类型，写成字符串
const PASTE_BIG_IMAGE = `(async () => {
  const element = document.querySelector('textarea[aria-label="任务"]')
  const canvas = document.createElement('canvas')
  canvas.width = 3000
  canvas.height = 1500
  const context = canvas.getContext('2d')
  context.fillStyle = '#2e6b57'
  context.fillRect(0, 0, 3000, 1500)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const data = new DataTransfer()
  data.items.add(new File([blob], 'big.png', { type: 'image/png' }))
  element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
})()`
const DROP_SMALL_IMAGE = `(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const data = new DataTransfer()
  data.items.add(new File([blob], 'pixel.png', { type: 'image/png' }))
  const element = document.querySelector('[data-testid="composer"]')
  element.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }))
  element.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
})()`
const COMPOSER_IMAGE_SIZES = `[...document.querySelectorAll('[data-testid="composer-image"] img')].map((image) => [image.naturalWidth, image.naturalHeight])`

// 1x1 的 PNG
const PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('图片输入：粘贴的大图缩小后带上；模型没开图片时说明去哪里开；开了就发给模型，提问气泡里能看大图，重新生成也带着', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-images-'))
  const pngFile = join(project, 'pixel.png')
  writeFileSync(pngFile, PIXEL_PNG)
  const model = await startScriptedModel([{ text: '看到两张图' }, { text: '又看了一遍' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)

    // 粘贴一张 3000x1500 的图：缩小到长边 1600、转成 WebP
    const input = taskInput(window)
    await input.click()
    await window.evaluate(PASTE_BIG_IMAGE)
    const thumbnails = window.getByTestId('composer-image')
    await expect(thumbnails).toHaveCount(1)
    await expect.poll(() => window.evaluate(COMPOSER_IMAGE_SIZES)).toEqual([[1600, 800]])
    // 常驻图片按钮已移除，拖入第二张图片。
    await expect(window.getByRole('button', { name: '添加图片', exact: true })).toHaveCount(0)
    await window.evaluate(DROP_SMALL_IMAGE)
    await expect(thumbnails).toHaveCount(2)
    await window.screenshot({ path: 'test-results/images-composer.png' })

    // 模型没开图片：不发，说明去哪里开，输入框里的内容留着
    await input.fill('这两张图是什么')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByRole('status')).toContainText('没有打开「视觉」')
    await expect(input).toHaveValue('这两张图是什么')
    await expect(thumbnails).toHaveCount(2)
    expect(model.requests()).toBe(0)

    // 在模型设置里打开「视觉」，回首页再发
    await openModelsPage(window)
    await providerCard(window, '脚本模型').getByRole('button', { name: 'scripted 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '配置能力', exact: true }).click()
    const capabilities = window.getByRole('dialog')
    await capabilities.getByRole('checkbox', { name: '视觉', exact: true }).click()
    await expect(capabilities.getByRole('checkbox', { name: '视觉', exact: true })).toBeChecked()
    await capabilities.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(capabilities).toBeHidden()
    await window.getByRole('button', { name: '返回' }).click()
    // 去设置页时首页的输入框卸载了，草稿和图片不保留，重新加
    await window.evaluate(PASTE_BIG_IMAGE)
    await expect(thumbnails).toHaveCount(1)
    await expect(window.getByTestId('composer')).toHaveAttribute('aria-busy', 'false')
    await window.evaluate(DROP_SMALL_IMAGE)
    await expect(thumbnails).toHaveCount(2)
    await input.fill('这两张图是什么')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByTestId('task-title')).toBeVisible()
    await waitTaskDone(window)
    expect(model.bodies()[0]).toContain('这两张图是什么')
    expect(model.bodies()[0]?.match(/data:image\/webp;base64,/g)).toHaveLength(2)

    // 提问气泡里有两张图，点开看大图
    const messageImages = window.getByTestId('message-image')
    await expect(messageImages).toHaveCount(2)
    await window.getByRole('button', { name: '提问的图片 1' }).click()
    await expect(window.getByRole('dialog').getByRole('img', { name: '提问的图片 1' })).toBeVisible()
    await window.screenshot({ path: 'test-results/images-dialog.png' })
    await window.keyboard.press('Escape')

    // 重新生成：图片跟着重发
    await window.getByTestId('turn-actions').getByRole('button', { name: '重新生成' }).click()
    await expect(window.getByTestId('agent-message').last()).toContainText('又看了一遍')
    expect(model.bodies()[1]?.match(/data:image\/webp;base64,/g)).toHaveLength(2)
    await expect(messageImages).toHaveCount(2)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
