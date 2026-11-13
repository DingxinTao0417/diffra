import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, lastUserText, patch, read, type ScriptMessages, startScriptedModel } from './scripted-model'

test('完成前规范审查（默认开着）：违规被打回，改好后审查通过再完成', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-review-'))
  writeFileSync(join(project, 'main.ts'), 'export {}\n')
  // 没分配评审角色时审查用编码模型；审查请求按系统提示词认出来，按 reviewReplies 回复
  const model = await startScriptedModel(
    [
      { toolCalls: [addFile('app.ts', 'try {\n  run()\n} catch {}\n')] },
      // 想结束这一轮：结束门禁跑规范审查，打回时追加一条用户消息，接着调模型
      { text: '加了 run 调用' },
      { toolCalls: [read('app.ts')] },
      { toolCalls: [patch('*** Update File: app.ts', '   run()', '-} catch {}', '+} catch (error) {', '+  throw error', '+}')] },
      { text: '异常继续抛出' },
    ],
    { reviewReplies: ['GEN-ERR-1 | app.ts:3 | catch 块是空的，吞掉了异常', 'NO_VIOLATIONS'] },
  )
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)

    await startTask(window, '在 app.ts 里调用 run')
    const reviews = cards(window, 'review')
    await expect(reviews).toHaveCount(2, { timeout: 20_000 })
    await waitTaskDone(window)
    // 打回和通过都看审查卡，对话里不再有完成卡（第 526 步）
    await expect(cards(window, 'finish')).toHaveCount(0)
    await expect(window.getByTestId('monitor-rule-packs')).toHaveText('通用、安全、TypeScript / JavaScript')
    await expect(window.getByTestId('monitor-panel')).toContainText('完成前规范审查已开')
    await expect(reviews.nth(0)).toHaveAttribute('data-status', 'failed')
    await expect(reviews.nth(0)).toContainText('1 处问题，已打回')
    await expect(reviews.nth(0)).toContainText('GEN-ERR-1')
    await expect(reviews.nth(0)).toContainText('app.ts:3')
    await expect(reviews.nth(1)).toHaveAttribute('data-status', 'completed')
    await expect(reviews.nth(1)).toContainText('没有发现违反规范的地方')
    expect(readFileSync(join(project, 'app.ts'), 'utf8')).toBe('try {\n  run()\n} catch (error) {\n  throw error\n}\n')
    expect(model.requests()).toBe(5)
    expect(model.ruleReviews()).toBe(2)
    // 打回是对话末尾追加的一条用户消息，不是工具结果
    const rejected = lastUserText((JSON.parse(model.bodies()[2]!) as { messages: ScriptMessages }).messages)
    expect(rejected).toContain('[Diffra] Before ending the turn Diffra ran the project checks')
    expect(rejected).toContain('GEN-ERR-1')
    await window.screenshot({ path: 'test-results/review.png' })
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
