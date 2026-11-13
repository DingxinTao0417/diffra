import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { answerOpenDialog, cards, chooseProject, clickMenuItem, startDesignTask, startTask, TERMINAL_ECHO, waitTaskDone } from './flows'
import { desktopDir, isPackagedRun, launchApp, makeUserDataDir } from './launch'
import { configureCoderModel } from './model-setup'
import { addFile, startScriptedModel } from './scripted-model'

// core 单测也用的 stdio 测试服务器
const MCP_SERVER = resolve(desktopDir, '../core/test/fixtures/mcp-server.mjs')

// 无项目任务建出来的文件夹：root 下「日期 标题」的那一个。日期不在测试进程里拼，跨午夜时两边取到的日期可能不同
function folderOf(root: string, title: string): string {
  const names = readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2} /.test(name) && name.endsWith(` ${title}`))
  expect(names).toHaveLength(1)
  return join(root, names[0]!)
}

// 应用启动前写好设置文件，只带必填项、默认保存位置和 extra 里的字段
function writeSettings(userDataDir: string, defaultWorkspace: string, extra: Record<string, unknown> = {}): void {
  const roles = { coder: null, planner: null, reviewer: null, fallback: null }
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, providers: [], roles, defaultWorkspace, ...extra }))
}

// 开发版不写设置，测的就是默认值（数据目录下的 workspace）；打包版的默认值是真实的「文档\Diffra」，先改到同一个临时位置
function workspaceRootFor(userDataDir: string): string {
  const root = join(userDataDir, 'workspace')
  if (isPackagedRun()) writeSettings(userDataDir, root)
  return root
}

// 不往系统回收站里扔东西：trashItem 换成记下路径再直接删除，删不掉（比如还被进程占着）照样报错
function replaceTrash(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ shell }) => {
    const trashed: string[] = []
    ;(globalThis as { trashed?: string[] }).trashed = trashed
    shell.trashItem = async (path: string) => {
      trashed.push(path)
      process.getBuiltinModule('node:fs').rmSync(path, { recursive: true, force: true })
    }
  })
}

function trashedPaths(app: ElectronApplication): Promise<string[] | undefined> {
  return app.evaluate(() => (globalThis as { trashed?: string[] }).trashed)
}

// 从侧栏打开任务的删除确认框
async function openDeleteDialog(window: Page, title: string) {
  await window.getByTestId('sidebar-task').filter({ hasText: title }).click({ button: 'right' })
  await window.getByRole('menuitem', { name: '删除任务记录' }).click()
  return window.getByRole('dialog')
}

