import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseProject, startTask, waitTaskDone } from './flows'
import { freeUdpPort, lanEnv, launchDevice, requestPairing } from './lan'
import { configureCoderModel } from './model-setup'
import { startScriptedModel } from './scripted-model'

// 两台设备上同一个仓库的检出：本地和远端都叫 diffra，路径不同、origin 相同。
// 配对后侧栏并成一个项目组，别的设备上的任务带设备图标
const ORIGIN = 'https://github.com/diffra-e2e/shared.git'

test('同一个仓库在两台设备上的项目并成一组：远程任务带设备图标，本机任务没有', async () => {
  test.setTimeout(240_000)
  const [hostPort, guestPort] = [await freeUdpPort(), await freeUdpPort()]
  const roots: string[] = []
  const makeProject = (prefix: string): string => {
    const root = mkdtempSync(join(tmpdir(), prefix))
    roots.push(root)
    const project = join(root, 'diffra')
    execFileSync('git', ['init', '-q', project])
    execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: project })
    writeFileSync(join(project, 'README.md'), '# diffra\n')
    return project
  }
  const hostProject = makeProject('diffra-e2e-merge-host-')
  const guestProject = makeProject('diffra-e2e-merge-guest-')
  const model = await startScriptedModel([{ text: '对方机器上的回答' }, { text: '本机的回答' }])
  const host = await launchDevice(lanEnv(hostPort, guestPort))
  const guest = await launchDevice(lanEnv(guestPort, hostPort))
  try {
    for (const device of [host, guest]) await configureCoderModel(device.window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await chooseProject(host.app, host.window, hostProject)
    await startTask(host.window, '对方机器上的任务')
    await waitTaskDone(host.window)
    await chooseProject(guest.app, guest.window, guestProject)
    await startTask(guest.window, '本机的任务')
    await waitTaskDone(guest.window)

    await requestPairing(host, guest, '主机')
    const request = host.window.getByTestId('pair-request')
    await request.getByRole('checkbox', { name: `开放 ${basename(hostProject)}` }).click()
    await request.getByRole('radio', { name: '可查看和操作' }).click()
    await request.getByRole('button', { name: '允许' }).click()

    await guest.window.getByRole('button', { name: '返回' }).click()
    const sidebar = guest.window.getByTestId('sidebar')
    // 同一个仓库、同一个相对路径：不再单独列成第二个 diffra
    await expect(sidebar.getByTestId('sidebar-remote-project')).toHaveCount(0, { timeout: 15_000 })
    await expect(sidebar.getByTestId('sidebar-project')).toHaveCount(1)
    const group = sidebar.getByTestId('sidebar-project').filter({ hasText: 'diffra' })
    const remoteRow = group.getByTestId('sidebar-remote-task').filter({ hasText: '对方机器上的任务' })
    await expect(remoteRow).toBeVisible({ timeout: 15_000 })
    // 远程任务的标题左边标出在哪台机器上；本机任务没有
    await expect(remoteRow.getByRole('img', { name: '在「主机」上' })).toBeVisible()
    const localRow = group.getByTestId('sidebar-task').filter({ hasText: '本机的任务' })
    await expect(localRow).toBeVisible()
    await expect(localRow.getByRole('img', { name: '在「主机」上' })).toHaveCount(0)
    // 合并后的项目标题上也能在对方那边新建任务
    await expect(group.getByTestId('sidebar-device-project-action')).toHaveAttribute('aria-label', '在 主机 的这个项目新建任务')
    await guest.window.screenshot({ path: 'test-results/merged-project.png' })
    // 远程任务照旧打开对方的任务页
    await remoteRow.getByRole('button', { name: '对方机器上的任务' }).click()
    await expect(guest.window.getByTestId('remote-task')).toContainText('对方机器上的回答', { timeout: 20_000 })
  } finally {
    for (const device of [host, guest]) {
      await device.app.close()
      rmSync(device.userDataDir, { recursive: true, force: true })
    }
    await model.close()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
})
