import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('待办：记下、快捷键快速记、重启后还在；派给新任务后记下去向，任务做完提示可以勾掉；几条一起优化后填进已有任务的输入框', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-todos-'))
  const model = await startScriptedModel([
    { text: '暗色模式加好了' },
    {
      toolCalls: [
        {
          name: 'submit_prompt',
          input: { prompt: '1. 给首页加暗色模式开关\n2. 设置页加导出按钮', questions: [] },
        },
      ],
    },
  ])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)

    // 侧栏进待办页，选固定项目和自定义标签后回车记两条；侧栏显示没做完的条数
    await window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    const projectPicker = window.getByTestId('todo-project-picker')
    await projectPicker.click()
    await window.getByRole('menuitem', { name: new RegExp(basename(project)) }).click()
    await expect(projectPicker).toContainText(basename(project))
    const tagInput = window.getByLabel('添加标签')
    await tagInput.fill('重要')
    await tagInput.press('Enter')
    await expect(window.getByTestId('todo-tag-editor').getByTestId('todo-tag')).toContainText('#重要')
    const input = window.getByLabel('新待办')
    await input.fill('给首页加暗色模式开关')
    await input.press('Enter')
    await input.fill('设置页加导出按钮')
    await input.press('Enter')
    let rows = window.getByTestId('todo-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('设置页加导出按钮')
    await expect(rows.filter({ hasText: '给首页加暗色模式开关' })).toContainText(basename(project))
    await expect(rows.filter({ hasText: '给首页加暗色模式开关' }).getByTestId('todo-tag')).toContainText('#重要')
    await expect(window.getByTestId('sidebar-todo-count')).toHaveText('2')

    // 任何页面 Ctrl+J 快速记
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await window.keyboard.press('ControlOrMeta+j')
    await window.getByLabel('快速记待办').fill('顺手修一下标题栏')
    await window.getByLabel('快速记待办').press('Enter')
    await expect(window.getByTestId('quick-todo')).toHaveCount(0)
    await expect(window.getByTestId('sidebar-todo-count')).toHaveText('3')

    // 重启后还在
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    rows = window.getByTestId('todo-row')
    await expect(rows).toHaveCount(3)
    // 固定项目和自定义标签都存进了 todos.json，重启后还在；标签也能用来筛选
    const tagged = rows.filter({ hasText: '给首页加暗色模式开关' })
    await expect(tagged).toContainText(basename(project))
    await expect(tagged.getByTestId('todo-tag')).toContainText('#重要')
    const tagFilter = window.getByTestId('todo-tag-filter').filter({ hasText: '#重要' })
    await tagFilter.click()
    await expect(rows).toHaveCount(1)
    await tagFilter.click()
    await expect(rows).toHaveCount(3)
    await rows.filter({ hasText: '顺手修一下标题栏' }).getByRole('checkbox').click()
    await expect(window.getByTestId('sidebar-todo-count')).toHaveText('2')

    // 一条派给新任务：发出去后跳到任务，回到待办页能看到去向和「可以勾掉」
    await rows.filter({ hasText: '给首页加暗色模式开关' }).getByRole('button', { name: '发送给任务' }).click()
    const dialog = window.getByTestId('send-todos')
    await expect(dialog.getByLabel('要发的内容')).toHaveValue('给首页加暗色模式开关')
    await dialog.getByRole('button', { name: '发送', exact: true }).click()
    await waitTaskDone(window)
    await expect(window.getByText('暗色模式加好了')).toBeVisible()
    await window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    const sent = rows.filter({ hasText: '给首页加暗色模式开关' })
    await expect(sent.getByTestId('todo-sent')).toContainText('已派给 给首页加暗色模式开关')
    await expect(sent.getByTestId('todo-finished')).toContainText('待验收')

    // 两条一起：选中后派给已有任务，优化后只填进输入框
    await window.getByRole('button', { name: '选几条一起发' }).click()
    await window.getByRole('checkbox', { name: '选中：给首页加暗色模式开关' }).click()
    await window.getByRole('checkbox', { name: '选中：设置页加导出按钮' }).click()
    await window.getByRole('button', { name: '发送 2 条' }).click()
    await expect(dialog.getByLabel('要发的内容')).toHaveValue(/请完成下面几件事：\n- /)
    await dialog.getByRole('radio', { name: '已有任务' }).click()
    await dialog.getByRole('option', { name: /给首页加暗色模式开关/ }).click()
    await dialog.getByRole('button', { name: '优化' }).click()
    await expect(dialog.getByLabel('要发的内容')).toHaveValue('1. 给首页加暗色模式开关\n2. 设置页加导出按钮')
    // 优化请求带着目标任务最近的对话
    expect(model.bodies().at(-1)).toContain('Recent conversation in this task:')
    await dialog.getByRole('button', { name: '只填入输入框' }).click()
    await expect(taskInput(window)).toHaveValue('1. 给首页加暗色模式开关\n2. 设置页加导出按钮')
    expect(model.requests()).toBe(2)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
