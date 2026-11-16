import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, settingsNav, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('侧栏、搜索、重命名、归档、外观；重启后任务和外观都还在，右键删除任务', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-shell-'))
  writeFileSync(join(project, 'a.txt'), 'hi\n')
  const model = await startScriptedModel([{ text: '找到了独角兽的答案' }])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await expect(window.getByText('要做什么？')).toBeVisible()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '第一个任务')
    await waitTaskDone(window)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(1)
    await expect(window.getByTestId('sidebar-task')).toContainText('第一个任务')

    // 搜索框在「新任务」上方，两个入口都还在
    const newTaskButton = window.getByTestId('sidebar').getByRole('button', { name: '新任务', exact: true })
    const searchInput = window.getByLabel('侧栏搜索', { exact: true })
    await expect(searchInput).toBeVisible()
    await expect(newTaskButton).toBeVisible()
    expect((await searchInput.boundingBox())?.y ?? 0).toBeLessThan((await newTaskButton.boundingBox())?.y ?? 0)

    // 项目条目右侧不显示任务数字，加号一直可见；点加号回到这个项目的首页
    const projectRow = window.getByTestId('sidebar-project-row').filter({ hasText: basename(project) })
    const projectAction = projectRow.getByTestId('sidebar-project-action')
    await expect(projectAction).toBeVisible()
    expect((await projectRow.textContent())?.replace(basename(project), '').trim()).toBe('')
    await projectAction.click()
    await expect(window.getByTestId('project-path')).toContainText(basename(project))

    // 侧栏搜索框直接输入并打开结果
    const sidebarSearch = window.getByLabel('侧栏搜索', { exact: true })
    await sidebarSearch.click()
    await sidebarSearch.fill('独角兽')
    const sidebarResults = window.getByRole('listbox', { name: '侧栏搜索结果' })
    await expect(sidebarResults.getByRole('option').filter({ hasText: '第一个任务' })).toHaveCount(1)
    await sidebarResults.getByRole('option').filter({ hasText: '第一个任务' }).click()
    await expect(window.getByTestId('task-title')).toHaveText('第一个任务')

    // Ctrl+K 按对话内容搜
    await taskInput(window).click()
    await window.keyboard.press('ControlOrMeta+k')
    await window.getByRole('combobox', { name: '搜索任务' }).fill('独角兽')
    await expect(window.getByRole('option').filter({ hasText: '找到了独角兽的答案' })).toHaveCount(1)
    await window.keyboard.press('Escape')

    // Ctrl+B 收起和展开侧栏
    await window.keyboard.press('ControlOrMeta+b')
    await expect(window.getByTestId('sidebar')).toHaveCount(0)
    await window.keyboard.press('ControlOrMeta+b')
    await expect(window.getByTestId('sidebar')).toBeVisible()

    // 重命名
    await window.locator('header').getByRole('button', { name: '任务菜单' }).click()
    await window.getByRole('menuitem', { name: '重命名' }).click()
    await window.getByLabel('任务名称').fill('改过的名字')
    await window.getByRole('button', { name: '保存' }).click()
    await expect(window.getByTestId('task-title')).toHaveText('改过的名字')
    await expect(window.getByTestId('sidebar-task')).toContainText('改过的名字')

    // 首页不列最近的任务，从侧栏打开
    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await expect(window.getByText('最近的任务')).toHaveCount(0)
    await window.getByTestId('sidebar-task').filter({ hasText: '改过的名字' }).click()
    await expect(window.getByTestId('task-title')).toHaveText('改过的名字')

    // 归档后侧栏不显示，在「会话与存储」里取消归档
    await window.locator('header').getByRole('button', { name: '任务菜单' }).click()
    await window.getByRole('menuitem', { name: '归档' }).click()
    await expect(window.getByText('要做什么？')).toBeVisible()
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '会话与存储' }).click()
    await expect(window.getByTestId('archived-task')).toHaveCount(1)
    await window.getByTestId('archived-task').getByRole('button', { name: '取消归档' }).click()
    await expect(window.getByTestId('archived-task')).toHaveCount(0)

    // 外观立即生效
    await settingsNav(window).getByRole('button', { name: '外观' }).click()
    await window.getByRole('combobox', { name: '主题', exact: true }).click()
    await window.getByRole('option', { name: '深色', exact: true }).click()
    await window.getByRole('radiogroup', { name: '配色' }).getByRole('radio', { name: '靛蓝' }).click()
    await window.getByRole('combobox', { name: '文字大小', exact: true }).click()
    await window.getByRole('option', { name: '大', exact: true }).click()
    const html = window.locator('html')
    await expect(html).toHaveClass(/dark/)
    await expect(html).toHaveAttribute('data-palette', 'indigo')
    await expect(html).toHaveAttribute('data-font', 'lg')
    await app.close()

    // 重启：外观恢复，任务从磁盘读回来
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await expect(window.locator('html')).toHaveClass(/dark/)
    await expect(window.locator('html')).toHaveAttribute('data-palette', 'indigo')
    await expect(window.locator('html')).toHaveAttribute('data-font', 'lg')
    await expect(window.getByTestId('sidebar-task')).toHaveCount(1)
    await window.getByTestId('sidebar-task').click()
    await expect(window.getByTestId('task-title')).toHaveText('改过的名字')
    await expect(window.getByTestId('agent-message')).toContainText('找到了独角兽的答案')
    await window.screenshot({ path: 'test-results/shell.png' })

    // 右键菜单删除任务记录
    await window.getByTestId('sidebar-task').click({ button: 'right' })
    await window.getByRole('menuitem', { name: '删除任务记录' }).click()
    await window.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)
    await expect(window.getByText('要做什么？')).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('设备连接（v2 起只在局域网里直连）：设置里有入口；默认不开，启动时不开局域网服务、不监听网络；侧栏没有远程项目', async () => {
  const userDataDir = makeUserDataDir()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await expect(window.getByText('要做什么？')).toBeVisible()
    await expect(window.getByTestId('remote-control-indicator')).toHaveCount(0)
    await expect(window.getByTestId('sidebar-remote-project')).toHaveCount(0)

    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByLabel('搜索设置').fill('配对码')
    await settingsNav(window).getByRole('button', { name: '设备连接' }).click()
    await expect(window.getByRole('heading', { name: '设备连接', exact: true })).toBeVisible()
    await expect(window.getByText('不经过任何服务器、只连局域网地址')).toBeVisible()
    await expect(window.getByTestId('relay-status')).toHaveText('局域网服务没开')
    await expect(window.getByTestId('relay-status')).toHaveAttribute('data-state', 'off')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
