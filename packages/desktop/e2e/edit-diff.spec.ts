import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { patch, read, replaceLines, startScriptedModel } from './scripted-model'

const lines = Array.from({ length: 200 }, (_, index) => `行 ${index + 1}`).join('\n')

// 一轮里改同一个大文件两处：改动卡片按文件里的行号显示，本轮交付按净改动算；重启后从记录载入还是一样
async function expectEdits(window: Page): Promise<void> {
  const group = window.getByTestId('tool-group')
  await expect(group).toContainText('修改 1 个文件')
  await expect(group).toContainText('+1')
  await expect(group).toContainText('−2')
  // 过程组收着时没有「展开代码详情」，先点开组
  await group.getByRole('button', { name: /执行工具 3 次/ }).click()
  await window.getByRole('button', { name: '展开代码详情', exact: true }).first().click()
  const views = window.getByTestId('diff-view')
  await expect(views).toHaveCount(2)
  await expect(views.nth(0)).toContainText('@@ -97,7 +97,7 @@')
  await expect(views.nth(0)).toContainText('行 100（改）')
  await expect(views.nth(1)).toContainText('@@ -147,7 +147,6 @@')
  const counts = window.getByTestId('finish-counts').first()
  await expect(counts).toContainText('+1')
  await expect(counts).toContainText('−2')
}

test('一个补丁里新建、删除、修改几个文件：改动卡片每个文件一行，分别写新建、删除、编辑', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-edit-diff-'))
  writeFileSync(join(project, 'old.txt'), '旧的\n')
  writeFileSync(join(project, 'keep.txt'), '一\n二\n')
  const model = await startScriptedModel([
    { toolCalls: [patch('*** Add File: new.txt', '+新的', '*** Delete File: old.txt', '*** Update File: keep.txt', ' 一', '-二', '+三')] },
    { text: '改好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '新建、删除、修改')
    await waitTaskDone(window)
    // 过程只有这一次调用时不套过程组，改动行直接显示
    await expect(window.getByTestId('tool-group')).toHaveCount(0)
    await expect(window.getByRole('button', { name: '查看改动 new.txt', exact: true })).toContainText('新建')
    await expect(window.getByRole('button', { name: '查看改动 old.txt', exact: true })).toContainText('删除')
    await expect(window.getByRole('button', { name: '查看改动 keep.txt', exact: true })).toContainText('编辑')
    expect(existsSync(join(project, 'old.txt'))).toBe(false)
    expect(readFileSync(join(project, 'new.txt'), 'utf8')).toBe('新的\n')
    expect(readFileSync(join(project, 'keep.txt'), 'utf8')).toBe('一\n三\n')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('改动卡片只带变化的那段：大文件改两处，行号是文件里的行号，本轮交付按净改动算；记录里只存一份整份文件；重启后载入照样显示', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-edit-diff-'))
  writeFileSync(join(project, 'big.txt'), `${lines}\n`)
  const model = await startScriptedModel([
    { toolCalls: [read('big.txt')] },
    { toolCalls: [replaceLines('big.txt', '行 100', '行 100（改）')] },
    { toolCalls: [patch('*** Update File: big.txt', '-行 150')] },
    { text: '改了两处' },
  ])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '改两处')
    await waitTaskDone(window)
    await expectEdits(window)

    // 记录里：第一次改带整份文件（base），第二次只带变化的那段
    const sessionsDir = join(userDataDir, 'sessions')
    // 每轮的更新单独存在 sessions/<会话 id>/<轮次>.json 里（第 437 步），这个任务只有一轮
    const sessionDir = join(sessionsDir, readdirSync(sessionsDir, { withFileTypes: true }).find((entry) => entry.isDirectory())!.name)
    const updates = readdirSync(sessionDir).filter((name) => name.endsWith('.json')).flatMap((name) => JSON.parse(readFileSync(join(sessionDir, name), 'utf8')) as Array<{ content?: unknown }>)
    const diffs = updates.flatMap((update) => (Array.isArray(update.content) ? update.content : [])).filter((content) => content.type === 'diff') as Array<{ oldText: string; _meta: { diffra: { edit: { base?: string } } } }>
    expect(diffs.map((diff) => diff._meta.diffra.edit.base !== undefined)).toEqual([true, false])
    expect(diffs.map((diff) => diff.oldText.split('\n').length)).toEqual([7, 7])

    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '改两处', exact: true }).click()
    await expectEdits(window)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
