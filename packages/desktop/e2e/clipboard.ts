import type { Page } from '@playwright/test'

// 几个用例并行跑时共用系统剪贴板，一个用例复制的内容会被另一个读到（第 661 步碰到过）。
// 只看「复制了什么」的用例在页面里把 navigator.clipboard.writeText 换成记录，不碰系统剪贴板
type ClipboardPage = { navigator: { clipboard: { writeText(text: string): Promise<void> } }; __diffraCopied?: string[] }

export async function captureClipboard(window: Page): Promise<void> {
  await window.evaluate(() => {
    const page = globalThis as unknown as ClipboardPage
    page.__diffraCopied = []
    page.navigator.clipboard.writeText = async (text: string) => {
      page.__diffraCopied!.push(text)
    }
  })
}

// 最近一次复制的文字（还没复制过是空串）
export function lastCopied(window: Page): Promise<string> {
  return window.evaluate(() => (globalThis as unknown as ClipboardPage).__diffraCopied?.at(-1) ?? '')
}
