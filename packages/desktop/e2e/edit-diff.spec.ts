import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const lines = Array.from({ length: 200 }, (_, index) => `行 ${index + 1}`).join('\n')

// 一轮里改同一个大文件两处：改动卡片按文件里的行号显示，本轮交付按净改动算；重启后从记录载入还是一样
async function expectEdits(window: Page): Promise<void> {
  const group = window.getByTestId('edit-group')
  await expect(group).toContainText('修改 1 个文件 · 2 次编辑')
  await expect(group).toContainText('+1')
  await expect(group).toContainText('−2')
  // 改动组收着时没有「展开代码详情」，先点开组
  await group.getByText('修改 1 个文件 · 2 次编辑').click()
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

test('改动卡片只带变化的那段：大文件改两处，行号是文件里的行号，本轮交付按净改动算；记录里只存一份整份文件；重启后载入照样显示', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-edit-diff-'))
  writeFileSync(join(project, 'big.txt'), `${lines}\n`)
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'read_file', input: { path: 'big.txt' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'big.txt', old_string: '行 100\n', new_string: '行 100（改）\n' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'big.txt', old_string: '行 150\n', new_string: '' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '改了两处' } }] },
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
    const file = readdirSync(sessionsDir).find((name) => name !== 'index.json' && name.endsWith('.json'))!
    const saved = JSON.parse(readFileSync(join(sessionsDir, file), 'utf8')) as { turns: Array<{ updates: Array<{ content?: unknown }> }> }
    const diffs = saved.turns.flatMap((turn) => turn.updates.flatMap((update) => (Array.isArray(update.content) ? update.content : []))).filter((content) => content.type === 'diff') as Array<{ oldText: string; _meta: { diffra: { edit: { base?: string } } } }>
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
