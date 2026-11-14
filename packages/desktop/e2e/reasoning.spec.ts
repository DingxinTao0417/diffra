import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { GOOD_KEY, startMockProvider } from '../../core/test/mock-provider'
import { APP_VERSION, launchApp, makeUserDataDir } from './launch'
import { startTask } from './flows'
import { configureCoderModel, expandProvider, openModelCapabilities, openModelsPage } from './model-setup'
import { reasoningEffortsFor } from '../src/shared/reasoning'

test('已知型号、未知别名、自定义档位及不支持协议的能力列表', () => {
  const model = { id: 'gpt-5', images: false, contextWindow: null }
  const provider = { protocol: 'openai-compatible' as const }
  expect(reasoningEffortsFor(provider, model)).toEqual(['default', 'low', 'medium', 'high'])
  expect(reasoningEffortsFor(provider, { ...model, id: 'gpt-5.2' })).toEqual(['default', 'low', 'medium', 'high', 'xhigh'])
  expect(reasoningEffortsFor(provider, { ...model, id: 'o3-mini-2025-01-31' })).toEqual(['default', 'low', 'medium', 'high'])
  expect(reasoningEffortsFor(provider, { ...model, id: 'unknown' })).toEqual(['default'])
  expect(reasoningEffortsFor(provider, { ...model, reasoningEfforts: [] })).toEqual(['default'])
  expect(reasoningEffortsFor(provider, { ...model, reasoningEfforts: ['xhigh', 'low', 'low'] })).toEqual(['default', 'low', 'xhigh'])
  // 各协议都是 low 到 max 五档；旧设置里存的 none、minimal 不再列出
  expect(reasoningEffortsFor(provider, { ...model, reasoningEfforts: ['minimal', 'none', 'max'] })).toEqual(['default', 'max'])
  expect(reasoningEffortsFor({ protocol: 'gemini' }, model)).toEqual(['default'])
  expect(reasoningEffortsFor({ protocol: 'gemini' }, { ...model, reasoningEfforts: ['low'] })).toEqual(['default'])
  // Anthropic 系不按型号猜，用户勾了才有
  const claude = { ...model, id: 'claude-sonnet-5-5' }
  expect(reasoningEffortsFor({ protocol: 'anthropic' }, claude)).toEqual(['default'])
  expect(reasoningEffortsFor({ protocol: 'anthropic-compatible' }, { ...claude, reasoningEfforts: ['max', 'none', 'low'] })).toEqual(['default', 'low', 'max'])
})

