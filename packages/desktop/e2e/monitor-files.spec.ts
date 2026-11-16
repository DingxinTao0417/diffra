import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, startScriptedModel } from './scripted-model'

test('任务监控的产出默认十条，可展开全部和收起；点改动统计打开审阅，审阅仍保留完整列表', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-monitor-files-'))
  const model = await startScriptedModel([
    { toolCalls: Array.from({ length: 12 }, (_, index) => addFile(`file-${index}.txt`, 'content\n')) },
    { text: '新增十二个文件' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '监控测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '新增文件')
    await waitTaskDone(window)
    const panel = window.getByTestId('monitor-panel')
    await expect(panel.getByTestId('monitor-changes')).toContainText('12 个文件')
    await expect(panel.getByTestId('monitor-file')).toHaveCount(10)
    await panel.getByRole('button', { name: '展开全部（剩余 2 个）', exact: true }).click()
    await expect(panel.getByTestId('monitor-file')).toHaveCount(12)
    await panel.getByRole('button', { name: '收起', exact: true }).click()
    await expect(panel.getByTestId('monitor-file')).toHaveCount(10)
    await panel.getByTestId('monitor-changes').click()
    await expect(window.getByTestId('review-file')).toHaveCount(12)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('任务监控默认显示未提交改动，本任务累计另列；外部提交后状态刷新', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-monitor-git-'))
  const git = (args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@diffra.local'])
  git(['config', 'user.name', 'Diffra Test'])
  writeFileSync(join(project, 'tracked.txt'), 'one\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])
  writeFileSync(join(project, 'tracked.txt'), 'one\ntwo\n')
  const model = await startScriptedModel([{ text: '只看不动' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '监控测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看下工作区')
    await waitTaskDone(window)
    const panel = window.getByTestId('monitor-panel')
    await expect(panel.getByTestId('monitor-uncommitted')).toContainText('1 个文件未提交')
    await expect(panel.getByTestId('monitor-changes')).toContainText('本任务还没有改动')
    await expect(panel.getByTestId('monitor-commit')).toContainText('提交或推送')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'commit externally'])
    await expect(panel.getByTestId('monitor-uncommitted')).toContainText('工作区干净', { timeout: 15_000 })
    await expect(panel.getByTestId('monitor-commit')).toContainText('已提交')
    await expect(panel.getByTestId('monitor-commit')).toContainText('没有远程分支')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
