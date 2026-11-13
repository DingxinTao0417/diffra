import { expect, type Locator, type Page } from '@playwright/test'

// 从侧栏进设置的「模型与角色」；应用刚启动、停在首页或任务页时用
export async function openModelsPage(window: Page): Promise<void> {
  await window.getByTestId('sidebar').getByRole('button', { name: '设置' }).click()
  await window.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '模型与角色' }).click()
}

export function providerCard(window: Page, name: string) {
  return window.getByTestId('provider-card').filter({ hasText: name })
}

// 服务平时收成一行；点「编辑」展开，模型行、启用开关、配置能力、拉取模型列表都在展开的面板里
export async function expandProvider(window: Page, name: string): Promise<Locator> {
  const card = providerCard(window, name)
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(card.getByTestId('provider-panel')).toBeVisible()
  return card
}

// 展开服务，打开某个模型的「配置能力」，返回就地展开的编辑区（里面有「保存模型能力」）
export async function openModelCapabilities(window: Page, providerName: string, modelId: string): Promise<Locator> {
  const card = await expandProvider(window, providerName)
  await card.getByTestId(`model-row-${modelId}`).getByRole('button', { name: `${modelId} 模型操作`, exact: true }).click()
  await window.getByRole('menuitem', { name: '配置能力', exact: true }).click()
  return card.getByTestId('model-editor')
}

// 通过界面添加一个自定义 OpenAI 兼容供应商和模型，并分配给一个角色（默认编码）；做完回到设置之前的页面
export async function configureCoderModel(
  window: Page,
  options: { name: string; baseUrl: string; apiKey: string; modelId: string; role?: '编码' | '规划' | '备用' },
): Promise<void> {
  await openModelsPage(window)
  await window.getByRole('button', { name: '添加模型服务', exact: true }).click()
  const panel = window.getByTestId('provider-panel')
  await panel.getByRole('radio', { name: '自定义 API', exact: true }).click()
  await panel.getByLabel('名称', { exact: true }).fill(options.name)
  await panel.getByLabel('地址', { exact: true }).fill(options.baseUrl)
  await panel.getByLabel('API Key', { exact: true }).fill(options.apiKey)
  await panel.getByRole('textbox', { name: '模型 ID 1', exact: true }).fill(options.modelId)
  await panel.getByRole('button', { name: '校验并添加模型', exact: true }).click()
  // 校验要等 core 起来再调一次模型，CI 上 core 冷启动偶尔要十几秒，所以多等一会儿。
  // 面板收不起来时把里面的字（比如校验报错）带进报错：CI 不留截图，只看得到这里
  await expect(panel)
    .toBeHidden({ timeout: 30_000 })
    .catch(async (error: unknown) => {
      const text = await panel.innerText().catch(() => '（读不到）')
      throw new Error(`添加模型后面板没收起，里面写着：${text.replace(/\s+/g, ' ').slice(0, 500)}`, { cause: error })
    })

  await expect(providerCard(window, options.name)).toContainText('1 个模型')

  const role = window.getByRole('combobox', { name: options.role ?? '编码' })
  await role.click()
  await window.getByRole('group', { name: options.name, exact: true }).getByRole('option', { name: options.modelId, exact: true }).click()
  await expect(role).toContainText(`${options.name} / ${options.modelId}`)
  await window.getByRole('button', { name: '返回' }).click()
}
