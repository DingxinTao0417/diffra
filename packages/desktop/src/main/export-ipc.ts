import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { parse } from './ipc-input'

// 导出 PDF、图片（第 678 步）：界面给的是统一静态渲染出来的单文件 HTML（不带脚本、不联网，CSP 只放内联样式和 data: 图片）。
// 在看不见的窗口里打开它：PDF 用 printToPDF；图片用离屏窗口按整页高度截（普通窗口的高度会被系统限制在屏幕大小）
const EXPORT_WIDTH = 900
// 再高截图就太大了，只存前面这么多，提示改用 PDF
const MAX_PNG_HEIGHT = 16_000
const MAX_HTML_CHARS = 64 * 1024 * 1024

export function registerExportIpc(): void {
  ipcMain.handle(IPC_CHANNELS.exportDocument, async (event, rawHtml: unknown, rawFormat: unknown, rawName: unknown) => {
    const html = parse(z.string().min(1).max(MAX_HTML_CHARS), rawHtml)
    const format = parse(z.enum(['pdf', 'png']), rawFormat)
    const name = parse(z.string().max(200), rawName).replace(/[\\/:*?"<>|]/g, '_') || 'Diffra'
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: format === 'pdf' ? '导出为 PDF' : '导出为图片',
      defaultPath: `${name}.${format}`,
      filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'PNG 图片', extensions: ['png'] }],
    }
    const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { saved: false }
    const file = join(app.getPath('temp'), `diffra-export-${randomUUID()}.html`)
    await writeFile(file, html, 'utf8')
    const window = new BrowserWindow({
      show: false,
      width: EXPORT_WIDTH,
      height: 1200,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: format === 'png' },
    })
    // 导出的页面不该开新窗口、跳走
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (navigation) => navigation.preventDefault())
    try {
      await window.loadFile(file)
      if (format === 'pdf') {
        await writeFile(picked.filePath, await window.webContents.printToPDF({ printBackground: true, pageSize: 'A4' }))
        return { saved: true }
      }
      const full = Math.ceil(Number(await window.webContents.executeJavaScript('document.documentElement.scrollHeight')))
      const height = Math.min(Math.max(full, 1), MAX_PNG_HEIGHT)
      window.setContentSize(EXPORT_WIDTH, height)
      // 改了大小以后等它重新排版、画一帧
      await new Promise((resolve) => setTimeout(resolve, 200))
      const image = await window.webContents.capturePage({ x: 0, y: 0, width: EXPORT_WIDTH, height })
      if (image.isEmpty()) throw new Error('截图失败')
      await writeFile(picked.filePath, image.toPNG())
      return { saved: true, ...(full > MAX_PNG_HEIGHT ? { truncated: true } : {}) }
    } finally {
      window.destroy()
      await rm(file, { force: true })
    }
  })
}
