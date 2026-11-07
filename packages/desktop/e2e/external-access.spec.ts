import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('Enter 发送、Shift+Enter 换行；项目外读写分别申请，本会话授权复用且拒绝不写入', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-project-'))
  const external = mkdtempSync(join(tmpdir(), 'diffra-external-'))
  const target = join(external, 'note.txt')
  writeFileSync(target, 'before')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'read_file', input: { path: target } }] },
    { toolCalls: [{ name: 'read_file', input: { path: target } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: target, old_string: 'before', new_string: 'after' } }] },
    { text: '已保留原文件' },
    { toolCalls: [{ name: 'read_file', input: { path: target } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: target, old_string: 'before', new_string: 'approved' } }] },
    { text: '已完成授权写入' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '权限测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    const input = window.getByRole('textbox', { name: '任务', exact: true })
    await input.fill('读取外部文件')
    await input.press('Shift+Enter')
    await input.press('x')
    await expect(input).toHaveValue('读取外部文件\nx')
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
    await expect(input).toHaveValue('读取外部文件\nx')
    await input.press('Enter')
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('项目外读取')
    await permission.getByRole('button', { name: '本会话允许此路径的同类操作' }).click()
    await expect(permission).toContainText('项目外写入')
    await permission.getByRole('button', { name: '拒绝', exact: true }).click()
    await waitTaskDone(window)
    expect(readFileSync(target, 'utf8')).toBe('before')
    await input.fill('允许修改')
    await input.press('Enter')
    await expect(permission).toContainText('项目外写入')
    await permission.getByRole('button', { name: '仅允许本次操作' }).click()
    await waitTaskDone(window)
    expect(readFileSync(target, 'utf8')).toBe('approved')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