// Anthropic 系协议也能勾思考模式；输入框选的档位按 output_config.effort 发出去
test('Anthropic 兼容接口：模型能力里勾思考强度，输入框选 max，请求带上 effort', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const mock = await startMockProvider()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await openModelsPage(window)
    await window.getByRole('button', { name: '添加模型服务', exact: true }).click()
    const panel = window.getByTestId('provider-panel')
    await panel.getByRole('radio', { name: '自定义 API', exact: true }).click()
    await panel.getByLabel('名称', { exact: true }).fill('Claude 兼容')
    await panel.getByLabel('API 类型', { exact: true }).click()
    await window.getByRole('option', { name: 'Anthropic 兼容', exact: true }).click()
    await panel.getByLabel('API Key', { exact: true }).fill(GOOD_KEY)
    await panel.getByLabel('地址', { exact: true }).fill(`${mock.baseUrl}/anthropic`)
    await panel.getByRole('textbox', { name: '模型 ID 1', exact: true }).fill('claude-mock')
    await panel.getByRole('button', { name: '模型 ID 1 的能力', exact: true }).click()

    const capabilities = panel.getByTestId('capabilities-0')
    const reasoning = capabilities.getByRole('checkbox', { name: '思考模式', exact: true })
    await expect(reasoning).toBeEnabled()
    await expect(reasoning).not.toBeChecked()
    await expect(capabilities).toContainText('不勾时不指定，按服务商的默认强度思考')
    await reasoning.click()
    const levels = capabilities.getByRole('group', { name: '思考强度' })
    await expect(levels.locator('label')).toHaveText(['low', 'medium', 'high', 'xhigh', 'max'])
    await expect(levels.getByRole('checkbox', { checked: true })).toHaveCount(3)
    await expect(levels.getByRole('button', { name: '恢复自动识别' })).toHaveCount(0)
    await levels.getByRole('checkbox', { name: 'max', exact: true }).click()
    await panel.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(panel).toBeHidden({ timeout: 30_000 })

    const role = window.getByRole('combobox', { name: '编码' })
    await role.click()
    await window.getByRole('group', { name: 'Claude 兼容', exact: true }).getByRole('option', { name: 'claude-mock', exact: true }).click()
    await window.getByRole('button', { name: '返回' }).click()

    await window.getByTestId('model-menu').click()
    await window.getByRole('menuitem', { name: /^推理等级/ }).click()
    await expect(window.getByTestId('reasoning-list').getByRole('menuitem')).toHaveText(['default', 'low', 'medium', 'high', 'max'])
    await window.getByTestId('reasoning-list').getByRole('menuitem', { name: 'max', exact: true }).click()
    await expect(window.getByTestId('model-menu')).toHaveAttribute('aria-label', /思考程度 max$/)

    // 只看发出去的请求：mock 对带工具的流式请求不回流，任务本身会出错
    await startTask(window, '你好')
    const efforts = () =>
      mock.requests
        .filter((item) => item.method === 'POST' && item.path === '/anthropic/v1/messages')
        .map((item) => (JSON.parse(item.body ?? '{}') as { output_config?: { effort?: string } }).output_config?.effort)
    await expect.poll(efforts, { timeout: 30_000 }).toContain('max')
  } finally {
    await app.close()
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

// 第 531、532 步：两级菜单里选「模型」「推理等级」；每个模型选过的档位记进设置，换回这个模型、重启后都还是它
test('推理等级：两级菜单里选档位，按模型记住，换模型、重启后还在；档位随模型能力变', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const mock = await startMockProvider()
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '思考模型', baseUrl: `${mock.baseUrl}/openai/v1`, apiKey: GOOD_KEY, modelId: 'o3-mini' })
    const trigger = () => window.getByTestId('model-menu')
    const efforts = () => window.getByTestId('reasoning-list').getByRole('menuitem')
    const pickEffort = async (name: string) => {
      await trigger().click()
      await window.getByRole('menuitem', { name: /^推理等级/ }).click()
      await window.getByTestId('reasoning-list').getByRole('menuitem', { name, exact: true }).click()
      await expect(window.getByRole('menu')).toHaveCount(0)
    }
    const pickModel = async (id: string) => {
      await trigger().click()
      await window.getByRole('menuitem', { name: /^模型/ }).click()
      await window.getByTestId('model-list').getByRole('menuitem').filter({ hasText: id }).click()
      await expect(window.getByRole('menu')).toHaveCount(0)
    }
    const savedChoices = () => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).reasoningChoices as Record<string, string>

    // 第一级两行：模型、推理等级；推理等级展开是档位列表
    await trigger().click()
    await expect(window.getByRole('menuitem', { name: /^模型/ })).toContainText('o3-mini')
    await expect(window.getByRole('menuitem', { name: /^推理等级/ })).toContainText('default')
    await window.getByRole('menuitem', { name: /^推理等级/ }).click()
    await expect(efforts()).toHaveText(['default', 'low', 'medium', 'high'])
    await window.keyboard.press('Escape')
    await expect(window.getByRole('menu')).toHaveCount(0)
    await pickEffort('high')
    await expect(window.getByTestId('reasoning-label')).toHaveText('high')
    await expect(trigger()).toHaveAttribute('aria-label', /思考程度 high$/)
    await expect.poll(() => Object.entries(savedChoices()).filter(([key]) => key.endsWith('/o3-mini')).map(([, value]) => value)).toEqual(['high'])

    // 加一个能力不同的模型：换过去是它自己的档位（没选过就是默认），换回来还是 high
    await openModelsPage(window)
    const card = await expandProvider(window, '思考模型')
    await card.getByRole('button', { name: '添加模型', exact: true }).click()
    const newModel = card.getByTestId('model-editor')
    await newModel.getByLabel('模型 ID', { exact: true }).fill('gpt-5.2')
    await newModel.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(newModel).toBeHidden()
    await expect(card.getByTestId('model-row-gpt-5.2')).toBeVisible()
    await window.getByRole('button', { name: '返回', exact: true }).click()
    await pickModel('gpt-5.2')
    await expect(trigger()).toHaveAttribute('aria-label', /思考程度 default$/)
    await pickEffort('xhigh')
    await pickModel('o3-mini')
    await expect(trigger()).toHaveAttribute('aria-label', /思考程度 high$/)

    // 重启：首页的模型还是 high
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await expect(trigger()).toHaveAttribute('aria-label', /o3-mini，思考程度 high$/)

    // 能力里去掉 xhigh：换到 gpt-5.2 时记住的 xhigh 不能用了，按默认
    await openModelsPage(window)
    const capabilities = await openModelCapabilities(window, '思考模型', 'gpt-5.2')
    await capabilities.getByRole('checkbox', { name: 'xhigh', exact: true }).click()
    await capabilities.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(capabilities).toBeHidden()
    await window.getByRole('button', { name: '返回', exact: true }).click()
    await pickModel('gpt-5.2')
    await expect(trigger()).toHaveAttribute('aria-label', /思考程度 default$/)
    await trigger().click()
    await window.getByRole('menuitem', { name: /^推理等级/ }).click()
    await expect(efforts()).toHaveCount(4)
  } finally {
    await app.close()
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('模型多于 8 个时模型列表上方有搜索框，按名称或服务商筛选', async () => {
  const userDataDir = makeUserDataDir()
  const models = Array.from({ length: 9 }, (_, index) => ({ id: `model-${index + 1}`, contextWindow: 128_000, images: false }))
  const providers = [{ id: 'many', presetId: null, icon: null, name: '很多模型', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', models }]
  const roles = { coder: { providerId: 'many', modelId: 'model-1' }, planner: null, reviewer: null, fallback: null }
  // 记成已经看过这个版本：配了模型的设置文件会被当成老用户升级，弹「已更新」提示
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, providers, roles, lastSeenVersion: APP_VERSION }))
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.getByTestId('model-menu').click()
    await window.getByRole('menuitem', { name: /^模型/ }).click()
    const search = window.getByLabel('搜索模型')
    await expect(window.getByRole('menuitem').filter({ hasText: /^model-/ })).toHaveCount(9)
    await search.fill('7')
    await expect(window.getByRole('menuitem').filter({ hasText: /^model-/ })).toHaveCount(1)
    await search.fill('不存在')
    await expect(window.getByText('没有匹配的模型')).toBeVisible()
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
