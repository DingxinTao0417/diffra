import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

test('待办的标题、正文和优先级：详细添加（已有标签点选、选项目）、正文两行收起点开看全文、P0 排前面、按优先级筛、快速记 p1 前缀、双击用对话框编辑、派给任务发标题加正文', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-todo-detail-'))
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await chooseProject(app, window, project)
    await window.getByTestId('sidebar').getByRole('button', { name: /待办/ }).click()
    const rows = window.getByTestId('todo-row')

    // 快速记：开头写 p1 加空格就是 P1，标题里不留前缀；顺手加一个标签，后面在对话框里点选
    const input = window.getByLabel('新待办')
    await window.getByLabel('添加标签').fill('前端')
    await window.getByLabel('添加标签').press('Enter')
    await input.fill('p1 修登录页的跳转')
    await expect(window.getByTestId('todo-priority')).toHaveText('P1')
    await input.press('Enter')
    await expect(rows).toHaveCount(1)
    await expect(rows.first().getByTestId('todo-title')).toHaveText('修登录页的跳转')
    await expect(rows.first().getByTestId('todo-priority')).toHaveText('P1')

    // 详细添加：标题、多行正文、P0、从已有标签里点选、选项目
    await window.getByRole('button', { name: '详细添加' }).click()
    const editor = window.getByTestId('todo-editor')
    await editor.getByLabel('待办标题').fill('重做待办的添加流程')
    await editor.getByLabel('待办正文').fill('第一步：加对话框\n第二步：列表显示标题\n第三步：正文省略\n第四步：优先级')
    await editor.getByRole('radio', { name: 'P0' }).click()
    await editor.getByLabel('添加标签').click()
    await editor.getByTestId('todo-tag-suggestions').getByRole('button', { name: '#前端' }).click()
    await expect(editor.getByTestId('todo-tag')).toContainText('#前端')
    await editor.getByTestId('todo-project-picker').click()
    await window.getByRole('menuitem', { name: new RegExp(basename(project)) }).click()
    await editor.getByRole('button', { name: '保存' }).click()
    await expect(editor).toHaveCount(0)

    // P0 排在 P1 前面；正文收着最多两行，点一下展开看全文
    await expect(rows).toHaveCount(2)
    const detailed = rows.first()
    await expect(detailed.getByTestId('todo-title')).toHaveText('重做待办的添加流程')
    await expect(detailed.getByTestId('todo-priority')).toHaveText('P0')
    await expect(detailed).toContainText(basename(project))
    await expect(detailed.getByTestId('todo-tag')).toContainText('#前端')
    const body = detailed.getByTestId('todo-body')
    await expect(body).toHaveCSS('-webkit-line-clamp', '2')
    await detailed.getByTestId('todo-text').click()
    await expect(detailed.getByTestId('todo-text')).toHaveAttribute('aria-expanded', 'true')
    await expect(body).toHaveCSS('-webkit-line-clamp', 'none')

    // 按优先级筛
    await window.getByTestId('todo-priority-filter').filter({ hasText: 'P0' }).click()
    await expect(rows).toHaveCount(1)
    await window.getByTestId('todo-priority-filter').filter({ hasText: 'P0' }).click()
    await expect(rows).toHaveCount(2)

    // 双击打开编辑对话框：补正文、改成 P2
    await rows.filter({ hasText: '修登录页的跳转' }).getByTestId('todo-title').dblclick()
    await expect(editor.getByLabel('待办标题')).toHaveValue('修登录页的跳转')
    await editor.getByLabel('待办正文').fill('先看路由守卫')
    await editor.getByRole('radio', { name: 'P2' }).click()
    await editor.getByRole('button', { name: '保存' }).click()
    const edited = rows.filter({ hasText: '修登录页的跳转' })
    await expect(edited.getByTestId('todo-priority')).toHaveText('P2')
    await expect(edited.getByTestId('todo-body')).toHaveText('先看路由守卫')

    // 派给任务：发出去的是标题、空一行、正文，不带优先级
    await detailed.getByRole('button', { name: '发送给任务' }).click()
    await expect(window.getByTestId('send-todos').getByLabel('要发的内容')).toHaveValue('重做待办的添加流程\n\n第一步：加对话框\n第二步：列表显示标题\n第三步：正文省略\n第四步：优先级')
    await window.keyboard.press('Escape')

    // 存进 todos.json 的是标题、正文、优先级三个字段
    const saved = JSON.parse(readFileSync(join(userDataDir, 'todos.json'), 'utf8')) as { todos: Array<{ text: string; body?: string; priority?: number }> }
    expect(saved.todos.find((todo) => todo.text === '重做待办的添加流程')).toMatchObject({ priority: 0, body: '第一步：加对话框\n第二步：列表显示标题\n第三步：正文省略\n第四步：优先级' })
    expect(saved.todos.find((todo) => todo.text === '修登录页的跳转')).toMatchObject({ priority: 2, body: '先看路由守卫' })
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
