import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelCapabilities, openModelsPage } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 在快速记的输入框上粘贴一张小图。页面里跑的代码，e2e 的类型配置里没有 DOM 类型，写成字符串
const PASTE_IMAGE = `(async () => {
  const element = document.querySelector('input[aria-label="新待办"]')
  const canvas = document.createElement('canvas')
  canvas.width = 40
  canvas.height = 20
  const context = canvas.getContext('2d')
  context.fillStyle = '#2e6b57'
  context.fillRect(0, 0, 40, 20)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const data = new DataTransfer()
  data.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
  element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
})()`
const TODO_IMAGE_WIDTHS = `[...document.querySelectorAll('[data-testid="todo-image"] img')].map((image) => image.naturalWidth)`

// 第 638 步：待办能加图片和文件（快速记粘贴、对话框里选），重启后还在；派给任务时图片和文件引用一起发，填进输入框时变成输入框的附件
test('待办附件：快速记粘贴图片、对话框加文件（密钥文件不让加）、重启后还在；派给新任务一起发，填进已有任务的输入框也带上', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-todo-attach-'))
  const notes = join(project, 'notes.md')
  const secret = join(project, '.env')
  writeFileSync(notes, '# 需求说明')
  writeFileSync(secret, 'API_KEY=should-not-be-attached')
  // 旧版写的待办：没有标签、附件这些字段，照常读出来
  writeFileSync(
    join(userDataDir, 'todos.json'),
    JSON.stringify({ version: 1, todos: [{ id: 'old-1', text: '旧版记的一条', project: null, createdAt: '2026-11-01T00:00:00.000Z', done: false, sentTo: null }] }),
  )
  const model = await startScriptedModel([{ text: '看到图片和需求说明了' }])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await openModelsPage(window)
    const capabilities = await openModelCapabilities(window, '脚本模型', 'scripted')
    await capabilities.getByRole('checkbox', { name: '视觉', exact: true }).click()
    await capabilities.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(capabilities).toBeHidden()
    await window.getByRole('button', { name: '返回' }).click()
    await chooseProject(app, window, project)
    await window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    // 重启后是新窗口，按当前窗口取
    const rows = () => window.getByTestId('todo-row')
    const row = () => rows().filter({ hasText: '看看这张截图' })
    await expect(rows().filter({ hasText: '旧版记的一条' })).toHaveCount(1)

    // 快速记：粘贴一张图，输入框下面出现缩略图，回车记下，那一行标着 1 个附件
    const input = window.getByLabel('新待办')
    await input.click()
    await window.evaluate(PASTE_IMAGE)
    await expect(window.getByTestId('todo-image')).toHaveCount(1)
    await input.fill('看看这张截图')
    await window.screenshot({ path: 'test-results/todo-attachments-quick.png' })
    await input.press('Enter')
    await expect(row().getByTestId('todo-attachment-count')).toHaveText('1')
    await expect(window.getByTestId('todo-image')).toHaveCount(0)

    // 对话框里加文件：普通文件加上，.env 这类可能含密钥的不让加
    await row().getByTestId('todo-title').dblclick()
    const editor = window.getByTestId('todo-editor')
    await expect(editor.getByTestId('todo-image')).toHaveCount(1)
    await editor.getByTestId('todo-attachment-input').setInputFiles(notes)
    await expect(editor.getByTestId('todo-file')).toContainText('notes.md')
    await editor.getByTestId('todo-attachment-input').setInputFiles(secret)
    // 对话框开着时外面的提示是 aria-hidden，按角色找不到，用选择器找
    await expect(window.locator('[role="status"]')).toContainText('可能包含密钥')
    await expect(editor.getByTestId('todo-file')).toHaveCount(1)
    await window.screenshot({ path: 'test-results/todo-attachments-editor.png' })
    await editor.getByRole('button', { name: '保存' }).click()
    await expect(editor).toHaveCount(0)
    await expect(row().getByTestId('todo-attachment-count')).toHaveText('2')

    // todos.json 里只记图片 id 和文件路径，图片本身存在 todo-attachments 里
    const saved = JSON.parse(readFileSync(join(userDataDir, 'todos.json'), 'utf8')) as { todos: Array<{ text: string; images?: string[]; files?: Array<{ path: string; kind: string }> }> }
    const record = saved.todos.find((todo) => todo.text === '看看这张截图')
    expect(record?.images).toHaveLength(1)
    expect(record?.files?.map((file) => file.path.endsWith('notes.md'))).toEqual([true])
    expect(readdirSync(join(userDataDir, 'todo-attachments'))).toEqual([`${record?.images?.[0]}.webp`])

    // 重启后附件还在，点开那一行能看到缩略图和文件名
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    await expect(row().getByTestId('todo-attachment-count')).toHaveText('2')
    await row().getByTestId('todo-text').click()
    await expect(row().getByTestId('todo-image')).toHaveCount(1)
    await expect.poll(() => window.evaluate(TODO_IMAGE_WIDTHS)).toEqual([40])
    await expect(row().getByTestId('todo-file')).toContainText('notes.md')
    await window.screenshot({ path: 'test-results/todo-attachments-row.png' })

    // 派给新任务：对话框说明附件会一起发；模型收到图片和文件路径引用
    await row().getByRole('button', { name: '发送给任务' }).click()
    const dialog = window.getByTestId('send-todos')
    await expect(dialog).toContainText('待办里的 1 张图片、1 个文件会一起发过去')
    await dialog.getByRole('button', { name: '发送', exact: true }).click()
    await waitTaskDone(window)
    await expect(window.getByText('看到图片和需求说明了')).toBeVisible()
    const body = model.bodies()[0] ?? ''
    expect(body.match(/data:image\/webp;base64,/g)).toHaveLength(1)
    expect(body).toContain('notes.md')

    // 再派一次，只填进刚才那个任务的输入框：图片和文件变成输入框的附件
    await window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    await row().getByRole('button', { name: '发送给任务' }).click()
    await dialog.getByRole('radio', { name: '已有任务' }).click()
    await dialog.getByRole('option', { name: /看看这张截图/ }).click()
    await dialog.getByRole('button', { name: '只填入输入框' }).click()
    await expect(window.getByTestId('composer-image')).toHaveCount(1)
    await expect(window.getByTestId('composer-file')).toContainText('notes.md')
    await expect(taskInput(window)).toHaveValue(/^看看这张截图\n\n@图片1 @notes\.md/)
    expect(model.requests()).toBe(1)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
