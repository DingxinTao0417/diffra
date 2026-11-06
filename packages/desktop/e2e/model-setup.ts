import { expect, type Page } from '@playwright/test'

export async function openModelsPage(window: Page): Promise<void> {
  await window.getByRole('navigation').getByRole('button', { name: '模型' }).click()
}

export function providerCard(window: Page, name: string) {
  return window.getByTestId('provider-card').filter({ hasText: name })
}

// 通过界面添加一个自定义 OpenAI 兼容供应商和模型，并分配给编码角色
export async function configureCoderModel(
  window: Page,
  options: { name: string; baseUrl: string; apiKey: string; modelId: string },
): Promise<void> {
  await openModelsPage(window)
  await window.getByRole('button', { name: '添加供应商' }).click()
  const dialog = window.getByRole('dialog')
  await dialog.getByRole('combobox', { name: '类型' }).click()
  await window.getByRole('option', { name: '自定义' }).click()
  await dialog.getByLabel('名称').fill(options.name)
  await dialog.getByLabel('地址').fill(options.baseUrl)
  await dialog.getByLabel('API Key').fill(options.apiKey)
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog).toBeHidden()

  const card = providerCard(window, options.name)
  await card.getByLabel('模型 ID').fill(options.modelId)
  await card.getByRole('button', { name: '添加模型' }).click()
  await expect(card.getByTestId(`model-row-${options.modelId}`)).toBeVisible()

  const coder = window.getByRole('combobox', { name: '编码' })
  await coder.click()
  await window.getByRole('option', { name: `${options.name} / ${options.modelId}` }).click()
  await expect(coder).toContainText(`${options.name} / ${options.modelId}`)
}
