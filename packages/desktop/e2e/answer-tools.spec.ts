import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { exec, read, startScriptedModel } from './scripted-model'

const section = (name: string) => `${name}这一节讲了很多细节，要一步步看。`.repeat(18)
const LONG = ['# 总览', section('总览'), '## 安装', section('安装'), '## 配置', section('配置'), '### 环境变量', section('环境变量'), '## 部署', section('部署'), '```md', '## 代码里的标题不算', '```'].join('\n\n')
const SHORT = ['## 只有一个标题', '短回答，不需要目录。'].join('\n\n')

// 第 674 步：长回答顶上的目录；选中一段文字或一张卡，「解释这个 / 展开这个 / 换个说法」填进输入框
test('长回答有目录，点了跳过去，短回答没有；选中一段文字能让它解释、展开、换个说法；卡片上能「问问这张卡」', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-answer-tools-'))
  const model = await startScriptedModel([{ text: LONG }, { text: SHORT }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '讲讲怎么部署')
    await waitTaskDone(window)

    const answer = window.getByTestId('agent-message').first()
    const toc = answer.getByTestId('answer-toc')
    await expect(toc.getByRole('link')).toHaveText(['总览', '安装', '配置', '环境变量', '部署'])
    // 三级标题缩进
    const indent = (name: string) => toc.getByRole('listitem').filter({ hasText: name }).evaluate((item) => (item as unknown as { style: { paddingLeft: string } }).style.paddingLeft)
    expect(await indent('环境变量')).not.toBe(await indent('配置'))
    await toc.screenshot({ path: 'test-results/answer-toc.png' })
    await toc.getByRole('link', { name: '部署' }).click()
    await expect(answer.getByRole('heading', { name: '部署' })).toBeInViewport()

    // 选中「安装」那一节的一段：浮出三个按钮，点「展开这个」把这段引用进输入框
    const paragraph = answer.locator('p').filter({ hasText: '安装这一节' })
    await paragraph.scrollIntoViewIfNeeded()
    await paragraph.selectText()
    await paragraph.dispatchEvent('pointerup')
    const menu = window.getByTestId('selection-ask')
    await expect(menu.getByRole('button')).toHaveText(['解释这个', '展开这个', '换个说法'])
    await menu.screenshot({ path: 'test-results/selection-ask.png' })
    await menu.getByRole('button', { name: '展开这个' }).click()
    await expect(menu).toHaveCount(0)
    await expect(taskInput(window)).toHaveValue(/^展开讲讲这段：\n> 安装这一节讲了很多细节/)

    // 卡片：本轮报告上有「问问这张卡」
    await taskInput(window).fill('')
    await window.getByTestId('turn-actions').getByRole('button', { name: '本轮报告' }).click()
    await window.getByRole('button', { name: '问问这张卡' }).first().click()
    await expect(taskInput(window)).toHaveValue(/^关于这张卡片：\n> /)

    // 短回答没有目录
    await taskInput(window).fill('再短一点')
    await window.keyboard.press('Control+Enter')
    await expect(window.getByTestId('agent-message')).toHaveCount(2)
    await waitTaskDone(window)
    await expect(window.getByTestId('agent-message').last()).toContainText('短回答')
    await expect(window.getByTestId('agent-message').last().getByTestId('answer-toc')).toHaveCount(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 680 步：朗读。系统语音换成记录下来的替身，不真的出声
const STUB_SPEECH = `(() => {
  window.__spoken = []
  window.__cancelled = 0
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
  const synth = window.speechSynthesis
  synth.speak = (utterance) => { window.__spoken.push({ text: utterance.text, voice: utterance.voice ? utterance.voice.voiceURI : null }); setTimeout(() => utterance.onend && utterance.onend(), 200) }
  synth.cancel = () => { window.__cancelled += 1 }
  synth.getVoices = () => [{ name: '测试女声', lang: 'zh-CN', voiceURI: 'test-zh' }, { name: 'Test Voice', lang: 'en-US', voiceURI: 'test-en' }]
  synth.dispatchEvent(new Event('voiceschanged'))
})()`

test('朗读：读回答的文字，代码和表格线不念；读完按钮回到「朗读」；能选声音并记住；能中途停', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-speech-'))
  const answer = ['## 结论', '', '第一句话。第二句话！', '', '```ts', 'const secretNumber = 1', '```', '', '| 列 | 值 |', '| --- | --- |', '| a | 1 |', '', '最后一句。'].join('\n')
  const model = await startScriptedModel([{ text: answer }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '念给我听')
    await waitTaskDone(window)
    await window.evaluate(STUB_SPEECH)
    const actions = window.getByTestId('turn-actions')
    const spoken = () => window.evaluate<Array<{ text: string; voice: string | null }>>('window.__spoken')

    await actions.getByRole('button', { name: '朗读', exact: true }).click()
    await expect(actions.getByRole('button', { name: '停止朗读' })).toHaveAttribute('aria-pressed', 'true')
    await expect(actions.getByRole('button', { name: '朗读', exact: true })).toBeVisible({ timeout: 10_000 })
    const text = (await spoken()).map((item) => item.text).join('')
    expect(text).toContain('结论')
    expect(text).toContain('第一句话。第二句话！')
    expect(text).toContain('这里有一段代码。')
    expect(text).toContain('最后一句。')
    expect(text).not.toContain('secretNumber')
    expect(text).not.toContain('---')

    // 选声音：记住，下次朗读用它
    await actions.getByRole('button', { name: '选择朗读的声音' }).click()
    await window.getByRole('menuitemradio', { name: /测试女声/ }).click()
    expect(await window.evaluate(`localStorage.getItem('diffra.speechVoice')`)).toBe('test-zh')
    await window.evaluate('window.__spoken = []')
    await actions.getByRole('button', { name: '朗读', exact: true }).click()
    await expect.poll(async () => (await spoken())[0]?.voice).toBe('test-zh')

    // 中途停
    await actions.getByRole('button', { name: '停止朗读' }).click()
    await expect(actions.getByRole('button', { name: '朗读', exact: true })).toBeVisible()
    expect(await window.evaluate<number>('window.__cancelled')).toBeGreaterThan(0)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 681 步：时间轴回放
test('回放这一轮：拖动滑块一步步看，对话里只显示到那一步；播放会走到最后停下；退出后恢复', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-replay-'))
  writeFileSync(join(project, 'a.txt'), 'hello\n')
  const model = await startScriptedModel([{ toolCalls: [read('a.txt')] }, { toolCalls: [exec('echo hi')] }, { text: '都看完了' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '看看文件')
    await waitTaskDone(window)
    const turn = window.getByTestId('turn').last()
    await turn.getByTestId('turn-actions').getByRole('button', { name: '回放这一轮' }).click()
    const replay = turn.getByTestId('turn-replay')
    const label = replay.getByTestId('turn-replay-step')
    await expect(label).toHaveText('第 1 步：提问')
    await expect(turn.getByTestId('agent-message')).toHaveCount(0)
    await expect(turn.getByTestId('turn-actions')).toHaveCount(0)

    const slider = replay.getByTestId('turn-replay-slider')
    await slider.focus()
    await window.keyboard.press('ArrowRight')
    await expect(label).toContainText('第 2 步：')
    await expect(label).toContainText('a.txt')
    await window.keyboard.press('End')
    await expect(label).toContainText('回答：都看完了')
    await expect(turn.getByTestId('agent-message')).toContainText('都看完了')
    await replay.screenshot({ path: 'test-results/turn-replay.png' })

    // 在最后点播放：从头走一遍，到最后停下
    await replay.getByRole('button', { name: '播放' }).click()
    await expect(label).toHaveText('第 1 步：提问')
    await expect(label).toContainText('回答：都看完了', { timeout: 10_000 })
    await expect(replay.getByRole('button', { name: '播放' })).toBeVisible()

    await replay.getByRole('button', { name: '退出回放' }).click()
    await expect(replay).toHaveCount(0)
    await expect(turn.getByTestId('turn-actions')).toHaveCount(1)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 687 步：回答里的命令能打进终端（不按回车）或填进输入框，有风险的先说清楚
test('可执行代码块：命令打进这个项目的终端但不执行；有风险的先列出原因，确认后才打；console 写法去掉提示符后能填进输入框', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-run-code-'))
  const answer = ['先看看目录：', '', '```bash', 'echo run-code-ok', '```', '', '清掉构建产物：', '', '```bash', 'rm -rf build', '```', '', '```console', '$ pnpm test', '> 跑测试的输出', '```'].join('\n')
  const model = await startScriptedModel([{ text: answer }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '给我几条命令')
    await waitTaskDone(window)
    const blocks = window.getByTestId('agent-message').last().getByTestId('code-block')
    await expect(blocks).toHaveCount(3)

    // 普通命令：打进终端，不执行（终端里只有命令，没有输出）
    await blocks.nth(0).getByRole('button', { name: '在终端运行（打进去，按回车才执行）' }).click()
    const host = window.getByTestId('terminal-host')
    await expect(host).toContainText('echo run-code-ok', { timeout: 20_000 })
    await expect(host).not.toContainText(/^run-code-ok$/m)

    // 有风险的：先列出原因，确认后才打
    await blocks.nth(1).getByRole('button', { name: '在终端运行（打进去，按回车才执行）' }).click()
    const risk = blocks.nth(1).getByTestId('command-risk')
    await expect(risk).toContainText('递归删除文件和目录')
    await risk.screenshot({ path: 'test-results/command-risk.png' })
    await risk.getByRole('button', { name: '取消' }).click()
    await expect(risk).toHaveCount(0)
    await expect(host).not.toContainText('rm -rf build')
    await blocks.nth(1).getByRole('button', { name: '在终端运行（打进去，按回车才执行）' }).click()
    await blocks.nth(1).getByRole('button', { name: '仍然打进终端' }).click()
    await expect(host).toContainText('rm -rf build')

    // console 写法：去掉 $ 提示符和输出行
    await blocks.nth(2).getByRole('button', { name: '填入输入框' }).click()
    await expect(taskInput(window)).toHaveValue('pnpm test')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})


// 第 686 步：回答里的 diff 直接应用，走正常的改文件流程
test('应用回答里的 diff：记成一轮「应用回答里的改动」，改了文件、有改动卡片，能撤销；没写文件名的 diff 没有这个按钮', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-apply-diff-'))
  writeFileSync(join(project, 'a.txt'), 'hello\n')
  const answer = ['改成这样：', '', '```diff', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-hello', '+hi', '```', '', '这一段没写文件名：', '', '```diff', '@@ -1 +1 @@', '-x', '+y', '```'].join('\n')
  const model = await startScriptedModel([{ text: answer }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '帮我改一下')
    await waitTaskDone(window)
    const diffs = window.getByTestId('agent-message').last().getByTestId('diff-block')
    await expect(diffs).toHaveCount(2)
    await expect(diffs.nth(1).getByRole('button', { name: '应用这个改动' })).toHaveCount(0)

    await diffs.nth(0).getByRole('button', { name: '应用这个改动' }).click()
    await expect(window.getByTestId('turn')).toHaveCount(2)
    // 应用了还没跑检查：未完成 · 未验证
    await expect(window.getByTestId('task-status')).toContainText('未验证', { timeout: 20_000 })
    const applied = window.getByTestId('turn').last()
    await expect(applied.getByTestId('user-message')).toHaveText('应用回答里的改动：a.txt')
    await expect.poll(() => readFileSync(join(project, 'a.txt'), 'utf8')).toBe('hi\n')
    await expect(applied.getByTestId('turn-files')).toContainText('1 个文件')

    // 撤销这一轮：文件回去
    await applied.getByTestId('turn-actions').getByRole('button', { name: '撤销这一轮及之后的改动' }).click()
    await window.getByTestId('restore-confirm').click()
    await expect.poll(() => readFileSync(join(project, 'a.txt'), 'utf8')).toBe('hello\n')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 689 步：决策卡——按加权平均分排名，改权重排名跟着变；「选这个」连同权重填进输入框；导出的页面展开各项得分、没有按钮
test('决策卡：按权重排名，改权重排名跟着变、能恢复；至少留一项有权重；选这个连同权重填进输入框；导出时各项得分展开', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-decision-'))
  const downloads = mkdtempSync(join(tmpdir(), 'diffra-e2e-decision-out-'))
  const decision = {
    title: '缓存放哪里',
    question: '要不要上 Redis？',
    criteria: [{ name: '性能', weight: 3 }, { name: '改动量', weight: 2 }, '运维'],
    options: [
      { name: 'Redis', summary: '多实例共享', scores: { 性能: 5, 改动量: 2, 运维: 2 }, recommended: true },
      { name: '进程内缓存', summary: '改动最小', scores: { 性能: 4, 改动量: 5, 运维: 5 } },
    ],
  }
  const model = await startScriptedModel([{ text: ['两个方案：', '', '```decision', JSON.stringify(decision), '```'].join('\n') }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '缓存放哪里')
    await waitTaskDone(window)
    const card = window.getByTestId('rich-decision')
    const options = card.getByTestId('decision-option')
    const ranking = () => options.evaluateAll((items) => items.map((item) => `${item.querySelector('.font-bold')?.textContent} ${item.querySelector('[data-testid="decision-score"]')?.textContent}`))

    // 模型给的权重 3、2、1：进程内缓存 (12+10+5)/6=4.5 排第一，Redis (15+4+2)/6=3.5 是模型推荐
    await expect.poll(ranking).toEqual(['进程内缓存 4.5 / 5', 'Redis 3.5 / 5'])
    await expect(options.nth(1)).toHaveAttribute('data-recommended', 'true')
    await expect(options.nth(1)).toContainText('模型推荐')
    await card.screenshot({ path: 'test-results/decision-light.png' })

    // 只看性能：改动量、运维降到 0，Redis 排到第一；性能是唯一有权重的一项，不能再降
    for (let i = 0; i < 2; i++) await card.getByRole('button', { name: '降低「改动量」的权重' }).click()
    await card.getByRole('button', { name: '降低「运维」的权重' }).click()
    await expect(card.getByRole('button', { name: '降低「运维」的权重' })).toBeDisabled()
    await card.getByRole('button', { name: '提高「性能」的权重' }).click()
    await card.getByRole('button', { name: '提高「性能」的权重' }).click()
    await expect(card.getByRole('button', { name: '提高「性能」的权重' })).toBeDisabled()
    await expect.poll(ranking).toEqual(['Redis 5.0 / 5', '进程内缓存 4.0 / 5'])
    for (let i = 0; i < 4; i++) await card.getByRole('button', { name: '降低「性能」的权重' }).click()
    await expect(card.getByLabel('「性能」的权重', { exact: true })).toHaveText('1')
    await expect(card.getByRole('button', { name: '降低「性能」的权重' })).toBeDisabled()

    // 各项得分展开；选这个连同当时的权重填进输入框
    await options.nth(0).getByRole('button', { name: '各项得分' }).click()
    await expect(options.nth(0).getByTestId('decision-scores')).toContainText('性能5 / 5')
    await options.nth(0).getByRole('button', { name: '选这个' }).click()
    await expect(taskInput(window)).toHaveValue('选「Redis」。我看重的：性能（权重 1）、改动量（权重 0）、运维（权重 0）')

    // 恢复模型给的权重
    await card.getByRole('button', { name: '恢复模型给的权重' }).click()
    await expect.poll(ranking).toEqual(['进程内缓存 4.5 / 5', 'Redis 3.5 / 5'])
    await expect(card.getByRole('button', { name: '恢复模型给的权重' })).toHaveCount(0)

    // 导出：按模型给的权重，各项得分展开，没有按钮
    await app.evaluate(({ session }, target) => {
      session.defaultSession.on('will-download', (_event, item) => item.setSavePath(`${target}/${item.getFilename()}`))
    }, downloads)
    await window.getByTestId('turn-actions').last().getByRole('button', { name: '导出这一轮' }).click()
    await window.getByRole('menuitem', { name: 'HTML', exact: true }).click()
    const file = join(downloads, '缓存放哪里.html')
    await expect.poll(() => existsSync(file), { timeout: 20_000 }).toBe(true)
    const html = readFileSync(file, 'utf8')
    expect(html.match(/data-testid="decision-scores"/g)).toHaveLength(2)
    expect(html).toContain('×3')
    expect(html).not.toContain('选这个')
    expect(html).not.toContain('各项得分')
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(downloads, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
