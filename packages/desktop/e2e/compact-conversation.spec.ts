import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone, cards } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('连续编辑折叠分组，重复修改按首次到最终内容统计；展开收起和交付入口可用', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-compact-'))
  writeFileSync(join(project, 'note.txt'), 'original\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'read_file', input: { path: 'note.txt' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'note.txt', old_string: 'original', new_string: 'intermediate' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'note.txt', old_string: 'intermediate', new_string: 'final' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '已完成文本修改' } }] },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '紧凑测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '修改文本')
    await waitTaskDone(window)
    const group = window.getByTestId('edit-group')
    await expect(group).toContainText('修改 1 个文件 · 2 次编辑')
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    await group.getByRole('button', { name: /修改 1 个文件/ }).click()
    await expect(cards(window, 'edit')).toHaveCount(2)
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    await cards(window, 'edit').first().getByRole('button', { name: '查看改动 note.txt', exact: true }).click()
    await expect(window.getByTestId('diff-view')).toContainText('intermediate')
    await window.getByRole('button', { name: '展开代码详情', exact: true }).click()
    await expect(window.getByTestId('diff-view')).toHaveCount(2)
    await window.getByRole('button', { name: '收起代码详情', exact: true }).click()
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    const delivery = cards(window, 'finish')
    // 临时项目没有检查命令，完成卡标成未经验证
    await expect(delivery).toContainText('已完成 · 未经自动验证')
    await expect(delivery.getByTestId('finish-counts')).toHaveText('1 个文件 +1 −1')
    await expect(delivery).toContainText('+1')
    await expect(delivery).not.toContainText('+2')
    await delivery.getByRole('button', { name: '审阅改动', exact: true }).click()
    await expect(window.getByTestId('review-file')).toContainText('note.txt')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
