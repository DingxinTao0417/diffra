import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelsPage, providerCard } from './model-setup'
import { replaceLines, startScriptedModel } from './scripted-model'

test('Enter 发送、Shift+Enter 换行；项目外读写分别申请，本会话授权复用且拒绝不写入', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-project-'))
  const external = mkdtempSync(join(tmpdir(), 'diffra-external-'))
  const target = join(external, 'note.txt')
  const image = join(external, 'shot.png')
  writeFileSync(target, 'before')
  writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'))
  // 按路径读项目外文件的工具只剩 view_image（命令读文件不问路径），改项目外文件用 apply_patch
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'view_image', input: { path: image } }] },
    { toolCalls: [{ name: 'view_image', input: { path: image } }] },
    { toolCalls: [replaceLines(target, 'before', 'after')] },
    { text: '已保留原文件' },
    { toolCalls: [{ name: 'view_image', input: { path: image } }] },
    { toolCalls: [replaceLines(target, 'before', 'approved')] },
    { text: '已完成授权写入' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '权限测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    // 能看图的模型才有 view_image
    await openModelsPage(window)
    await providerCard(window, '权限测试').getByRole('button', { name: 'scripted 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '配置能力', exact: true }).click()
    const capabilities = window.getByRole('dialog')
    await capabilities.getByRole('checkbox', { name: '视觉', exact: true }).click()
    await capabilities.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(capabilities).toBeHidden()
    await window.getByRole('button', { name: '返回' }).click()
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
    // 第二次读同一路径不再问；写入单独申请
    await expect(permission).toContainText('项目外写入')
    await permission.getByRole('button', { name: '拒绝', exact: true }).click()
    // 写入被拒、文件没动：纯回答，不要求验证
    await waitTaskStatus(window, 'done')
    expect(readFileSync(target, 'utf8')).toBe('before')
    await input.fill('允许修改')
    await input.press('Enter')
    await expect(permission).toContainText('项目外写入')
    await permission.getByRole('button', { name: '仅允许本次操作' }).click()
    // 改的是项目外的文件（第 484 步起不算本轮改动）：不跑结束门禁，回完话就结束
    await waitTaskStatus(window, 'done')
    expect(readFileSync(target, 'utf8')).toBe('approved')
    expect(model.requests()).toBe(7)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
