import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { GOOD_KEY, startMockProvider } from '../../core/test/mock-provider'
import { launchApp, makeUserDataDir } from './launch'
import { openModelsPage, providerCard } from './model-setup'

const WRONG_KEY = 'wrong-key-0000-abcd'


test('添加供应商、拉模型、测试连接、分配角色，重启后保留，密钥不落明文', async () => {
  const userDataDir = makeUserDataDir()
  const mock = await startMockProvider()
  try {
    let app = await launchApp(userDataDir)
    let window = await app.firstWindow()
    await openModelsPage(window)

    // 添加自定义供应商，先故意填错密钥
    await window.getByRole('button', { name: '添加供应商' }).click()
    const dialog = window.getByRole('dialog')
    await dialog.getByRole('combobox', { name: '类型' }).click()
    await window.getByRole('option', { name: '自定义' }).click()
    await dialog.getByLabel('名称').fill('本地测试')
    await dialog.getByLabel('地址').fill(`${mock.baseUrl}/openai/v1`)
    await dialog.getByLabel('API Key').fill(WRONG_KEY)
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()

    const card = providerCard(window, '本地测试')
    await expect(card.getByTestId('key-hint')).toHaveText('…abcd')
    await card.getByRole('button', { name: '拉取模型列表' }).click()
    await expect(card.getByTestId('fetch-status')).toContainText('密钥无效')
    await expect(card.getByTestId('fetch-status')).not.toContainText(WRONG_KEY)

    // 改成正确的密钥后再拉
    await card.getByRole('button', { name: '编辑' }).click()
    await dialog.getByLabel('API Key').fill(GOOD_KEY)
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()
    await expect(card.getByTestId('key-hint')).toHaveText('…1234')
    await card.getByRole('button', { name: '拉取模型列表' }).click()
    await expect(card.getByTestId('fetch-status')).toContainText('已拉取 2 个模型')

    // 添加模型并测试连接
    await card.getByLabel('模型 ID').fill('mock-a')
    await card.getByLabel('上下文长度').fill('128000')
    await card.getByRole('button', { name: '添加模型' }).click()
    const row = card.getByTestId('model-row-mock-a')
    await expect(row).toContainText('上下文 128k')
    await row.getByRole('button', { name: '测试' }).click()
    await expect(row.getByTestId('test-result-mock-a')).toContainText('连接正常')
    await expect(row.getByTestId('test-result-mock-a')).toContainText('回复：OK')
    await expect(row.getByTestId('test-result-mock-a')).toContainText('工具调用：支持')

    // 分配编码角色
    const coder = window.getByRole('combobox', { name: '编码' })
    await coder.click()
    await window.getByRole('option', { name: '本地测试 / mock-a' }).click()
    await expect(coder).toContainText('本地测试 / mock-a')
    await window.screenshot({ path: 'test-results/model-settings.png', fullPage: true })
    await app.close()

    // 重启后配置还在
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await openModelsPage(window)
    const reopened = providerCard(window, '本地测试')
    await expect(reopened.getByTestId('model-row-mock-a')).toBeVisible()
    await expect(reopened.getByTestId('key-hint')).toHaveText('…1234')
    await expect(window.getByRole('combobox', { name: '编码' })).toContainText('本地测试 / mock-a')

    // 移除模型后，指向它的角色被清空
    await reopened.getByTestId('model-row-mock-a').getByRole('button', { name: '移除' }).click()
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
    await mock.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
