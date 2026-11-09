import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, settingsNav, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

test('内置规范全部生效：按项目语言选包，强制级和推荐级都写进提示词；设置里没有规范页', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-rules-'))
  writeFileSync(join(project, 'app.ts'), 'export const x = 1\n')
  const model = await startScriptedModel([{ text: '好' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(app, window, project)

    // 项目里只有 TypeScript：通用、安全、TS 三个包，Java 和 Python 不选
    await startTask(window, '看看项目')
    await waitTaskDone(window)
    await expect(window.getByTestId('monitor-rule-packs')).toHaveText('通用、安全、TypeScript / JavaScript')
    await expect(window.getByTestId('monitor-panel')).toContainText('完成前规范审查已开')
    await expect(window.getByTestId('monitor-panel').getByRole('button', { name: '规范设置' })).toHaveCount(0)
    const prompt = model.bodies()[0] ?? ''
    // 强制级（通用、安全、TS 各一条）和推荐级都在系统提示词里
    for (const ruleId of ['GEN-ERR-1', 'SEC-INJ-1', 'TS-TYPE-1']) expect(prompt).toContain(`- ${ruleId}: `)
    expect(prompt).toContain('- GEN-NAME-4（推荐）: ')
    expect(prompt).not.toContain('- JAVA-')
    // 随 Diffra 带的 Skill 在索引里，路径指向真实的文件（打包后在 resources/skills）；项目里没有界面代码，不加前端的做法
    const designSkill = /- frontend-design: [^\n]*?\(([^()]+\/SKILL\.md)\)/.exec(JSON.parse(prompt).messages[0].content as string)
    expect(designSkill?.[1]).toMatch(/\/skills\/frontend-design\/SKILL\.md$/)
    expect(existsSync(designSkill?.[1] ?? '')).toBe(true)
    expect(prompt).not.toContain('Front-end work')

    await window.keyboard.press('Control+,')
    await expect(settingsNav(window).getByRole('button', { name: '规范' })).toHaveCount(0)
    await settingsNav(window).getByLabel('搜索设置').fill('规范')
    await expect(settingsNav(window).getByRole('button', { name: '规范' })).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
