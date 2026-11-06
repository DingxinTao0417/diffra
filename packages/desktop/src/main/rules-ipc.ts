import { readFile } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { parse } from './ipc-input'
import type { RulePackStore } from './rule-packs'

// 导入的规则包是用户自己写的 markdown，过大多半是选错了文件
const MAX_IMPORT_BYTES = 256 * 1024

export function registerRulesIpc(store: RulePackStore): void {
  ipcMain.handle(IPC_CHANNELS.rulesList, () => store.list())

  ipcMain.handle(IPC_CHANNELS.rulesImport, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '导入规则包',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      properties: ['openFile' as const],
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const file = result.canceled ? undefined : result.filePaths[0]
    if (!file) return { view: await store.list(), imported: null }
    const content = await readFile(file)
    if (content.length > MAX_IMPORT_BYTES) throw new Error('文件超过 256 KB，不像是规则包')
    const pack = await store.import(content.toString('utf8'))
    return { view: await store.list(), imported: pack.name }
  })

  ipcMain.handle(IPC_CHANNELS.rulesDelete, async (_event, rawId: unknown) => {
    await store.remove(parse(z.string().min(1), rawId))
    return store.list()
  })
}
