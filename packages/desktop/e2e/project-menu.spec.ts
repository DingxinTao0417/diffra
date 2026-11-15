import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, settingsNav, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('项目右键：归档和删除都先确认并写明项目名、会话数；取消不改；归档后侧栏立即隐藏、设置里能恢复；删除只删记录不动文件夹', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-project-menu-'))
  writeFileSync(join(project, 'keep.txt'), '项目文件还在\n')
  const model = await startScriptedModel([{ text: '第一个任务做完了' }, { text: '第二个任务做完了' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '项目任务一')
    await waitTaskDone(window)
    await window.getByTestId('sidebar-project-action').click()
    await expect(window.getByTestId('project-path')).toContainText(basename(project))
    await startTask(window, '项目任务二')
    await waitTaskDone(window)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(2)

    const row = () => window.getByTestId('sidebar-project-row').filter({ hasText: basename(project) })
    const openMenu = async () => {
      await row().click({ button: 'right' })
      await expect(window.getByRole('menuitem', { name: '新建任务' })).toBeVisible()
    }

    // 归档：确认框写明影响范围，取消什么都不改
    await openMenu()
    await window.getByRole('menuitem', { name: '归档' }).click()
    const archiveDialog = window.getByTestId('project-archive-dialog')
    await expect(archiveDialog).toContainText(basename(project))
    await expect(archiveDialog).toContainText('2 个会话')
    await archiveDialog.getByRole('button', { name: '取消' }).click()
    await expect(row()).toHaveCount(1)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(2)

    // 确认归档：项目和会话立即从侧栏消失
    await openMenu()
    await window.getByRole('menuitem', { name: '归档' }).click()
    await archiveDialog.getByRole('button', { name: '归档项目' }).click()
    await expect(window.getByTestId('sidebar-project')).toHaveCount(0)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)

    // 设置 → 会话与存储：出现在已归档的项目里，恢复后项目和两条会话都回来
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '会话与存储' }).click()
    const archivedProject = window.getByTestId('archived-project')
    await expect(archivedProject).toContainText(basename(project))
    await expect(archivedProject).toContainText('2 个会话')
    await archivedProject.getByRole('button', { name: '恢复项目' }).click()
    await expect(archivedProject).toHaveCount(0)
    await window.getByRole('button', { name: '返回', exact: true }).click()
    await expect(row()).toHaveCount(1)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(2)

    // 删除：取消不动
    await openMenu()
    await window.getByRole('menuitem', { name: '删除' }).click()
    const deleteDialog = window.getByTestId('project-delete-dialog')
    await expect(deleteDialog).toContainText(basename(project))
    await expect(deleteDialog).toContainText('2 个会话')
    await deleteDialog.getByRole('button', { name: '取消' }).click()
    await expect(row()).toHaveCount(1)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(2)

    // 确认删除：项目、会话记录都没了，磁盘上的项目文件夹和文件还在
    await openMenu()
    await window.getByRole('menuitem', { name: '删除' }).click()
    await deleteDialog.getByRole('button', { name: '删除项目' }).click()
    await expect(window.getByTestId('sidebar-project')).toHaveCount(0)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)
    expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('项目文件还在\n')
    expect(existsSync(project)).toBe(true)

    // 设置里也没有残留的已归档项目
    await window.keyboard.press('ControlOrMeta+,')
    await settingsNav(window).getByRole('button', { name: '会话与存储' }).click()
    await expect(window.getByTestId('archived-project')).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
