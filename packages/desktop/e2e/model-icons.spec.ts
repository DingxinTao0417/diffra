import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { GOOD_KEY, startMockProvider } from '../../core/test/mock-provider'
import { APP_VERSION, launchApp, makeUserDataDir } from './launch'
import { openModelsPage, providerCard } from './model-setup'

// Lobe Icons 的每个 SVG 里都有 <title>品牌名</title>，首字母方块和 lucide 图标没有
function brandTitles(scope: Locator): Locator {
  return scope.locator('svg title')
}

interface SavedProvider {
  name: string
  icon: unknown
  models: Array<{ id: string; enabled?: boolean }>
}

function savedProvider(userDataDir: string, name: string): SavedProvider | undefined {
  const settings = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as { providers: SavedProvider[] }
  return settings.providers.find((provider) => provider.name === name)
}

function savedIcon(userDataDir: string, name: string): unknown {
  return savedProvider(userDataDir, name)?.icon
}

function savedEnabled(userDataDir: string, name: string, modelId: string): boolean | undefined {
  return savedProvider(userDataDir, name)?.models.find((model) => model.id === modelId)?.enabled
}

// 应用启动前写好设置文件，只带必填项和 extra 里的字段
function writeSettings(userDataDir: string, extra: Record<string, unknown> = {}): void {
  const roles = { coder: null, planner: null, reviewer: null, fallback: null }
  // 记成已经看过这个版本：配了模型的旧设置文件会被当成老用户升级，弹「已更新」提示
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, providers: [], roles, lastSeenVersion: APP_VERSION, ...extra }))
}

// 选好了模型时菜单分两级（第 532 步）：先点「模型」展开模型列表；group 是这个服务那一组（标题和它的模型）
async function openMenuGroup(window: Page, providerName: string): Promise<{ label: Locator; group: Locator }> {
  await window.getByRole('button', { name: '返回', exact: true }).click()
  await window.getByTestId('model-menu').click()
  const models = window.getByRole('menuitem', { name: /^模型/ })
  if (await models.isVisible()) await models.click()
  const label = window.getByRole('menu').last().locator('[data-slot="dropdown-menu-label"]').filter({ hasText: providerName })
  return { label, group: label.locator('xpath=..') }
}

