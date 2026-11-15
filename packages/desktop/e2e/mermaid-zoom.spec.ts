import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const ANSWER = ['流程如下：', '', '```mermaid', 'flowchart LR', '  A[开始] --> B{要判断吗}', '  B -->|是| C[走这条路]', '  B -->|否| D[走那条路]', '```'].join('\n')

test('流程图普通视图不变；右上角放大后滚轮缩放有上下限、能拖拽平移，关闭后不再接管页面滚轮', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-mermaid-zoom-'))
  const model = await startScriptedModel([{ text: ANSWER }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '画个流程图')
    await waitTaskDone(window)
    const block = window.getByTestId('mermaid-block')
    await expect(block.locator('.mermaid-view > svg')).toHaveCount(1)
    await expect(window.getByTestId('mermaid-zoom')).toHaveCount(0)

    await block.getByRole('button', { name: '放大' }).click()
    const zoom = window.getByTestId('mermaid-zoom')
    const value = zoom.getByTestId('mermaid-zoom-value')
    await expect(zoom).toBeVisible()
    await expect(value).toHaveText('100%')

    // 滚轮缩放；上下限分别是 50% 和 300%
    await zoom.hover()
    await window.mouse.wheel(0, -300)
    await expect(value).not.toHaveText('100%')
    await window.mouse.wheel(0, -5000)
    await expect(value).toHaveText('300%')
    await expect(zoom.getByRole('button', { name: '放大' })).toBeDisabled()
    await window.mouse.wheel(0, 5000)
    await expect(value).toHaveText('50%')
    await expect(zoom.getByRole('button', { name: '缩小' })).toBeDisabled()
    await zoom.getByRole('button', { name: '还原大小' }).click()
    await expect(value).toHaveText('100%')

    // 放大后拖动平移：图的 transform 跟着鼠标走
    await window.mouse.wheel(0, -1000)
    const content = zoom.locator('.mermaid-view')
    const before = await content.getAttribute('style')
    const box = await zoom.boundingBox()
    expect(box).not.toBeNull()
    await window.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await window.mouse.down()
    await window.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2 + 40)
    await window.mouse.up()
    await expect.poll(() => content.getAttribute('style')).not.toBe(before)

    await window.keyboard.press('Escape')
    await expect(zoom).toHaveCount(0)
    await expect(block.locator('.mermaid-view > svg')).toHaveCount(1)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
