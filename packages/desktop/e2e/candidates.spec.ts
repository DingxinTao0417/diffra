import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { cards, chooseProject, startTask, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, exec, startScriptedModel } from './scripted-model'

const PLAN = {
  name: 'submit_plan',
  input: {
    understanding: '给项目加两个文件',
    steps: [
      { title: '加 a.txt', detail: '写一行', files: ['a.txt'] },
      { title: '加 b.txt', detail: '写一行', files: ['b.txt'] },
    ],
    risks: [],
  },
}

function gitRepo(dir: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  execFileSync('git', ['init', '-q'], { cwd: dir, env })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir, env })
  writeFileSync(join(dir, 'readme.md'), '# demo\n')
  execFileSync('git', ['add', '.'], { cwd: dir, env })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir, env })
}

async function planFirst(window: Page, text: string): Promise<void> {
  const input = window.getByRole('textbox', { name: '任务', exact: true })
  await input.pressSequentially('/计划')
  await input.press('Enter')
  await startTask(window, text)
  await expect(cards(window, 'plan')).toHaveCount(1, { timeout: 20_000 })
}

test('计划逐步打勾：按计划执行时计划卡片上每一步跟着智能体的步骤清单打勾', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-plan-steps-'))
  const model = await startScriptedModel([
    { toolCalls: [exec('ls')] },
    { toolCalls: [PLAN] },
    // 按计划执行：先打勾第一步，第二步进行中，再改文件
    { toolCalls: [{ name: 'update_plan', input: { plan: [{ step: '加 a.txt', status: 'completed' }, { step: '加 b.txt', status: 'in_progress' }] } }] },
    { toolCalls: [addFile('a.txt', 'a\n'), addFile('b.txt', 'b\n')] },
    { text: '两个文件都加了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await planFirst(window, '加两个文件')
    const planCard = cards(window, 'plan')
    // 还没执行：手动勾选框，没有进度
    await expect(planCard.getByTestId('plan-progress')).toHaveCount(0)
    await planCard.getByRole('button', { name: '按计划执行' }).click()
    await waitTaskStatus(window, 'done', 20_000)
    // 执行完：两步都打勾（进行中的那一步在这一轮正常结束时算做完）
    await expect(planCard.getByTestId('plan-progress')).toHaveText('按计划执行过：做完 2 / 2 步')
    const steps = planCard.getByTestId('plan-step')
    await expect(steps).toHaveCount(2)
    await expect(steps.nth(0)).toHaveAttribute('data-status', 'completed')
    await expect(steps.nth(1)).toHaveAttribute('data-status', 'completed')
    await expect(steps.nth(0).getByRole('img', { name: '已完成' })).toBeVisible()
    // 模型看到的提问带着照着打勾的要求
    expect(model.bodies().some((body) => body.includes('use update_plan to mark each one in_progress'))).toBe(true)
    await window.screenshot({ path: 'test-results/plan-steps-progress.png' })
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('多候选方案：从计划生成两个候选，各在一个 worktree 里做；看改动、并排比较、选一个应用回项目，worktree 清掉；应用后能撤销', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-candidates-'))
  gitRepo(project)
  const model = await startScriptedModel([
    { toolCalls: [exec('ls')] },
    { toolCalls: [PLAN] },
    // 两个候选并行跑，按提问里的「候选方案「名字」」分剧本
    { match: '候选方案「方案 A」', toolCalls: [addFile('a.txt', 'from A\n')] },
    { match: '候选方案「方案 A」', text: 'A 加了 a.txt' },
    { match: '候选方案「方案 B」', toolCalls: [addFile('b.txt', 'from B\n')] },
    { match: '候选方案「方案 B」', text: 'B 加了 b.txt' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await planFirst(window, '加两个文件')

    await cards(window, 'plan').getByRole('button', { name: '生成候选方案…' }).click()
    const dialog = window.getByRole('dialog')
    await expect(dialog.getByLabel('第 1 个候选的名字')).toHaveValue('方案 A')
    await expect(dialog.getByLabel('第 2 个候选的思路')).toHaveValue('用尽量少的改动实现，只改必要的地方')
    await expect(dialog.getByLabel('第 3 个候选的名字')).toHaveCount(0)
    await dialog.getByRole('button', { name: '开始生成' }).click()

    const card = window.getByTestId('candidates-card')
    await expect(card).toHaveAttribute('data-status', 'ready', { timeout: 30_000 })
    const candidates = card.getByTestId('candidate')
    await expect(candidates).toHaveCount(2)
    await expect(candidates.nth(0)).toContainText('A 加了 a.txt')
    await expect(candidates.nth(1)).toContainText('B 加了 b.txt')
    await expect(candidates.nth(0)).toContainText('1 个文件')
    // 每个候选的过程在自己的卡片里
    await expect(window.getByRole('button', { name: '展开候选方案 方案 A 的步骤' })).toBeVisible()
    await expect(window.getByTestId('agent-team')).toContainText('同时生成 2 个候选方案')
    // 项目本身没动
    expect(existsSync(join(project, 'a.txt'))).toBe(false)
    expect(existsSync(join(project, 'b.txt'))).toBe(false)
    const worktrees = join(userDataDir, 'worktrees')
    expect(readdirSync(worktrees)).toHaveLength(1)

    // 看改动
    await candidates.nth(0).getByRole('button', { name: '看改动' }).click()
    await expect(candidates.nth(0).getByTestId('candidate-diff')).toContainText('from A')
    // 并排比较：左右各一个候选
    await card.getByRole('button', { name: '并排比较' }).click()
    const compare = card.getByTestId('candidate-compare')
    await expect(compare.getByTestId('candidate-diff')).toHaveCount(2)
    await expect(compare.getByTestId('candidate-diff').nth(0)).toContainText('a.txt')
    await expect(compare.getByTestId('candidate-diff').nth(1)).toContainText('b.txt')
    await window.screenshot({ path: 'test-results/candidates-compare.png' })

    // 应用方案 B：项目里多了 b.txt，没有 a.txt；这组候选的 worktree 都清掉
    await candidates.nth(1).getByRole('button', { name: '应用这个' }).click()
    await expect(card).toHaveAttribute('data-status', 'applied', { timeout: 20_000 })
    await expect(candidates.nth(1)).toContainText('已应用')
    await expect.poll(() => existsSync(join(project, 'b.txt'))).toBe(true)
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('from B\n')
    expect(existsSync(join(project, 'a.txt'))).toBe(false)
    expect(readdirSync(join(worktrees, readdirSync(worktrees)[0]!))).toEqual([])
    expect(execFileSync('git', ['worktree', 'list'], { cwd: project, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1)
    const applied = window.getByTestId('turn').last()
    await expect(applied.getByTestId('user-message')).toHaveText('应用候选方案「方案 B」')
    await waitTaskStatus(window, 'unfinished')

    // 撤销应用的这一轮：文件回去
    await applied.getByTestId('turn-actions').getByRole('button', { name: '撤销这一轮及之后的改动' }).click()
    await window.getByTestId('restore-confirm').click()
    await expect.poll(() => existsSync(join(project, 'b.txt'))).toBe(false)
    await window.screenshot({ path: 'test-results/candidates-applied.png' })
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