test('自定义服务按名称自动匹配图标，认不出来时手动选，也能改回自动匹配', async () => {
  const userDataDir = makeUserDataDir()
  const mock = await startMockProvider()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await openModelsPage(window)
    const dialog = window.getByRole('dialog')
    const iconButton = dialog.getByTestId('provider-icon-button')
    const unrecognized = dialog.getByRole('button', { name: '没认出来，点这里选', exact: true })
    const addCustom = async (name: string) => {
      await window.getByRole('button', { name: '添加模型服务', exact: true }).click()
      await dialog.getByRole('combobox', { name: '供应商', exact: true }).click()
      await window.getByRole('option', { name: '自定义', exact: true }).click()
      await dialog.getByLabel('名称', { exact: true }).fill(name)
      await dialog.getByLabel('地址', { exact: true }).fill(`${mock.baseUrl}/openai/v1`)
      await dialog.getByLabel('API Key', { exact: true }).fill(GOOD_KEY)
      await dialog.getByRole('textbox', { name: '模型 ID 1', exact: true }).fill('mock-a')
    }
    const saveDialog = async (button: '校验并添加模型' | '校验并保存') => {
      await dialog.getByRole('button', { name: '下一步', exact: true }).click()
      await dialog.getByRole('button', { name: button, exact: true }).click()
      await expect(dialog).toBeHidden()
    }

    // ① 名称写 SiliconFlow，按钮自动换成 SiliconCloud 图标，保存后卡片头像也是它
    await addCustom('SiliconFlow')
    await expect(iconButton).toHaveAttribute('aria-label', '更换图标（当前：SiliconCloud）')
    await expect(unrecognized).toBeHidden()
    await saveDialog('校验并添加模型')
    await expect(brandTitles(providerCard(window, 'SiliconFlow')).first()).toHaveText('SiliconCloud')
    await expect.poll(() => savedIcon(userDataDir, 'SiliconFlow')).toBeNull()

    // ② 认不出来的名称：出现提示，卡片是首字母方块
    const name = '我的私有网关'
    const card = providerCard(window, name)
    await addCustom(name)
    await expect(unrecognized).toBeVisible()
    await expect(iconButton).toHaveAttribute('aria-label', '更换图标')
    await saveDialog('校验并添加模型')
    await expect(card.getByText('我', { exact: true }).first()).toBeVisible()
    await expect(brandTitles(card)).toHaveCount(0)
    // 模型行的图标只有 16px，写不下字，回退成通用图标而不是首字母方块
    await expect(card.getByTestId('model-row-mock-a').getByText('我', { exact: true })).toHaveCount(0)

    // 编辑时点提示打开选择器，按中文别名搜到 DeepSeek，在搜索框按 Enter 选中第一条
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    await unrecognized.click()
    const picker = window.getByTestId('icon-picker')
    const search = picker.getByLabel('搜索图标', { exact: true })
    await search.fill('深度求索')
    await expect(picker.getByTestId('icon-option')).toHaveCount(1)
    await expect(picker.getByRole('radio', { name: '选择图标：DeepSeek', exact: true })).toBeVisible()
    await search.press('Enter')
    await expect(picker).toBeHidden()
    await expect(iconButton).toHaveAttribute('aria-label', '更换图标（当前：DeepSeek）')
    await expect(unrecognized).toBeHidden()
    await saveDialog('校验并保存')
    await expect(brandTitles(card).first()).toHaveText('DeepSeek')
    await expect(card.getByText('我', { exact: true })).toHaveCount(0)
    await expect.poll(() => savedIcon(userDataDir, name)).toBe('DeepSeek')

    // 卡片上切换模型的启用开关会整份重存服务配置，自选图标不能丢
    const enabledSwitch = card.getByRole('switch', { name: 'mock-a 启用', exact: true })
    await enabledSwitch.click()
    await expect.poll(() => savedEnabled(userDataDir, name, 'mock-a')).toBe(false)
    expect(savedIcon(userDataDir, name)).toBe('DeepSeek')
    // 主进程先写盘、再把结果交回界面；等开关真的变成关，再点第二下，不然点的还是旧状态，又存一次「关」
    await expect(enabledSwitch).not.toBeChecked()
    await enabledSwitch.click()
    await expect.poll(() => savedEnabled(userDataDir, name, 'mock-a')).toBe(true)
    expect(savedIcon(userDataDir, name)).toBe('DeepSeek')
    await expect(brandTitles(card).first()).toHaveText('DeepSeek')

    // 输入框模型菜单：分组标题只写名字，不带图标（第 532 步）；认不出型号的模型行用服务的自选图标
    const { label, group } = await openMenuGroup(window, name)
    await expect(brandTitles(label)).toHaveCount(0)
    await expect(brandTitles(group.getByRole('menuitem').filter({ hasText: 'mock-a' }))).toHaveText('DeepSeek')
    await window.keyboard.press('Escape')

    // ③ 改回自动匹配，回到首字母方块
    await openModelsPage(window)
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    await iconButton.click()
    await expect(picker.getByRole('radio', { name: '选择图标：DeepSeek', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(picker.getByRole('radio', { name: '选择图标：自动匹配', exact: true })).toHaveAttribute('aria-checked', 'false')
    await picker.getByRole('radio', { name: '选择图标：自动匹配', exact: true }).click()
    await expect(picker).toBeHidden()
    await expect(iconButton).toHaveAttribute('aria-label', '更换图标')
    await expect(unrecognized).toBeVisible()
    await saveDialog('校验并保存')
    await expect(card.getByText('我', { exact: true }).first()).toBeVisible()
    await expect(brandTitles(card)).toHaveCount(0)
    await expect.poll(() => savedIcon(userDataDir, name)).toBeNull()
  } finally {
    await app.close()
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('预设服务自动带上图标，模型行按模型 ID 匹配图标', async () => {
  const userDataDir = makeUserDataDir()
  const mock = await startMockProvider()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await openModelsPage(window)
    await window.getByRole('button', { name: '添加模型服务', exact: true }).click()
    const dialog = window.getByRole('dialog')
    await dialog.getByRole('combobox', { name: '供应商', exact: true }).click()
    await window.getByRole('option', { name: 'DeepSeek', exact: true }).click()
    // 改成认不出的名称，图标只能来自预设
    const name = '主力服务'
    await dialog.getByLabel('名称', { exact: true }).fill(name)
    await expect(dialog.getByTestId('provider-icon-button')).toHaveAttribute('aria-label', '更换图标（当前：DeepSeek）')
    await dialog.getByLabel('地址', { exact: true }).fill(`${mock.baseUrl}/openai/v1`)
    await dialog.getByLabel('API Key', { exact: true }).fill(GOOD_KEY)
    await dialog.getByRole('textbox', { name: '模型 ID 1', exact: true }).fill('qwen3-coder')
    await dialog.getByRole('button', { name: '下一步', exact: true }).click()
    await dialog.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(dialog).toBeHidden()

    // ④ 卡片头像是预设的 DeepSeek；⑤ 模型行按模型 ID 用 Qwen
    const card = providerCard(window, name)
    await expect(brandTitles(card).first()).toHaveText('DeepSeek')
    await expect(brandTitles(card.getByTestId('model-row-qwen3-coder'))).toHaveText('Qwen')
    await expect.poll(() => savedIcon(userDataDir, name)).toBeNull()

    const { label, group } = await openMenuGroup(window, name)
    await expect(brandTitles(label)).toHaveCount(0)
    await expect(brandTitles(group.getByRole('menuitem').filter({ hasText: 'qwen3-coder' }))).toHaveText('Qwen')
    await window.keyboard.press('Escape')
  } finally {
    await app.close()
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('旧设置文件没有 icon 字段：预设服务照样显示图标，改动还能正常保存', async () => {
  const userDataDir = makeUserDataDir()
  writeSettings(userDataDir, {
    providers: [
      {
        id: 'deepseek-old',
        presetId: 'deepseek',
        name: 'DeepSeek',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-chat', contextWindow: null }],
      },
    ],
  })
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await openModelsPage(window)
    const card = providerCard(window, 'DeepSeek')
    await expect(brandTitles(card).first()).toHaveText('DeepSeek')

    await card.getByRole('switch', { name: 'deepseek-chat 启用', exact: true }).click()
    await expect.poll(() => savedEnabled(userDataDir, 'DeepSeek', 'deepseek-chat')).toBe(false)
    expect(savedIcon(userDataDir, 'DeepSeek')).toBeNull()
    await expect(brandTitles(card).first()).toHaveText('DeepSeek')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
