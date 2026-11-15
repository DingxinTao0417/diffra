import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 1x1 的 PNG
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const SEVERAL = {
  questions: [
    { question: '要做哪些页面？', header: '页面', multiSelect: true, options: [{ label: '首页', description: '带搜索框', image: 'designs/home.png' }, { label: '设置' }, { label: '关于' }] },
    { question: '列表每页多少条？', header: '分页', type: 'slider', min: 10, max: 100, step: 10, unit: '条', default: 20 },
    { question: '样式写在哪个文件？', header: '文件', type: 'file' },
  ],
}

// 第 673 步：ask_user 一次问几个（选项卡），多选带预览图、滑块、选项目文件；只有一个单选问题时点一下就答；Esc 不答
test('提问：几个问题分选项卡，多选带预览图、滑块、从项目里选文件，都答了才能提交，答案交给模型；单选点一下就答；Esc 不答', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-ask-'))
  mkdirSync(join(project, 'designs'))
  writeFileSync(join(project, 'designs', 'home.png'), PIXEL)
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'theme.css'), 'body {}\n')
  const model = await startScriptedModel([
    { toolCalls: [{ name: 'ask_user', input: SEVERAL }] },
    { toolCalls: [{ name: 'ask_user', input: { questions: [{ question: '先做哪个？', options: [{ label: '首页' }, { label: '设置' }] }] } }] },
    { toolCalls: [{ name: 'ask_user', input: { questions: [{ question: '要深色吗？', type: 'slider', min: 0, max: 1 }] } }] },
    { text: '都记下了' },
  ])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '做个后台')

    const card = window.getByTestId('permission-card')
    await expect(card).toContainText('智能体想先问你一下')
    const tabs = card.getByTestId('ask-tab')
    await expect(tabs).toHaveText(['页面', '分页', '文件'])
    // 滑块有默认值，算已答；另外两个没答，提交是灰的
    await expect(card).toContainText('还有 2 个没答')
    await expect(card.getByTestId('ask-submit')).toBeDisabled()

    // 多选：首页带预览图；选首页和关于
    const options = card.getByTestId('ask-option')
    await expect(options).toHaveCount(3)
    await expect(options.first().getByRole('img', { name: '首页' })).toBeVisible()
    await expect(options.first()).toContainText('带搜索框')
    await options.nth(0).click()
    await options.nth(2).click()
    await expect(options.nth(0)).toHaveAttribute('aria-checked', 'true')
    await expect(options.nth(1)).toHaveAttribute('aria-checked', 'false')
    await card.screenshot({ path: 'test-results/ask-user-choice.png' })

    // 方向键换到「分页」：滑块往右一格是 30 条
    await tabs.first().focus()
    await window.keyboard.press('ArrowRight')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    const slider = card.getByTestId('ask-slider')
    await expect(card.getByTestId('ask-slider-value')).toHaveText('20 条')
    await slider.focus()
    await window.keyboard.press('ArrowRight')
    await expect(card.getByTestId('ask-slider-value')).toHaveText('30 条')

    // 选文件：系统选择框（这里替换掉）选了一个项目里的和一个项目外的，只收项目里的
    await tabs.nth(2).click()
    await app.evaluate(({ dialog }, files) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: files })) as typeof dialog.showOpenDialog
    }, [join(project, 'src', 'theme.css')])
    await card.getByRole('button', { name: '从项目里选一个文件…' }).click()
    await expect(card.getByTestId('ask-files')).toHaveText('src/theme.css')
    // 手输一个不存在的：不收
    await card.getByLabel('文件路径').fill('src/missing.css')
    await card.getByLabel('文件路径').press('Enter')
    await expect(window.getByText('项目里没有这个文件：src/missing.css')).toBeVisible()
    await expect(card.getByTestId('ask-files')).toHaveText('src/theme.css')
    await expect(card.getByTestId('ask-submit')).toBeEnabled()
    await expect(tabs.filter({ has: window.getByLabel('已答') })).toHaveCount(3)
    await card.screenshot({ path: 'test-results/ask-user-file.png' })
    await card.getByTestId('ask-submit').click()

    // 第二个提问只有一个单选问题：点选项就是回答，没有提交按钮
    await expect(card).toContainText('先做哪个？')
    await expect(card.getByTestId('ask-submit')).toHaveCount(0)
    await expect(card.getByTestId('ask-option')).toHaveText(['首页', '设置'])
    await card.getByTestId('ask-option').nth(1).click()

    // 第三个：Esc 不答
    await expect(card).toContainText('要深色吗？')
    await window.keyboard.press('Escape')
    await waitTaskDone(window)
    await expect(card).toHaveCount(0)

    const bodies = model.bodies()
    expect(bodies[1]).toContain('The user answered:')
    expect(bodies[1]).toContain('要做哪些页面？ 首页、关于')
    expect(bodies[1]).toContain('列表每页多少条？ 30 条')
    expect(bodies[1]).toContain('样式写在哪个文件？ src/theme.css')
    expect(bodies[2]).toContain('The user chose: 设置')
    expect(bodies[3]).toContain('The user did not answer')
    // 对话里留下每次提问的结论
    const turn = window.getByTestId('turn').last()
    await expect(turn).toContainText(/提问\s*要做哪些页面？/)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('提问卡：深色和窄窗口下不溢出，预览图按比例缩小', async () => {
  test.setTimeout(60_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-ask-narrow-'))
  mkdirSync(join(project, 'designs'))
  writeFileSync(join(project, 'designs', 'home.png'), PIXEL)
  writeFileSync(join(project, 'theme.css'), 'body {}\n')
  const model = await startScriptedModel([{ toolCalls: [{ name: 'ask_user', input: SEVERAL }] }, { text: '好' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'test-key', modelId: 'scripted' })
    await chooseProject(app, window, project)
    await startTask(window, '做个后台')
    const card = window.getByTestId('permission-card')
    await expect(card.getByTestId('ask-option')).toHaveCount(3)
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect(window.locator('html')).toHaveClass(/dark/)
    await window.waitForTimeout(400)
    await card.screenshot({ path: 'test-results/ask-user-dark.png' })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(560, 820))
    await expect.poll(() => window.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)).toBeLessThanOrEqual(560)
    // 改窗口大小后侧栏、输入框还在重新排，等排好再量
    await expect
      .poll(() =>
        card.evaluate((element) => {
          const box = element as unknown as { scrollWidth: number; clientWidth: number }
          return box.scrollWidth - box.clientWidth
        }),
      )
      .toBe(0)
    await card.screenshot({ path: 'test-results/ask-user-narrow.png' })
    await card.getByRole('button', { name: '都不选，我来说' }).click()
    await waitTaskDone(window)
  } finally {
    await app.close()
    await model.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
