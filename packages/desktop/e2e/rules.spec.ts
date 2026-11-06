import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

const USER_PACK = `---
id: team
name: 团队约定
languages: *
source: 团队内部
license: 内部使用
---

## 接口
- [TEAM-API-1][强制] 接口路径用小写和连字符。
- [TEAM-API-2][推荐] 返回体带 requestId。
`

test('规范页：按项目开关规则包和单条规则，导入、删除自定义规则包，新会话按语言选包', async () => {
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-rules-'))
  writeFileSync(join(project, 'app.ts'), 'export const x = 1\n')
  const packDir = mkdtempSync(join(tmpdir(), 'diffra-e2e-pack-'))
  const goodPack = join(packDir, 'team.md')
  const badPack = join(packDir, 'bad.md')
  writeFileSync(goodPack, USER_PACK)
  writeFileSync(badPack, USER_PACK.replace('TEAM-API-2', 'GEN-ERR-1'))
  const model = await startScriptedModel([])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 系统文件夹和文件对话框在测试里替换成直接返回指定路径
    const answerDialog = (path: string) =>
      app.evaluate(({ dialog }, target) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [target] })) as typeof dialog.showOpenDialog
      }, path)
    const nav = window.getByRole('navigation')

    await answerDialog(project)
    await nav.getByRole('button', { name: '会话' }).click()
    await window.getByRole('button', { name: '选择项目文件夹' }).click()
    // 项目里只有 TypeScript，Java 和 Python 包不选
    await expect(window.getByTestId('session-info')).toContainText('规范：通用、安全、TypeScript / JavaScript')

    await nav.getByRole('button', { name: '规范' }).click()
    await expect(window.getByTestId('rules-project')).toHaveText(project)
    for (const id of ['universal', 'security', 'java', 'typescript', 'python']) {
      await expect(window.getByTestId(`rule-pack-${id}`)).toContainText('内置')
    }

    // 关掉安全包，打开审查，关掉通用包里的一条规则
    await window.getByLabel('在当前项目启用「安全」').uncheck()
    await window.getByLabel('完成前按规则审查改动').check()
    const universal = window.getByTestId('rule-pack-universal')
    await universal.getByRole('button', { name: '查看规则' }).click()
    await universal.getByLabel('启用规则 GEN-NAME-1').uncheck()
    await expect(window.getByTestId('rules-notice')).toHaveText('已保存，从下一个新会话开始生效')

    // 规则编号和内置包冲突的规则包导入失败，说明原因
    await answerDialog(badPack)
    await window.getByRole('button', { name: '导入规则包' }).click()
    await expect(window.getByRole('alert').filter({ hasText: '操作失败' })).toContainText('GEN-ERR-1')

    await answerDialog(goodPack)
    await window.getByRole('button', { name: '导入规则包' }).click()
    await expect(window.getByTestId('rules-notice')).toHaveText('已导入规则包「团队约定」')
    await expect(window.getByTestId('rule-pack-team')).toContainText('导入')
    await expect(window.getByTestId('rule-pack-team')).toContainText('强制 1 条 · 推荐 1 条')
    await window.screenshot({ path: 'test-results/rules.png' })

    // 新会话按新的设置选包：安全包关了，导入的不分语言的包加进来
    await nav.getByRole('button', { name: '会话' }).click()
    await window.getByRole('button', { name: '新会话' }).click()
    await expect(window.getByTestId('session-info')).toContainText('规范：通用、团队约定、TypeScript / JavaScript')

    const settings = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))
    expect(settings.projects[project].rules).toEqual({
      disabledPacks: ['security'],
      disabledRules: ['GEN-NAME-1'],
      includeRecommended: false,
      review: true,
    })
    expect(readFileSync(join(userDataDir, 'rules', 'team.md'), 'utf8')).toBe(USER_PACK)

    await nav.getByRole('button', { name: '规范' }).click()
    await window.getByRole('button', { name: '删除「团队约定」' }).click()
    await expect(window.getByTestId('rule-pack-team')).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
    rmSync(packDir, { recursive: true, force: true })
  }
})
