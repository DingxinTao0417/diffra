import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { GOOD_KEY, startMockProvider } from '../../core/test/mock-provider'
import { launchApp, makeUserDataDir } from './launch'
import { openModelsPage, providerCard } from './model-setup'
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
    await window.getByRole('button', { name: '+ 添加模型', exact: true }).click()
    const dialog = window.getByRole('dialog')
    await dialog.getByLabel('名称').fill('本地测试')
    await dialog.getByLabel('地址').fill(`${mock.baseUrl}/openai/v1`)
    await dialog.getByLabel('API Key', { exact: true }).fill(WRONG_KEY)
    await dialog.getByRole('textbox', { name: 'Model ID 1', exact: true }).fill('mock-a')
    await dialog.getByRole('button', { name: '下一步', exact: true }).click()
    await dialog.getByLabel('上下文长度', { exact: true }).fill('128000')
    await dialog.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('密钥无效')
    await expect(dialog.getByRole('alert')).not.toContainText(WRONG_KEY)
    // 校验失败不落盘，返回连接步骤修正；能力草稿保留。
    await dialog.getByRole('button', { name: '返回', exact: true }).click()
    await dialog.getByLabel('API Key', { exact: true }).fill(GOOD_KEY)
    await dialog.getByRole('button', { name: '下一步', exact: true }).click()
    await expect(dialog.getByLabel('上下文长度', { exact: true })).toHaveValue('128000')
    await dialog.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(dialog).toBeHidden()
    const card = providerCard(window, '本地测试')
    await expect(card.getByTestId('key-hint')).toHaveText('…1234')
    await card.getByRole('button', { name: '拉取模型列表' }).click()
    await expect(card.getByTestId('fetch-status')).toContainText('已拉取 2 个模型')

    // 添加模型并测试连接
    const row = card.getByTestId('model-row-mock-a')
    await expect(row).toContainText('上下文 128k')
    await row.getByRole('button', { name: 'mock-a 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '测试连接', exact: true }).click()
    await expect(row.getByTestId('test-result-mock-a')).toContainText('连接正常')
    await expect(row.getByTestId('test-result-mock-a')).toContainText('回复：OK')
    await expect(row.getByTestId('test-result-mock-a')).toContainText('工具调用：支持')

    // 分配编码角色
    const coder = window.getByRole('combobox', { name: '编码' })
    await coder.click()
    await window.getByRole('option', { name: '本地测试 / mock-a' }).click()
    await expect(coder).toContainText('本地测试 / mock-a')
    // 编辑连接时留空密钥沿用原值；能力草稿和新显示名称一并保存。
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('')
    await dialog.getByRole('button', { name: '下一步', exact: true }).click()
    await dialog.getByLabel('显示名称', { exact: true }).fill('本地编码模型')
    await dialog.getByRole('button', { name: '校验并添加模型', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(coder).toContainText('本地测试 / 本地编码模型')
    await expect(card.getByTestId('key-hint')).toHaveText('…1234')
    await row.getByRole('switch', { name: 'mock-a 启用', exact: true }).click()
    await expect(coder).toContainText('未选择')
    await row.getByRole('switch', { name: 'mock-a 启用', exact: true }).click()
    await coder.click()
    await window.getByRole('option', { name: '本地测试 / 本地编码模型', exact: true }).click()
    await window.screenshot({ path: 'test-results/model-settings.png', fullPage: true })
    await app.close()

    // 重启后配置还在
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await openModelsPage(window)
    const reopened = providerCard(window, '本地测试')
    await expect(reopened.getByTestId('model-row-mock-a')).toBeVisible()
    await expect(reopened.getByTestId('key-hint')).toHaveText('…1234')
    await expect(window.getByRole('combobox', { name: '编码' })).toContainText('本地测试 / 本地编码模型')

    // 清空显示名称后保存，模型行和角色选择回退到 Model ID，而不是空白。
    await reopened.getByTestId('model-row-mock-a').getByRole('button', { name: 'mock-a 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '配置能力', exact: true }).click()
    const nameDialog = window.getByRole('dialog')
    await nameDialog.getByLabel('显示名称', { exact: true }).fill('  ')
    await nameDialog.getByRole('button', { name: '保存模型能力', exact: true }).click()
    await expect(nameDialog).toBeHidden()
    await expect(window.getByRole('combobox', { name: '编码' })).toContainText('本地测试 / mock-a')
    await expect(reopened.getByTestId('model-row-mock-a').getByText('mock-a', { exact: true })).toBeVisible()

    // 移除模型后，指向它的角色被清空
    await reopened.getByTestId('model-row-mock-a').getByRole('button', { name: 'mock-a 模型操作', exact: true }).click()
    await window.getByRole('menuitem', { name: '移除模型', exact: true }).click()
    await expect(reopened.getByTestId('model-row-mock-a')).toBeHidden()
    await expect(window.getByRole('combobox', { name: '编码' })).toContainText('未选择')
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
