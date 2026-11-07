import { expect, type Page } from '@playwright/test'

// 从侧栏进设置的「模型与角色」；应用刚启动、停在首页或任务页时用
export async function openModelsPage(window: Page): Promise<void> {
  await window.getByTestId('sidebar').getByRole('button', { name: '设置' }).click()
  await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '模型与角色' }).click()
}

export function providerCard(window: Page, name: string) {
  return window.getByTestId('provider-card').filter({ hasText: name })
}

// 通过界面添加一个自定义 OpenAI 兼容供应商和模型，并分配给一个角色（默认编码）；做完回到设置之前的页面
export async function configureCoderModel(
  window: Page,
  options: { name: string; baseUrl: string; apiKey: string; modelId: string; role?: '编码' | '规划' | '兜底' },
): Promise<void> {
  await openModelsPage(window)
  await window.getByRole('button', { name: '+ 添加模型', exact: true }).click()
  const dialog = window.getByRole('dialog')
  await dialog.getByLabel('名称', { exact: true }).fill(options.name)
  await dialog.getByLabel('地址', { exact: true }).fill(options.baseUrl)
  await dialog.getByLabel('API Key', { exact: true }).fill(options.apiKey)
  await dialog.getByRole('textbox', { name: 'Model ID 1', exact: true }).fill(options.modelId)
  await dialog.getByRole('button', { name: '下一步', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: '配置模型能力', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '校验并添加模型', exact: true }).click()
  await expect(dialog).toBeHidden()

  const card = providerCard(window, options.name)
  await expect(card.getByTestId(`model-row-${options.modelId}`)).toBeVisible()

  const role = window.getByRole('combobox', { name: options.role ?? '编码' })
  await role.click()
  await window.getByRole('option', { name: `${options.name} / ${options.modelId}` }).click()
  await expect(role).toContainText(`${options.name} / ${options.modelId}`)
  await window.getByRole('button', { name: '返回' }).click()
}
