import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { GOOD_KEY, startMockProvider } from '../../core/test/mock-provider'
import { APP_VERSION, launchApp, makeUserDataDir } from './launch'
import { configureCoderModel, openModelsPage, providerCard } from './model-setup'
import { reasoningEffortsFor } from '../src/shared/reasoning'

test('已知型号、未知别名、自定义档位及不支持协议的能力列表', () => {
  const model = { id: 'gpt-5', images: false, contextWindow: null }
  const provider = { protocol: 'openai-compatible' as const }
  expect(reasoningEffortsFor(provider, model)).toEqual(['default', 'minimal', 'low', 'medium', 'high'])
  expect(reasoningEffortsFor(provider, { ...model, id: 'gpt-5.2' })).toEqual(['default', 'none', 'low', 'medium', 'high', 'xhigh'])
  expect(reasoningEffortsFor(provider, { ...model, id: 'o3-mini-2025-01-31' })).toEqual(['default', 'low', 'medium', 'high'])
  expect(reasoningEffortsFor(provider, { ...model, id: 'unknown' })).toEqual(['default'])
  expect(reasoningEffortsFor(provider, { ...model, reasoningEfforts: [] })).toEqual(['default'])
  expect(reasoningEffortsFor(provider, { ...model, reasoningEfforts: ['xhigh', 'low', 'low'] })).toEqual(['default', 'low', 'xhigh'])
  expect(reasoningEffortsFor({ protocol: 'gemini' }, model)).toEqual(['default'])
})

// 第 531、532 步：两级菜单里选「模型」「推理等级」；每个模型选过的档位记进设置，换回这个模型、重启后都还是它
test('推理等级：两级菜单里选档位，按模型记住，换模型、重启后还在；档位随模型能力变', async () => {
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
    await expect(window.getByRole('menuitem', { name: /^推理等级/ })).toContainText('默认')
    await window.getByRole('menuitem', { name: /^推理等级/ }).click()
    await expect(efforts()).toHaveText(['默认', '低', '中', '高'])
    await window.keyboard.press('Escape')
    await pickEffort('高')
    await expect(window.getByTestId('reasoning-label')).toHaveText('高')
    await expect(trigger()).toHaveAttribute('aria-label', /思考程度高/)
    await expect.poll(() => Object.entries(savedChoices()).filter(([key]) => key.endsWith('/o3-mini')).map(([, value]) => value)).toEqual(['high'])

    // 加一个能力不同的模型：换过去是它自己的档位（没选过就是默认），换回来还是「高」
    await openModelsPage(window)
    const card = () => providerCard(window, '思考模型')
    await card().getByRole('button', { name: '添加模型', exact: true }).click()
    const capabilityDialog = window.getByRole('dialog')
    await capabilityDialog.getByLabel('模型 ID', { exact: true }).fill('gpt-5.2')
    await capabilityDialog.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(capabilityDialog).toBeHidden()
    await window.getByRole('button', { name: '返回', exact: true }).click()
    await pickModel('gpt-5.2')
    await expect(trigger()).toHaveAttribute('aria-label', /思考程度默认/)
    await pickEffort('极高')
    await pickModel('o3-mini')
    await expect(trigger()).toHaveAttribute('aria-label', /思考程度高/)

    // 重启：首页的模型还是「高」
    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await expect(trigger()).toHaveAttribute('aria-label', /o3-mini，思考程度高/)

    // 能力里去掉极高：换到 gpt-5.2 时记住的极高不能用了，按默认
    await openModelsPage(window)
    await card().getByTestId('model-row-gpt-5.2').getByRole('button', { name: 'gpt-5.2 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '配置能力', exact: true }).click()
    await window.getByRole('dialog').getByRole('checkbox', { name: '极高', exact: true }).click()
    await window.getByRole('dialog').getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(window.getByRole('dialog')).toBeHidden()
    await window.getByRole('button', { name: '返回', exact: true }).click()
    await pickModel('gpt-5.2')
    await expect(trigger()).toHaveAttribute('aria-label', /思考程度默认/)
    await trigger().click()
    await window.getByRole('menuitem', { name: /^推理等级/ }).click()
    await expect(efforts()).toHaveCount(5)
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
