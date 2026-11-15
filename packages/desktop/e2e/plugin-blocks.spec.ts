import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { answerOpenDialog, chooseProject, openExtensions, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const fence = '```'

// 第 682 步：插件注册的富块——套用内置富块，或者插件里的模板放进沙箱
test('插件的富块：扩展页列出几种富块；回答里套用键值表的照内置的画，数据不对按代码显示；模板的在沙箱里拿到数据；模型的说明里有；导出时模板的写明要在 Diffra 里看', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const workspace = mkdtempSync(join(tmpdir(), 'diffra-e2e-plugin-blocks-'))
  const project = join(workspace, 'project')
  const plugin = join(workspace, 'ops')
  const downloads = join(workspace, 'out')
  mkdirSync(project)
  mkdirSync(downloads)
  write(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ops', version: '0.1.0' }))
  write(
    join(plugin, 'blocks', 'blocks.json'),
    JSON.stringify({
      blocks: [
        { kind: 'deploy-status', title: '部署状态', description: '一个服务的部署状态', renders: 'keyvalue' },
        { kind: 'build-report', title: '构建报告', description: '{"count": 包的个数}', renders: 'template', template: 'templates/build.html' },
      ],
    }),
  )
  write(join(plugin, 'templates', 'build.html'), '<div id="out"></div><script>document.getElementById("out").textContent = "构建了 " + window.diffraData.count + " 个包"</script>')
  const answer = [
    '部署情况：',
    '',
    `${fence}deploy-status`,
    JSON.stringify({ 服务: 'api', 状态: '已上线' }),
    fence,
    '',
    `${fence}build-report`,
    JSON.stringify({ count: 3 }),
    fence,
    '',
    `${fence}build-report`,
    '{ 不是 JSON',
    fence,
  ].join('\n')
  const model = await startScriptedModel([{ text: answer }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await openExtensions(window, '已安装')
    await answerOpenDialog(app, plugin)
    await window.getByRole('button', { name: '从文件夹安装' }).click()
    const card = window.getByTestId('plugin-card').filter({ hasText: 'ops' }).first()
    await expect(card.getByTestId('plugin-contents')).toContainText('2 种富块')

    await window.getByTestId('sidebar').getByRole('button', { name: '新任务' }).click()
    await chooseProject(app, window, project)
    await startTask(window, '部署得怎么样')
    await waitTaskDone(window)
    expect(model.bodies()[0]).toContain('deploy-status: 部署状态 — 一个服务的部署状态 (same JSON as keyvalue)')

    const reply = window.getByTestId('agent-message').last()
    await expect(reply.getByTestId('rich-keyvalue')).toContainText('已上线')
    await expect(reply.getByTestId('rich-keyvalue')).toContainText('部署状态')
    const blocks = reply.getByTestId('plugin-block')
    await expect(blocks).toHaveCount(1)
    await expect(blocks).toContainText('来自插件 ops')
    await expect(blocks.locator('iframe').contentFrame().locator('#out')).toHaveText('构建了 3 个包')
    await expect(reply.getByTestId('rich-fallback').or(reply.getByText('数据不是合法的 JSON'))).toHaveCount(1)
    await reply.screenshot({ path: 'test-results/plugin-blocks.png' })

    // 导出：键值表照样画，模板的写明要在 Diffra 里看
    await app.evaluate(({ session }, target) => {
      session.defaultSession.on('will-download', (_event, item) => item.setSavePath(`${target}/${item.getFilename()}`))
    }, downloads)
    await window.getByTestId('turn-actions').last().getByRole('button', { name: '导出这一轮' }).click()
    await window.getByRole('menuitem', { name: 'HTML', exact: true }).click()
    const file = join(downloads, '部署得怎么样.html')
    await expect.poll(() => existsSync(file), { timeout: 20_000 }).toBe(true)
    const html = readFileSync(file, 'utf8')
    expect(html).toContain('data-testid="rich-keyvalue"')
    expect(html).toContain('插件画的内容，在 Diffra 里打开才能看')
  } finally {
    await app.close()
    await model.close()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
