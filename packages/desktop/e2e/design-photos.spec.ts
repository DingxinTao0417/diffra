import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, settingsNav, startDesignTask, taskInput, waitTaskDone } from './flows'
import { launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 设计任务里找图（v2 · M11）：设置里填 Pexels 的 Key（只进 SecretStore），设计任务里智能体搜图，对话里显示缩略图
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const KEY = 'e2e-pexels-key-4242'

test('设计找图：设置里填图库 Key 后，设计任务里搜到的图在对话里显示缩略图和摄影师；Key 不写进设置文件', async () => {
  test.setTimeout(120_000)
  let authorized = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/v1/search') {
      if (request.headers.authorization !== KEY) {
        response.writeHead(401).end()
        return
      }
      authorized++
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          photos: [1, 2].map((id) => ({ id, width: 1600, height: 900, alt: `Cafe ${id}`, photographer: `Photographer ${id}`, photographer_url: `https://www.pexels.com/@p${id}`, url: `https://www.pexels.com/photo/${id}/`, src: { large: `${base}/large/${id}.png`, tiny: `${base}/tiny/${id}.png` } })),
        }),
      )
      return
    }
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(PNG)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-design-photos-'))
  const model = await startScriptedModel([
    { text: '好的' },
    { toolCalls: [{ name: 'design_find_photos', input: { query: 'cozy cafe', count: 2 } }] },
    { text: '找到两张咖啡馆的图' },
  ])
  const app = await launchApp(userDataDir, { DIFFRA_PEXELS_URL: `http://127.0.0.1:${port}` })
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })

    // 设置 → 设计：填 Pexels 的 Key
    await window.getByTestId('sidebar').getByRole('button', { name: '设置', exact: true }).click()
    await settingsNav(window).getByRole('button', { name: '设计' }).click()
    const keys = window.getByTestId('stock-keys')
    await keys.getByLabel('Pexels 的 Key').fill(KEY)
    await keys.getByRole('button', { name: '保存' }).first().click()
    await expect(keys).toContainText('已填：')
    await expect(keys).not.toContainText(KEY)
    expect(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).not.toContain(KEY)
    for (const name of readdirSync(userDataDir)) if (name.endsWith('.json')) expect(readFileSync(join(userDataDir, name), 'utf8')).not.toContain(KEY)
    await window.getByRole('button', { name: '返回' }).click()

    await chooseProject(app, window, project)
    await startDesignTask(window, '打开设计面板')
    await waitTaskDone(window)
    await expect(window.getByTestId('design-panel')).toBeVisible()
    await taskInput(window).fill('找两张咖啡馆的图')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await waitTaskDone(window, 60_000)

    const card = window.getByTestId('photos-card')
    await expect(card).toContainText('找图 cozy cafe')
    const thumbs = card.getByTestId('photo-thumb')
    await expect(thumbs).toHaveCount(2)
    await expect(thumbs.first()).toContainText('Photographer 1 · Pexels')
    expect(await thumbs.first().locator('img').getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(authorized).toBe(1)
    // 模型拿到的是大图地址和摄影师，没有缩略图
    const bodies = model.bodies().join('\n')
    expect(bodies).toContain(`url: http://127.0.0.1:${port}/large/1.png`)
    expect(bodies).not.toContain('data:image/png;base64')
    await window.screenshot({ path: 'test-results/design-photos.png' })
  } finally {
    await app.close()
    await model.close()
    server.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
