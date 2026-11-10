import { rmSync, writeFileSync } from 'node:fs'
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

test('思考阶梯：点柱子或用方向键调强度，重新打开后保留；模型和强度在同一个面板里，档位随模型能力变', async () => {
  const userDataDir = makeUserDataDir()
  const mock = await startMockProvider()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '思考模型', baseUrl: `${mock.baseUrl}/openai/v1`, apiKey: GOOD_KEY, modelId: 'o3-mini' })
    const trigger = window.getByTestId('model-menu')
    const ladder = window.getByRole('radiogroup', { name: '思考强度' })
    const level = (name: string) => ladder.getByRole('radio', { name, exact: true })
    await trigger.click()
    await expect(ladder.getByRole('radio')).toHaveCount(4)
    await expect(level('默认')).toHaveAttribute('aria-checked', 'true')
    // 方向键：End 到最高一档，大字跟着变；输入框按钮上的小阶梯也跟着亮
    await level('默认').focus()
    await window.keyboard.press('End')
    await expect(level('高')).toHaveAttribute('aria-checked', 'true')
    await expect(window.getByTestId('reasoning-label')).toHaveText('高')
    await expect(trigger).toHaveAttribute('aria-label', /思考强度高/)
    await window.keyboard.press('Escape')
    await expect(ladder).toBeHidden()
    await trigger.click()
    await expect(level('高')).toHaveAttribute('aria-checked', 'true')
    // 点柱子：直接到那一档
    await level('低').click()
    await expect(level('低')).toHaveAttribute('aria-checked', 'true')
    await window.keyboard.press('Escape')
    await openModelsPage(window)
    const card = providerCard(window, '思考模型')
    await card.getByRole('button', { name: '添加模型', exact: true }).click()
    const capabilityDialog = window.getByRole('dialog')
    await capabilityDialog.getByLabel('模型 ID', { exact: true }).fill('gpt-5.2')
    await capabilityDialog.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(capabilityDialog).toBeHidden()
    await expect(card.getByTestId('model-row-gpt-5.2')).toBeVisible()
    await window.getByRole('button', { name: '返回', exact: true }).click()
    // 同一个面板里直接换模型
    await trigger.click()
    await window.getByRole('menuitem').filter({ hasText: 'gpt-5.2' }).click()
    await expect(window.getByRole('menu')).toBeHidden()
    await trigger.click()
    await expect(ladder.getByRole('radio')).toHaveCount(6)
    await expect(level('默认')).toHaveAttribute('aria-checked', 'true')
    await level('极高').click()
    await expect(trigger).toHaveAttribute('aria-label', /思考强度极高/)
    // 第一根「默认」就是恢复默认，菜单不关
    await level('默认').click()
    await expect(level('默认')).toHaveAttribute('aria-checked', 'true')
    await level('极高').click()
    await window.keyboard.press('Escape')
    await expect(ladder).toBeHidden()
    await openModelsPage(window)
    const row = card.getByTestId('model-row-gpt-5.2')
    await row.getByRole('button', { name: 'gpt-5.2 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '配置能力', exact: true }).click()
    await capabilityDialog.getByRole('checkbox', { name: '极高', exact: true }).click()
    await expect(capabilityDialog.getByRole('checkbox', { name: '极高', exact: true })).not.toBeChecked()
    await capabilityDialog.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(capabilityDialog).toBeHidden()
    await window.getByRole('button', { name: '返回', exact: true }).click()
    await trigger.click()
    await window.getByRole('menuitem').filter({ hasText: 'o3-mini' }).click()
    await expect(window.getByRole('menu')).toBeHidden()
    await trigger.click()
    await window.getByRole('menuitem').filter({ hasText: 'gpt-5.2' }).click()
    await expect(window.getByRole('menu')).toBeHidden()
    await trigger.click()
    // 能力里去掉了极高：只剩 5 档，原来选的极高不在了，按默认
    await expect(ladder.getByRole('radio')).toHaveCount(5)
    await expect(level('默认')).toHaveAttribute('aria-checked', 'true')
  } finally {
    await app.close()
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('模型多于 8 个时面板上方有搜索框，按名称或服务商筛选', async () => {
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
