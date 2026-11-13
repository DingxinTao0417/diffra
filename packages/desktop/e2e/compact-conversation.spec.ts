import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone, cards } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { read, replaceLines, startScriptedModel } from './scripted-model'

test('连续编辑折叠分组，重复修改按首次到最终内容统计；展开收起和交付入口可用', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-compact-'))
  writeFileSync(join(project, 'note.txt'), 'original\n')
  const model = await startScriptedModel([
    { toolCalls: [read('note.txt')] },
    { toolCalls: [replaceLines('note.txt', 'original', 'intermediate')] },
    { toolCalls: [replaceLines('note.txt', 'intermediate', 'final')] },
    { text: '已完成文本修改' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '紧凑测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '修改文本')
    await waitTaskDone(window)
    // 读文件和两次编辑收在一个过程组里，标题写改了几个文件
    const group = window.getByTestId('tool-group')
    await expect(group).toContainText('修改 1 个文件')
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    await group.getByRole('button', { name: /执行工具 3 次/ }).click()
    await expect(cards(window, 'edit')).toHaveCount(2)
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    await cards(window, 'edit').first().getByRole('button', { name: '查看改动 note.txt', exact: true }).click()
    await expect(window.getByTestId('diff-view')).toContainText('intermediate')
    await window.getByRole('button', { name: '展开代码详情', exact: true }).click()
    await expect(window.getByTestId('diff-view')).toHaveCount(2)
    await window.getByRole('button', { name: '收起代码详情', exact: true }).click()
    await expect(window.getByTestId('diff-view')).toHaveCount(0)
    // 临时项目没有检查命令：结论就是「已完成」；这一轮的净改动写在底部（改了两次只算一次），点开审阅（第 526 步起没有完成卡）
    await expect(window.getByTestId('task-status')).toContainText('已完成')
    await expect(cards(window, 'finish')).toHaveCount(0)
    const files = window.getByTestId('turn-files')
    await expect(files).toHaveText('1 个文件 +1 −1')
    await files.click()
    await expect(window.getByTestId('review-file')).toContainText('note.txt')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('每次调用前都先思考的模型：思考、读文件、改动收在同一个过程组里，运行中和跑完都默认收着；展开后一条一行', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-process-group-'))
  writeFileSync(join(project, 'note.txt'), 'original\n')
  const model = await startScriptedModel([
    { thinking: '先看看文件里现在写的是什么\n第二行是细节', toolCalls: [read('note.txt')] },
    { thinking: '把 original 换掉', toolCalls: [replaceLines('note.txt', 'original', 'final')] },
    // 慢一点：趁这一步还没回来，看运行中的样子
    { delayMs: 2500, text: '改好了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '思考测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '修改文本')

    // 运行中：两段思考、一次读、一次改动都在同一组里，组没有自动展开
    const group = window.getByTestId('tool-group')
    const header = group.getByRole('button', { name: /执行工具 2 次\s*· 修改 1 个文件/ })
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    // 只有过程组的标题行在转，下面不再多一行「进行中…」
    await expect(header.locator('.animate-spin')).toHaveCount(1)
    // 当场数一次，不等：等下去这一轮跑完，「进行中…」本来也会消失
    expect(await window.getByText('进行中…').count()).toBe(0)
    await expect(group).toHaveCount(1)
    await expect(group.getByTestId('thought')).toHaveCount(2)
    await expect(group.getByTestId('thought').first()).toBeHidden()
    await expect(cards(window, 'edit')).toHaveCount(1)

    await waitTaskDone(window)
    // 跑完还是收着；组外没有单独的思考行
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(window.getByTestId('thought')).toHaveCount(2)

    await header.click()
    const first = group.getByTestId('thought').first()
    await expect(first).toContainText('已思考')
    await expect(first).toContainText('先看看文件里现在写的是什么')
    await expect(first).not.toContainText('第二行是细节')
    await first.getByRole('button').click()
    await expect(first).toContainText('第二行是细节')
    const editRow = group.getByRole('button', { name: '查看改动 note.txt', exact: true })
    await expect(editRow).toBeVisible()
    // 改动那一行和思考那一行箭头对齐、一样高
    const thoughtRow = group.getByTestId('thought').nth(1).getByRole('button')
    const [thoughtArrow, editArrow, thoughtBox, editBox] = await Promise.all([thoughtRow.locator('svg').first().boundingBox(), editRow.locator('svg').first().boundingBox(), thoughtRow.boundingBox(), editRow.boundingBox()])
    expect(editArrow?.x).toBeCloseTo(thoughtArrow?.x ?? -1, 0)
    expect(editBox?.height).toBeCloseTo(thoughtBox?.height ?? -1, 0)
    await expect(group.locator('[data-testid="tool-call"][data-kind="tool"]')).toHaveCount(1)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
