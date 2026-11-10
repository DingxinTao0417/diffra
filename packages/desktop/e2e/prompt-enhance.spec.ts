import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const ENHANCED = {
  prompt: '把 a.txt 里的 alpha 改成大写，改完读一遍确认。\n只改 a.txt，别的文件不动。',
  questions: [{ question: '只改这一个文件吗？', options: [{ label: '只改它', text: '只改 a.txt，别的文件不动。' }, { label: '全局', text: '项目里所有 alpha 都改成大写。' }] }],
}

test('首页优化提示词：改写稿替换草稿，问题条换答案只改那一行，撤销优化回到原来的草稿', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-enhance-'))
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  const model = await startScriptedModel([{ toolCalls: [{ name: 'submit_prompt', input: ENHANCED }] }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    const input = taskInput(window)
    const enhance = window.getByRole('button', { name: '优化提示词' })
    await expect(enhance).toBeDisabled()
    await input.fill('改一下 a.txt')
    await enhance.click()
    await expect(input).toHaveValue(ENHANCED.prompt)
    // 问题条：默认选中改写稿用的答案，换成别的只替换那一行
    const questions = window.getByTestId('composer-questions')
    await expect(questions).toContainText('只改这一个文件吗？')
    await expect(questions.getByRole('button', { name: '只改它' })).toHaveAttribute('aria-pressed', 'true')
    await questions.getByRole('button', { name: '全局' }).click()
    await expect(input).toHaveValue('把 a.txt 里的 alpha 改成大写，改完读一遍确认。\n项目里所有 alpha 都改成大写。')
    // 优化请求带着项目顶层和原来的草稿
    const body = model.bodies()[0]!
    expect(body).toContain('Top level of the project: ')
    expect(body).toContain('a.txt')
    expect(body).toContain('改一下 a.txt')
    // 撤销优化：回到原来的草稿，问题条收起
    await window.getByTestId('composer-undo').click()
    await expect(input).toHaveValue('改一下 a.txt')
    await expect(questions).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('任务里优化提示词带上最近的对话；等结果时改了草稿就不替换', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-enhance-task-'))
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  const model = await startScriptedModel([{ text: '看过 a.txt 了' }, { toolCalls: [{ name: 'submit_prompt', input: ENHANCED }], delayMs: 2000 }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '先看看 a.txt')
    await waitTaskDone(window)
    const input = taskInput(window)
    await input.fill('再改一下')
    await window.getByRole('button', { name: '优化提示词' }).click()
    await input.press('End')
    await input.pressSequentially('，顺便加注释')
    await expect(window.getByRole('status')).toContainText('优化期间草稿改过了，没有替换')
    await expect(input).toHaveValue('再改一下，顺便加注释')
    await expect(window.getByTestId('composer-questions')).toHaveCount(0)
    const body = model.bodies().at(-1)!
    expect(body).toContain('Recent conversation in this task:')
    expect(body).toContain('先看看 a.txt')
    expect(body).toContain('看过 a.txt 了')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
