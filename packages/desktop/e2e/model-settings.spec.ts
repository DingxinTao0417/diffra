import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { GOOD_KEY, startMockProvider } from '../../core/test/mock-provider'
import { launchApp, makeUserDataDir } from './launch'
import { expandProvider, openModelCapabilities, openModelsPage, providerCard } from './model-setup'
import { modelDisplayName } from '../src/shared/settings'

test('显示名称缺省、空字符串或空白时回退 Model ID，自定义名称去掉首尾空白', () => {
  expect(modelDisplayName({ id: 'mock-a' })).toBe('mock-a')
  expect(modelDisplayName({ id: 'mock-a', displayName: '' })).toBe('mock-a')
  expect(modelDisplayName({ id: 'mock-a', displayName: '  \t' })).toBe('mock-a')
  expect(modelDisplayName({ id: 'mock-a', displayName: '  本地编码模型  ' })).toBe('本地编码模型')
})

const WRONG_KEY = 'wrong-key-0000-abcd'


test('添加供应商、拉模型、测试连接、分配角色，重启后保留，密钥不落明文', async () => {
  const userDataDir = makeUserDataDir()
  const mock = await startMockProvider()
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await openModelsPage(window)

    // 添加自定义供应商，先故意填错密钥
    await window.getByRole('button', { name: '添加模型服务', exact: true }).click()
    const panel = window.getByTestId('provider-panel')
    await panel.getByRole('radio', { name: '自定义 API', exact: true }).click()
    await panel.getByLabel('名称', { exact: true }).fill('本地测试')
    await panel.getByLabel('地址', { exact: true }).fill(`${mock.baseUrl}/openai/v1`)
    await panel.getByLabel('API Key', { exact: true }).fill(WRONG_KEY)
    await panel.getByRole('textbox', { name: '模型 ID 1', exact: true }).fill('mock-a')
    // 能力在模型那一行上点开
    await panel.getByRole('button', { name: '模型 ID 1 的能力', exact: true }).click()
    await panel.getByRole('radio', { name: '128k', exact: true }).click()
    const maxOutput = panel.getByRole('radiogroup', { name: '最大输出', exact: true })
    await maxOutput.getByRole('radio', { name: '16k', exact: true }).click()
    await panel.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('密钥无效')
    await expect(panel.getByRole('alert')).not.toContainText(WRONG_KEY)
    // 校验失败不落盘，面板还在，改了密钥直接再试；能力草稿保留。
    await panel.getByLabel('API Key', { exact: true }).fill(GOOD_KEY)
    await expect(panel.getByRole('radio', { name: '128k', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(maxOutput.getByRole('radio', { name: '16k', exact: true })).toHaveAttribute('aria-checked', 'true')
    await panel.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(panel).toBeHidden()
    const savedMaxOutput = () => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).providers[0].models[0].maxOutputTokens
    await expect.poll(savedMaxOutput).toBe(16_000)
    // 服务平时收成一行，密钥尾号写在这一行上；模型都在展开后的面板里
    const card = providerCard(window, '本地测试')
    await expect(card.getByTestId('key-hint')).toHaveText('…1234')
    await expect(card.getByTestId('model-row-mock-a')).toHaveCount(0)
    await expandProvider(window, '本地测试')
    await card.getByRole('button', { name: '拉取模型列表' }).click()
    // 拉取结果在弹层里（挂在 body 下），已添加的 mock-a 打勾不可选
    await expect(window.getByTestId('fetch-status')).toContainText('已拉取 2 个模型')
    await expect(window.getByRole('button', { name: 'mock-a 已添加', exact: true })).toBeDisabled()
    // 挑一个没加过的：面板里就地出现添加模型的表单，ID 已填好，校验通过后加进服务
    await window.getByRole('button', { name: 'mock-b', exact: true }).click()
    await expect(window.getByTestId('fetch-status')).toBeHidden()
    const picked = card.getByTestId('model-editor')
    await expect(picked.getByLabel('模型 ID', { exact: true })).toHaveValue('mock-b')
    await picked.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(picked).toBeHidden()
    await expect(card.getByTestId('model-row-mock-b')).toBeVisible()
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).providers[0].models.map((model: { id: string }) => model.id)).toEqual(['mock-a', 'mock-b'])
    // 没有角色用它，移除不用确认
    await card.getByTestId('model-row-mock-b').getByRole('button', { name: 'mock-b 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '移除模型', exact: true }).click()
    await expect(card.getByTestId('model-row-mock-b')).toBeHidden()

    // 添加模型并测试连接
    const row = card.getByTestId('model-row-mock-a')
    await expect(row.getByTestId('context-window-mock-a')).toHaveText('128k')
    await row.getByRole('button', { name: 'mock-a 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '测试连接', exact: true }).click()
    await expect(row.getByTestId('test-result-mock-a')).toContainText('连接正常')
    // 回复和工具调用详情放在状态的 Tooltip 里
    await row.getByTestId('test-result-mock-a').hover()
    await expect(window.getByRole('tooltip')).toContainText('回复：OK')
    await expect(window.getByRole('tooltip')).toContainText('工具调用：支持')

    // 分配编码角色
    const coder = window.getByRole('combobox', { name: '编码' })
    await coder.click()
    await window.getByRole('group', { name: '本地测试', exact: true }).getByRole('option', { name: 'mock-a', exact: true }).click()
    await expect(coder).toContainText('本地测试 / mock-a')
    // 编辑连接时留空密钥沿用原值；保存后面板收起
    const connection = card.getByTestId('provider-panel')
    await expect(connection.getByLabel('API Key', { exact: true })).toHaveValue('')
    await connection.getByRole('button', { name: '校验并保存', exact: true }).click()
    await expect(connection).toBeHidden()
    await expect(card.getByTestId('key-hint')).toHaveText('…1234')
    // 显示名称在模型的「配置能力」里改，保存后立即生效
    const rename = await openModelCapabilities(window, '本地测试', 'mock-a')
    await rename.getByLabel('显示名称', { exact: true }).fill('本地编码模型')
    await rename.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(rename).toBeHidden()
    await expect(coder).toContainText('本地测试 / 本地编码模型')
    await expect(row.getByText('编码', { exact: true })).toBeVisible()
    // 关闭正被角色使用的模型要先确认
    await row.getByRole('switch', { name: 'mock-a 启用', exact: true }).click()
    const confirm = window.getByRole('alertdialog')
    await expect(confirm).toContainText('编码角色会被清空')
    await confirm.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(coder).toContainText('未选择')
    await row.getByRole('switch', { name: 'mock-a 启用', exact: true }).click()
    await coder.click()
    await window.getByRole('group', { name: '本地测试', exact: true }).getByRole('option', { name: '本地编码模型', exact: true }).click()
    await expect(window.getByRole('status').filter({ hasText: '已保存' })).toHaveText('已保存，新任务生效')
    await window.screenshot({ path: 'test-results/model-settings.png', fullPage: true })
    await app.close()

    // 重启后配置还在
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await openModelsPage(window)
    const reopened = await expandProvider(window, '本地测试')
    await expect(reopened.getByTestId('model-row-mock-a')).toBeVisible()
    await expect(reopened.getByTestId('key-hint')).toHaveText('…1234')
    await expect(window.getByRole('combobox', { name: '编码' })).toContainText('本地测试 / 本地编码模型')

    // 清空显示名称后保存，模型行和角色选择回退到 Model ID，而不是空白。
    await reopened.getByTestId('model-row-mock-a').getByRole('button', { name: 'mock-a 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '配置能力', exact: true }).click()
    const nameDialog = reopened.getByTestId('model-editor')
    // 重启后最大输出还是 16k；改成自定义的值
    const reopenedMaxOutput = nameDialog.getByRole('radiogroup', { name: '最大输出', exact: true })
    await expect(reopenedMaxOutput.getByRole('radio', { name: '16k', exact: true })).toHaveAttribute('aria-checked', 'true')
    await reopenedMaxOutput.getByRole('radio', { name: '自定义', exact: true }).click()
    await nameDialog.getByLabel('自定义最大输出', { exact: true }).fill('12000')
    await nameDialog.getByLabel('显示名称', { exact: true }).fill('  ')
    await nameDialog.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(nameDialog).toBeHidden()
    await expect.poll(savedMaxOutput).toBe(12_000)
    await expect(window.getByRole('combobox', { name: '编码' })).toContainText('本地测试 / mock-a')
    await expect(reopened.getByTestId('model-row-mock-a').getByText('mock-a', { exact: true })).toBeVisible()

    // 移除模型后，指向它的角色被清空
    await reopened.getByTestId('model-row-mock-a').getByRole('button', { name: 'mock-a 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '移除模型', exact: true }).click()
    await window.getByRole('alertdialog').getByRole('button', { name: '移除', exact: true }).click()
    await expect(reopened.getByTestId('model-row-mock-a')).toBeHidden()
    // 没有模型时不显示角色分配；存下来的编码角色也清空了
    await expect(window.getByRole('combobox', { name: '编码' })).toHaveCount(0)
    await expect(window.getByText('添加模型后可以在这里分配角色')).toBeVisible()
    await expect.poll(() => JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).roles.coder).toBeNull()
    await app.close()

    // 两个文件里都没有密钥明文
    for (const file of ['settings.json', 'secrets.json']) {
      const content = readFileSync(join(userDataDir, file), 'utf8')
      expect(content).not.toContain(GOOD_KEY)
      expect(content).not.toContain(WRONG_KEY)
    }
  } finally {
    await app.close()
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('添加模型时工具调用探测：默认先思考的模型能加上；不调工具的模型说明原因', async () => {
  const userDataDir = makeUserDataDir()
  const mock = await startMockProvider()
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await openModelsPage(window)
    const add = async (modelId: string) => {
      await window.getByRole('button', { name: '添加模型服务', exact: true }).click()
      const panel = window.getByTestId('provider-panel')
      await panel.getByRole('radio', { name: '自定义 API', exact: true }).click()
      await panel.getByLabel('名称', { exact: true }).fill(`服务 ${modelId}`)
      await panel.getByLabel('地址', { exact: true }).fill(`${mock.baseUrl}/openai/v1`)
      await panel.getByLabel('API Key', { exact: true }).fill(GOOD_KEY)
      await panel.getByRole('textbox', { name: '模型 ID 1', exact: true }).fill(modelId)
      await panel.getByRole('button', { name: '校验并添加模型', exact: true }).click()
      return panel
    }

    const thinking = await add('mock-thinking')
    await expect(thinking).toBeHidden()
    const card = await expandProvider(window, '服务 mock-thinking')
    await expect(card.getByTestId('model-row-mock-thinking')).toBeVisible()

    // 没改过的编辑面板，点「添加模型服务」直接切过去
    const noTools = await add('mock-no-tools')
    await expect(noTools).toContainText('mock-no-tools 不支持工具调用，暂时无法用于编程任务（模型没有按要求调用工具）')

    // 同一时间只展开一个面板；面板里填过东西，切到别的面板先问
    await expect(window.getByTestId('provider-panel')).toHaveCount(1)
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    const confirm = window.getByRole('alertdialog')
    await expect(confirm).toContainText('放弃没保存的改动？')
    await confirm.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(noTools.getByLabel('名称', { exact: true })).toHaveValue('服务 mock-no-tools')
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    await window.getByRole('alertdialog').getByRole('button', { name: '放弃', exact: true }).click()
    await expect(window.getByTestId('provider-panel')).toHaveCount(1)
    await expect(card.getByTestId('provider-panel')).toBeVisible()
  } finally {
    await app.close()
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
