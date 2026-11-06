import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, settingsNav, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('开了规范审查：违规被打回，改好后审查通过再完成', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-review-'))
  writeFileSync(join(project, 'main.ts'), 'export {}\n')
  // 没分配评审角色时审查用编码模型，所以编码和审查的回复按请求顺序排在同一个剧本里
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'edit_file', input: { path: 'app.ts', old_string: '', new_string: 'try {\n  run()\n} catch {}\n' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '加了 run 调用' } }] },
    { text: 'GEN-ERR-1 | app.ts:3 | catch 块是空的，吞掉了异常' },
    { toolCalls: [{ name: 'read_file', input: { path: 'app.ts' } }] },
    { toolCalls: [{ name: 'edit_file', input: { path: 'app.ts', old_string: '} catch {}', new_string: '} catch (error) {\n  throw error\n}' } }] },
    { toolCalls: [{ name: 'finish', input: { summary: '异常继续抛出' } }] },
    { text: 'NO_VIOLATIONS' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)

    // 规范页默认就是刚才在用的项目
    await window.getByTestId('sidebar').getByRole('button', { name: '设置' }).click()
    await settingsNav(window).getByRole('button', { name: '规范' }).click()
    await expect(window.getByTestId('rules-project')).toHaveValue(project)
    await window.getByLabel('完成前按规则审查改动').check()
    await expect(window.getByTestId('rules-notice')).toHaveText('已保存，新建或重新打开的任务按新设置运行')
    await window.getByRole('button', { name: '返回' }).click()

    await startTask(window, '在 app.ts 里调用 run')
    const reviews = cards(window, 'review')
    const finishes = cards(window, 'finish')
    await expect(finishes).toHaveCount(2, { timeout: 20_000 })
    await waitTaskDone(window)
    await expect(window.getByTestId('monitor-rule-packs')).toHaveText('通用、安全、TypeScript / JavaScript')
    await expect(window.getByTestId('monitor-panel')).toContainText('完成前规范审查已开')
    await expect(finishes.nth(0)).toHaveAttribute('data-status', 'failed')
    await expect(finishes.nth(0)).toContainText('规范审查发现 1 处问题')
    await expect(finishes.nth(1)).toHaveAttribute('data-status', 'completed')
    await expect(reviews).toHaveCount(2)
    await expect(reviews.nth(0)).toHaveAttribute('data-status', 'failed')
    await expect(reviews.nth(0)).toContainText('1 处问题，已打回')
    await expect(reviews.nth(0)).toContainText('GEN-ERR-1')
    await expect(reviews.nth(0)).toContainText('app.ts:3')
    await expect(reviews.nth(1)).toHaveAttribute('data-status', 'completed')
    await expect(reviews.nth(1)).toContainText('没有发现违反规范的地方')
    expect(readFileSync(join(project, 'app.ts'), 'utf8')).toBe('try {\n  run()\n} catch (error) {\n  throw error\n}\n')
    expect(model.requests()).toBe(7)
    await window.screenshot({ path: 'test-results/review.png' })
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
