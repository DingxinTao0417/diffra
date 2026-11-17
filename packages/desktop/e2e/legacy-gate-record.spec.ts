import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cards, chooseProject, startTask, waitTaskDone, waitTaskStatus } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, startScriptedModel } from './scripted-model'

// 结束门禁移除前存下的会话：轮次里有检查命令卡、完成卡，turnOutcome 带 finish，任务状态带 needsVerification。
// 新版本照常打开：检查卡照旧画，结论只说已完成，界面不出错
test('结束门禁移除前的旧记录：检查卡照旧显示，结论是已完成，界面不出错', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-legacy-gate-'))
  const model = await startScriptedModel([{ toolCalls: [addFile('a.txt', 'one')] }, { text: '写好了' }])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '写 a.txt')
    await waitTaskDone(window)
    await app.close()

    // 改成门禁移除前存下的样子：会话文件 sessions/<id>.json，每轮的更新在 sessions/<id>/<轮次>.json
    const sessions = join(userDataDir, 'sessions')
    const [file] = readdirSync(sessions).filter((name) => name.endsWith('.json') && name !== 'index.json')
    const sessionId = file!.slice(0, -'.json'.length)
    const record = JSON.parse(readFileSync(join(sessions, file!), 'utf8'))
    record.taskState = { status: 'completed', reason: null, needsVerification: true }
    writeFileSync(join(sessions, file!), JSON.stringify(record))
    const [turnFile] = readdirSync(join(sessions, sessionId))
    const updates = JSON.parse(readFileSync(join(sessions, sessionId, turnFile!), 'utf8'))
    updates.push(
      { sessionUpdate: 'tool_call', toolCallId: 'legacy-check', title: '完成检查：npm test', kind: 'execute', status: 'in_progress' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'legacy-check',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Exit code: 0\n2 passed' } }],
        _meta: { diffra: { result: 'passed' } },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'legacy-finish',
        title: '完成',
        kind: 'other',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '检查通过：npm test' } }],
        _meta: { diffra: { verification: 'verified' } },
      },
      { sessionUpdate: 'session_info_update', _meta: { diffra: { taskState: { status: 'completed', reason: null, requirements: [], needsVerification: false }, turnOutcome: { finish: 'verified', stop: null } } } },
    )
    writeFileSync(join(sessions, sessionId, turnFile!), JSON.stringify(updates))

    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '写 a.txt', exact: true }).click()
    await waitTaskStatus(window, 'done')
    await expect(window.getByTestId('task-status')).toHaveText('已完成')
    await expect(cards(window, 'check')).toHaveCount(1)
    await expect(cards(window, 'check').first()).toContainText('完成检查')
    await expect(cards(window, 'check').first()).toContainText('通过')
    await expect(window.getByTestId('app-crash')).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
