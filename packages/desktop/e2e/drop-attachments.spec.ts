import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { MAX_PROMPT_FILE_REFERENCES } from '../src/shared/attachments'
import { chooseProject, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, startScriptedModel } from './scripted-model'

test('通用占位与精简按钮，本地文件文件夹拖入、移除；外部文件只带路径，内容要智能体自己读', async () => {
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
    // 项目外的文本文件用命令读（没有 read_file 了）；每次询问模式下读项目外要先问（第 549 步）
    { toolCalls: [exec(`cat '${external.replaceAll('\\', '/')}'`)] },
    { text: '已读到外部文件' },
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
    // 拖入的文件在输入框里留下 @ 提示词，点附件能看路径
    await expect(input).toHaveValue(/@note\.txt/)
    await window.getByRole('button', { name: '预览附件 note.txt', exact: true }).click()
    // 应用显示解析后的真实路径；临时目录可能是指向别处的目录联接，断言按真实路径比
    await expect(window.getByRole('dialog')).toContainText(realpathSync.native(note))
    await window.keyboard.press('Escape')
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
    await expect(permission).toContainText('outside.txt', { timeout: 20_000 })
    expect(model.bodies()).toHaveLength(1)
    await permission.getByRole('button', { name: '允许一次', exact: true }).click()
    await waitTaskDone(window)
    expect(model.bodies()[0]).toContain('outside.txt')
    expect(model.bodies()[0]).not.toContain('external-only-content')
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