test('无项目任务：直接发送建在默认位置、侧栏归入「无项目」、首页下拉不列子文件夹；两个任务撤销互不影响；重启后分组还在；删除时文件夹默认保留，勾选后移到回收站', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const root = workspaceRootFor(userDataDir)
  const model = await startScriptedModel([
    { toolCalls: [addFile('note.txt', 'A\n')] },
    { text: '记好了' },
    { toolCalls: [addFile('note.txt', 'B\n')] },
    { text: '记好了' },
  ])
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    // 没选过项目：直接发送，不弹选择框
    await expect(window.getByTestId('project-path')).toContainText('无项目')
    await startTask(window, '整理笔记 A')
    await waitTaskDone(window)
    const folderA = folderOf(root, '整理笔记 A')
    expect(readFileSync(join(folderA, 'note.txt'), 'utf8')).toBe('A\n')

    // 在无项目任务页点菜单「新任务」（Ctrl+N）：新任务还是「无项目」，不把这个任务的文件夹当项目
    await clickMenuItem(app, 'new-task')
    await expect(window.getByRole('heading', { name: '要做什么？' })).toBeVisible()
    await expect(window.getByTestId('project-path')).toContainText('无项目')

    // 侧栏只有「无项目」一组，子文件夹不单独成组
    let groups = window.getByTestId('sidebar-project')
    let noProject = groups.filter({ hasText: '无项目' })
    await expect(groups).toHaveCount(1)
    await expect(noProject.getByTestId('sidebar-task')).toHaveCount(1)

    // 从分组的「+」回到无项目首页；项目下拉里有「无项目」，没有任务的子文件夹
    await window.getByRole('button', { name: '新建无项目任务', exact: true }).click()
    await expect(window.getByRole('heading', { name: '要做什么？' })).toBeVisible()
    await window.getByTestId('project-path').click()
    await expect(window.getByRole('menuitem', { name: /无项目/ })).toBeVisible()
    await expect(window.getByRole('menuitem').filter({ hasText: '整理笔记' })).toHaveCount(0)
    await window.keyboard.press('Escape')

    // 第二个无项目任务在自己的文件夹里写同名文件
    await startTask(window, '整理笔记 B')
    await waitTaskDone(window)
    expect(readdirSync(root)).toHaveLength(2)
    const folderB = folderOf(root, '整理笔记 B')
    expect(readFileSync(join(folderB, 'note.txt'), 'utf8')).toBe('B\n')
    await expect(noProject.getByTestId('sidebar-task')).toHaveCount(2)

    // 撤销 A 只还原 A 的文件夹，B 写的文件还在
    await window.getByTestId('sidebar').getByRole('button', { name: '整理笔记 A', exact: true }).click()
    await expect(window.getByTestId('task-title')).toHaveText('整理笔记 A')
    await cards(window, 'finish').getByRole('button', { name: '撤销改动', exact: true }).click()
    await expect(window.getByTestId('restore-confirm')).toHaveText('撤销 1 个文件')
    await window.getByTestId('restore-confirm').click()
    await expect(window.getByTestId('notice').filter({ hasText: '已撤销 1 个文件的改动' })).toBeVisible()
    expect(existsSync(join(folderA, 'note.txt'))).toBe(false)
    expect(readFileSync(join(folderB, 'note.txt'), 'utf8')).toBe('B\n')
    // A 撤销后可能是空文件夹，空的删除时不问直接删；放一个用户自己的文件，删除框才有勾选项
    writeFileSync(join(folderA, 'mine.txt'), 'keep\n')
    await app.close()

    // 重启后「无项目」分组和两个任务都还在
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    groups = window.getByTestId('sidebar-project')
    noProject = groups.filter({ hasText: '无项目' })
    await expect(groups).toHaveCount(1)
    await expect(noProject.getByTestId('sidebar-task')).toHaveCount(2)

    // 每个任务一个检查点仓库
    const checkpoints = join(userDataDir, 'checkpoints')
    expect(readdirSync(checkpoints)).toHaveLength(2)

    // 不勾选：只删记录，文件夹留着
    await noProject.getByTestId('sidebar-task').filter({ hasText: '整理笔记 B' }).click({ button: 'right' })
    await window.getByRole('menuitem', { name: '删除任务记录' }).click()
    const trashBox = window.getByRole('dialog').getByRole('checkbox', { name: '同时把文件夹移到回收站' })
    await expect(trashBox).not.toBeChecked()
    await window.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(noProject.getByTestId('sidebar-task')).toHaveCount(1)
    expect(readFileSync(join(folderB, 'note.txt'), 'utf8')).toBe('B\n')
    expect(readdirSync(checkpoints)).toHaveLength(2)

    // 勾选：文件夹移到回收站，检查点仓库一起删；主进程只对这个任务的文件夹调用了 trashItem
    await replaceTrash(app)
    await noProject.getByTestId('sidebar-task').filter({ hasText: '整理笔记 A' }).click({ button: 'right' })
    await window.getByRole('menuitem', { name: '删除任务记录' }).click()
    await trashBox.click()
    await expect(trashBox).toBeChecked()
    await window.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)
    expect(await trashedPaths(app)).toEqual([folderA])
    expect(existsSync(folderA)).toBe(false)
    expect(existsSync(folderB)).toBe(true)
    await expect.poll(() => readdirSync(checkpoints).length).toBe(1)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('删除无项目任务：终端开在文件夹里也能移到回收站；文件夹已经不在时只删记录、检查点一起删；文件夹被项目任务共用时只删记录，文件夹和检查点都留着；里面的子文件夹被选成项目时同样只删记录', async () => {
  test.setTimeout(150_000)
  const userDataDir = makeUserDataDir()
  const root = workspaceRootFor(userDataDir)
  const note = (text: string) => ({ toolCalls: [addFile('note.txt', text)] })
  const finish = { text: '记好了' }
  const model = await startScriptedModel([note('1\n'), finish, note('2\n'), finish, note('3\n'), finish, { text: '好的' }, note('4\n'), finish, { text: '好的' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await replaceTrash(app)
    const checkpoints = join(userDataDir, 'checkpoints')

    // 终端开在任务文件夹里、不关就删除并勾选回收站：Windows 上还被进程当作当前目录的文件夹移不走，主进程要先结束这个终端
    await startTask(window, '终端开着')
    await waitTaskDone(window)
    const inTerminal = folderOf(root, '终端开着')
    await window.getByRole('button', { name: '终端 Ctrl+`' }).click()
    await expect(window.getByTestId('terminal-tab')).toContainText(basename(inTerminal))
    const host = window.getByTestId('terminal-host')
    await host.click()
    await window.keyboard.type(TERMINAL_ECHO)
    await window.keyboard.press('Enter')
    await expect(host).toContainText('term-ok-42', { timeout: 20_000 })
    expect(readdirSync(checkpoints)).toHaveLength(1)
    let dialog = await openDeleteDialog(window, '终端开着')
    const trashBox = dialog.getByRole('checkbox', { name: '同时把文件夹移到回收站' })
    await trashBox.click()
    await expect(trashBox).toBeChecked()
    await dialog.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)
    await expect(window.getByRole('status').filter({ hasText: '记录已删除' })).toHaveCount(0)
    expect(await trashedPaths(app)).toEqual([inTerminal])
    expect(existsSync(inTerminal)).toBe(false)
    await expect.poll(() => readdirSync(checkpoints).length).toBe(0)

    // 用户自己删掉了文件夹：确认框写明只删记录，不出勾选项；检查点仓库一起删
    await expect(window.getByTestId('project-path')).toContainText('无项目')
    await startTask(window, '文件夹会被删掉')
    await waitTaskDone(window)
    expect(readdirSync(checkpoints)).toHaveLength(1)
    // 一轮刚结束时文件夹可能还被占着一会儿，要异步等着重试：rmSync 自带的重试是同步的，会卡住测试进程，
    // 应用往测试进程写日志的管道没人读，应用跟着卡住、一直不放手（实测同步重试 10 秒都删不掉，异步等半秒就好）
    const gone = folderOf(root, '文件夹会被删掉')
    await expect.poll(() => {
      try {
        rmSync(gone, { recursive: true, force: true })
        return true
      } catch {
        return false
      }
    }, { timeout: 10_000 }).toBe(true)
    dialog = await openDeleteDialog(window, '文件夹会被删掉')
    await expect(dialog).toContainText('文件夹已经不在了，只删记录。')
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    await dialog.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)
    await expect(window.getByRole('status').filter({ hasText: '记录已删除' })).toHaveCount(0)
    expect(await trashedPaths(app)).toEqual([inTerminal])
    await expect.poll(() => readdirSync(checkpoints).length).toBe(0)

    // 把无项目任务的文件夹用「选择文件夹…」选成项目、在里面建项目任务，再删除无项目任务：
    // 不出勾选项，写明还被其他任务使用；文件夹、项目任务和共用的检查点仓库都还在
    await expect(window.getByTestId('project-path')).toContainText('无项目')
    await startTask(window, '共用文件夹')
    await waitTaskDone(window)
    const shared = folderOf(root, '共用文件夹')
    await window.getByRole('button', { name: '新建无项目任务', exact: true }).click()
    await chooseProject(app, window, shared)
    await startTask(window, '在里面接着做')
    await waitTaskDone(window)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(2)
    dialog = await openDeleteDialog(window, '共用文件夹')
    await expect(dialog).toContainText('文件夹还被其他任务使用，只删记录。')
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    await dialog.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(window.getByRole('status').filter({ hasText: '记录已删除' })).toHaveText(`记录已删除，文件夹还有其他任务在用，保留在 ${shared}`)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(1)
    await expect(window.getByTestId('sidebar-task').filter({ hasText: '在里面接着做' })).toHaveCount(1)
    await expect(window.getByTestId('task-title')).toHaveText('在里面接着做')
    expect(readFileSync(join(shared, 'note.txt'), 'utf8')).toBe('3\n')
    expect(readdirSync(checkpoints)).toHaveLength(1)
    expect(await trashedPaths(app)).toEqual([inTerminal])

    // 无项目任务文件夹里的子文件夹被选成项目、在里面建了项目任务：删除无项目任务同样只删记录，子文件夹和里面的文件都还在
    await clickMenuItem(app, 'new-task')
    await expect(window.getByRole('heading', { name: '要做什么？' })).toBeVisible()
    await window.getByTestId('project-path').click()
    await window.getByRole('menuitem', { name: /无项目/ }).click()
    await expect(window.getByTestId('project-path')).toContainText('无项目')
    await startTask(window, '外层文件夹')
    await waitTaskDone(window)
    const repo = join(folderOf(root, '外层文件夹'), 'repo')
    mkdirSync(repo)
    writeFileSync(join(repo, 'main.txt'), 'repo\n')
    await window.getByRole('button', { name: '新建无项目任务', exact: true }).click()
    await chooseProject(app, window, repo)
    await startTask(window, '在子文件夹里做')
    await waitTaskDone(window)
    await expect(window.getByTestId('sidebar-task')).toHaveCount(3)
    dialog = await openDeleteDialog(window, '外层文件夹')
    await expect(dialog).toContainText('文件夹还被其他任务使用，只删记录。')
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    await dialog.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(window.getByTestId('sidebar-task')).toHaveCount(2)
    await expect(window.getByTestId('sidebar-task').filter({ hasText: '外层文件夹' })).toHaveCount(0)
    expect(readFileSync(join(repo, 'main.txt'), 'utf8')).toBe('repo\n')
    expect(await trashedPaths(app)).toEqual([inTerminal])
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('删除无项目任务：开着 stdio MCP 服务器（当前目录就是任务文件夹）时，空文件夹照样一起删掉', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const root = join(userDataDir, 'workspace')
  writeSettings(userDataDir, root, {
    mcpServers: [{ id: 'demo', name: 'demo', enabled: true, transport: 'stdio', command: process.execPath, args: [MCP_SERVER], envNames: [], url: '', headerNames: [] }],
  })
  const model = await startScriptedModel([{ toolCalls: [{ name: 'mcp__demo__whoami', input: {} }] }, { text: '看过了' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await startTask(window, '查一下目录')
    await waitTaskDone(window, 30_000)
    const folder = folderOf(root, '查一下目录')
    expect(model.bodies()[0]).toContain('mcp__demo__whoami')
    // whoami 回的是服务器进程的当前目录：就是任务文件夹（Mac 的临时目录 /var 是 /private/var 的软链接，进程看到的是真实路径）
    const cwd = process.platform === 'darwin' ? realpathSync(folder) : folder
    expect(model.bodies()[1]).toContain(`cwd=${JSON.stringify(cwd).slice(1, -1)}`)
    expect(readdirSync(folder)).toEqual([])

    const dialog = await openDeleteDialog(window, '查一下目录')
    await expect(dialog).toContainText('它的文件夹是空的，会一起删掉。')
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    await dialog.getByRole('button', { name: '删除记录', exact: true }).click()
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)
    await expect(window.getByRole('status').filter({ hasText: '记录已删除' })).toHaveCount(0)
    expect(existsSync(folder)).toBe(false)
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('默认保存位置不可用：首页报错并给「去设置」，在设置里改了位置后新任务建在新位置', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  // 指向一个普通文件，建不了文件夹
  const blocker = join(userDataDir, 'not-a-folder')
  writeFileSync(blocker, '')
  writeSettings(userDataDir, blocker)
  const moved = mkdtempSync(join(tmpdir(), 'diffra-e2e-workspace-'))
  const model = await startScriptedModel([{ text: '好的' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await expect(window.getByTestId('project-path')).toContainText('无项目')
    await window.getByLabel('任务', { exact: true }).fill('整理笔记')
    await window.getByRole('button', { name: '发送', exact: true }).click()
    await expect(window.getByText(/默认保存位置不可用/)).toBeVisible()
    await expect(window.getByTestId('sidebar-task')).toHaveCount(0)

    await window.getByRole('button', { name: '去设置', exact: true }).click()
    await expect(window.getByText('默认保存位置', { exact: true })).toBeVisible()
    await expect(window.getByText(blocker, { exact: true })).toBeVisible()
    await answerOpenDialog(app, moved)
    await window.getByRole('button', { name: '更改…', exact: true }).click()
    await expect(window.getByText(moved, { exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: '恢复默认', exact: true })).toBeVisible()
    expect(JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')).defaultWorkspace).toBe(moved)
    await window.getByRole('button', { name: '返回' }).click()

    await startTask(window, '整理笔记')
    await waitTaskDone(window)
    expect(readdirSync(moved)).toHaveLength(1)
    folderOf(moved, '整理笔记')
  } finally {
    await app.close()
    await model.close()
    rmSync(moved, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('设计首页不选项目建设计任务：文件夹建在默认位置，侧栏归入「无项目」且带设计标记', async () => {
  test.setTimeout(90_000)
  const userDataDir = makeUserDataDir()
  const root = workspaceRootFor(userDataDir)
  const model = await startScriptedModel([{ text: '先说说要画什么' }])
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await configureCoderModel(window, { name: '脚本模型', baseUrl: model.baseUrl, apiKey: 'e2e-key-123456', modelId: 'scripted' })
    await startDesignTask(window, '画一个登录页')
    await waitTaskDone(window, 30_000)
    expect(model.bodies()[0]).toContain('"design_render"')
    expect(readdirSync(root)).toHaveLength(1)
    folderOf(root, '画一个登录页')

    const noProject = window.getByTestId('sidebar-project').filter({ hasText: '无项目' })
    const row = noProject.getByTestId('sidebar-task').filter({ hasText: '画一个登录页' })
    await expect(row).toHaveCount(1)
    await expect(row.getByRole('img', { name: '设计任务', exact: true })).toBeVisible()
  } finally {
    await app.close()
    await model.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
