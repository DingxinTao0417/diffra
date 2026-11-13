import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, read, startScriptedModel } from './scripted-model'

const DIAGNOSIS = {
  cause: '用户在等列文件的结果时停下了，任务本身没出错',
  evidence: [{ step: 's1', note: '文件已经列出来了' }],
  done: ['列出了项目文件'],
  remaining: ['读 a.txt 并回答'],
  prompt: '接着读 a.txt，然后回答用户。\n只读，不改文件。',
  questions: [{ question: '读完要改文件吗？', options: [{ label: '只读', text: '只读，不改文件。' }, { label: '改成大写', text: '读完把 a.txt 改成大写。' }] }],
}

test('模型很久没有输出时可以只重发这一步：提示消失，这一轮照常结束', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-retry-'))
  // 第一次请求 20 秒后才回，重发的那次马上回
  const model = await startScriptedModel([{ text: '这是卡住的回答', delayMs: 20_000 }, { text: '重发后回答了' }])
  const app = await launchApp(userDataDir, { DIFFRA_MODEL_SILENCE_MS: '1000' })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '慢模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '慢慢想')
    const hint = window.getByTestId('model-silence')
    await hint.getByRole('button', { name: '重试这一步' }).click()
    await expect(hint).toBeHidden()
    await waitTaskDone(window)
    await expect(window.getByText('重发后回答了')).toBeVisible()
    await expect(window.getByText('这是卡住的回答')).toHaveCount(0)
    expect(model.requests()).toBe(2)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('模型没输出时停下：停下说明写清多久没输出，「换模型继续」选好模型就接着发「继续」', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-stalled-'))
  const model = await startScriptedModel([{ text: '不会到这里', delayMs: 20_000 }, { text: '接着做完了' }])
  const app = await launchApp(userDataDir, { DIFFRA_MODEL_SILENCE_MS: '1000' })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '慢模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '慢慢想')
    await expect(window.getByTestId('model-silence')).toBeVisible()
    await window.getByRole('button', { name: '停止', exact: true }).click()
    const summary = window.getByTestId('stop-summary')
    await expect(summary).toContainText(/模型已 \d+ 秒没有输出，你停止了这一轮/)
    await summary.getByRole('button', { name: '换模型继续' }).click()
    await window.getByRole('menuitem', { name: /scripted/ }).click()
    await waitTaskDone(window)
    await expect(window.getByText('接着做完了')).toBeVisible()
    await expect(window.getByTestId('turn').last()).toContainText('继续')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('停下后定位问题：定位是单独一轮，结果卡写原因和证据；换问题的答案会改提示词；填入输入框可以撤销；任务结论不变', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-diagnose-'))
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  const model = await startScriptedModel([
    { toolCalls: [exec('ls')] },
    { text: '不会到这里', delayMs: 20_000 },
    { toolCalls: [{ name: 'submit_diagnosis', input: DIAGNOSIS }] },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看看 a.txt')
    await expect.poll(() => model.requests()).toBe(2)
    await window.getByRole('button', { name: '停止', exact: true }).click()
    await waitTaskStatus(window, 'stopped')
    const summary = window.getByTestId('stop-summary')
    await expect(summary).toContainText('你停止了这一轮')
    await summary.getByRole('button', { name: '定位问题' }).click()

    const card = window.getByTestId('diagnosis')
    await expect(card).toContainText('用户在等列文件的结果时停下了')
    await expect(window.getByTestId('turn').last()).toContainText('定位问题：上一轮为什么停下')
    // 定位请求带着停下的原因和那一轮的每一步
    const body = model.bodies().at(-1)!
    expect(body).toContain('How it ended: 被用户停止')
    expect(body).toContain('s1 [completed]')
    // 定位轮不改变任务结论；停下说明的按钮还留在被定位的那一轮上
    await waitTaskStatus(window, 'stopped')
    await expect(window.getByTestId('turn').first().getByTestId('stop-summary').getByRole('button', { name: '继续' })).toBeVisible()

    // 换答案：提示词里那一行跟着换
    const prompt = card.getByLabel('修复提示词')
    await expect(prompt).toHaveValue(DIAGNOSIS.prompt)
    await card.getByRole('button', { name: '改成大写' }).click()
    await expect(prompt).toHaveValue('接着读 a.txt，然后回答用户。\n读完把 a.txt 改成大写。')
    // 自己写答案
    await card.getByRole('button', { name: '其他…' }).click()
    await card.getByLabel('自己回答：读完要改文件吗？').fill('读完先问我')
    await card.getByLabel('自己回答：读完要改文件吗？').press('Enter')
    await expect(prompt).toHaveValue('接着读 a.txt，然后回答用户。\n读完先问我')

    // 填进输入框：原来的草稿还在前面，可以撤销
    await taskInput(window).fill('我先写的草稿')
    await card.getByRole('button', { name: '填入输入框' }).click()
    await expect(taskInput(window)).toHaveValue('我先写的草稿\n\n接着读 a.txt，然后回答用户。\n读完先问我')
    await window.getByTestId('composer-undo').click()
    await expect(taskInput(window)).toHaveValue('我先写的草稿')
    await expect(window.getByTestId('composer-undo')).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('子智能体被停下：卡片上能定位它，定位请求带着它的任务和步骤', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-diagnose-worker-'))
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'delegate', input: { name: '慢', task: 'WORKER-SLOW：把 a.txt 改成大写', files: ['a.txt'] } }] },
    { match: 'WORKER-SLOW', toolCalls: [read('a.txt')] },
    { match: 'WORKER-SLOW', toolCalls: [{ name: 'report', input: { summary: '不会到这里' } }], delayMs: 20_000 },
    { toolCalls: [{ name: 'submit_diagnosis', input: { ...DIAGNOSIS, cause: '工人读完文件后被停下，还没改' } }] },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '分给工人改 a.txt')
    const card = window.locator('[data-testid="agent-card"][data-agent="慢"]')
    await expect.poll(() => model.requests()).toBe(3)
    await window.getByRole('button', { name: '停止', exact: true }).click()
    await expect(card).toHaveAttribute('data-status', 'failed')
    await card.getByRole('button', { name: '定位问题' }).click()
    await expect(window.getByTestId('diagnosis')).toContainText('工人读完文件后被停下，还没改')
    await expect(window.getByTestId('turn').last()).toContainText('定位问题：子智能体「慢」为什么没做完')
    const body = model.bodies().at(-1)!
    expect(body).toContain('why worker \\"慢\\" did not finish')
    expect(body).toContain('Task given to the worker: WORKER-SLOW')
    expect(body).toContain('s1 [completed]')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
