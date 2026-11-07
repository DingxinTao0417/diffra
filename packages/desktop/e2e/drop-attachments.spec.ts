import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { MAX_PROMPT_FILE_REFERENCES } from '../src/shared/attachments'
import { chooseProject, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('通用占位与精简按钮，本地文件文件夹拖入、移除和外部文件读取仍需授权', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-drop-project-'))
  const outside = mkdtempSync(join(tmpdir(), 'diffra-drop-outside-'))
  const note = join(project, 'note.txt')
  const folder = join(project, 'assets')
  const external = join(outside, 'outside.txt')
  const credential = join(outside, '.env')
  writeFileSync(note, 'not automatically uploaded')
  mkdirSync(folder)
  writeFileSync(external, 'external-only-content')
  writeFileSync(credential, 'API_KEY=should-not-be-attached')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'read_file', input: { path: external } }] },
    { text: '已读到授权文件' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '拖入测试', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    const input = taskInput(window)
    await expect(input).toHaveAttribute('placeholder', '请输入指令')
    await expect(window.getByRole('button', { name: '先出计划', exact: true })).toHaveCount(0)
    await expect(window.getByRole('button', { name: '添加图片', exact: true })).toHaveCount(0)
    await chooseProject(app, window, project)
    const composer = window.getByTestId('composer')
    const session = await window.context().newCDPSession(window)
    const dispatch = async (paths: string[], type: 'dragEnter' | 'drop') => {
      const bounds = await composer.boundingBox()
      if (!bounds) throw new Error('输入框不可见')
      await session.send('Input.dispatchDragEvent', { type, x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, data: { items: [], files: paths, dragOperationsMask: 1 } })
    }
    // 原生 CDP 拖放实际磁盘文件，覆盖 preload webUtils 本地路径桥接。
    await dispatch([note, folder], 'dragEnter')
    await expect(window.getByTestId('composer-drop-zone')).toHaveText('松开以添加文件或文件夹')
    await dispatch([note, folder], 'drop')
    await expect(window.getByTestId('composer-file')).toHaveCount(2)
    await expect(composer).toHaveAttribute('aria-busy', 'false')
    await dispatch([note], 'dragEnter')
    await dispatch([note], 'drop')
    await expect(composer).toHaveAttribute('aria-busy', 'false')
    await expect(window.getByTestId('composer-file')).toHaveCount(2)
    await window.getByRole('button', { name: '移除附件 note.txt', exact: true }).click()
    await window.getByRole('button', { name: '移除附件 assets', exact: true }).click()
    await expect(window.getByTestId('composer-file')).toHaveCount(0)
    await expect(window.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
    await dispatch([credential], 'dragEnter')
    await dispatch([credential], 'drop')
    await expect(window.getByRole('status')).toContainText('不能添加')
    await expect(window.getByTestId('composer-file')).toHaveCount(0)
    const rejected = await window.evaluate(`(async () => {
      try { await window.diffra.describeAttachments(${JSON.stringify(Array.from({ length: MAX_PROMPT_FILE_REFERENCES + 1 }, () => note))}); return false }
      catch { return true }
    })()`)
    expect(rejected).toBe(true)
    await dispatch([external], 'dragEnter')
    await dispatch([external], 'drop')
    await expect(window.getByTestId('composer-file')).toHaveCount(1)
    await expect(composer).toHaveAttribute('aria-busy', 'false')
    // 仅附件也能发送，消息只含路径，不提前泄露外部内容。
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByTestId('task-title')).toBeVisible()
    const permission = window.getByTestId('permission-card')
    await expect(permission).toContainText('项目外读取')
    expect(model.bodies()[0]).toContain('outside.txt')
    expect(model.bodies()[0]).not.toContain('external-only-content')
    await permission.getByRole('button', { name: '仅允许本次操作', exact: true }).click()
    await waitTaskDone(window)
    expect(model.bodies()[1]).toContain('external-only-content')
    await expect(taskInput(window)).toHaveAttribute('placeholder', '请输入指令')
    await expect(window.getByTestId('composer-file')).toHaveCount(0)
    await session.detach()
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
