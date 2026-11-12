// 生成 Mac 的应用图标 build/icon.icns：按 Apple 的图标模板，1024 画布里一块 824 的圆角方形白底，中间放品牌标志（build/brand/icon.svg）。
// Windows 的 icon.ico 是透明底的标志，Mac 的程序坞里习惯是带底板的方块，所以单独做一份。
// 用 Playwright 的 Chromium 把 SVG 画成各尺寸的 PNG，再用系统的 iconutil 合成 .icns，只能在 Mac 上跑：
//   node scripts/mac-icon.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'

if (process.platform !== 'darwin') throw new Error('iconutil 只在 Mac 上有，请在 Mac 上生成 icon.icns')

const desktopDir = resolve(import.meta.dirname, '..')
const mark = readFileSync(join(desktopDir, 'build', 'brand', 'icon.svg'), 'utf8').replace('<svg ', '<svg width="100%" height="100%" ')

// 1024 画布：底板 824（四周各留 100），圆角 185（Apple 模板的比例），阴影向下；标志占底板的大约七成（SVG 自带留白）
const page = (size: number) => `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;transform:scale(${size / 1024});transform-origin:0 0">
  <div style="width:824px;height:824px;border-radius:185px;background:#ffffff;box-shadow:0 0 0 1px rgba(0,0,0,0.06) inset,0 10px 24px rgba(0,0,0,0.22);display:flex;align-items:center;justify-content:center">
    <div style="width:600px;height:600px">${mark}</div>
  </div>
</div></body></html>`

// iconset 里要的文件：每个尺寸的 1 倍和 2 倍
const entries: Array<[string, number]> = []
for (const base of [16, 32, 128, 256, 512]) {
  entries.push([`icon_${base}x${base}.png`, base], [`icon_${base}x${base}@2x.png`, base * 2])
}

const work = mkdtempSync(join(tmpdir(), 'diffra-icon-'))
const iconset = join(work, 'icon.iconset')
mkdirSync(iconset)
const browser = await chromium.launch()
try {
  for (const [name, size] of entries) {
    const tab = await browser.newPage({ viewport: { width: size, height: size } })
    await tab.setContent(page(size))
    await tab.screenshot({ path: join(iconset, name), omitBackground: true })
    await tab.close()
  }
} finally {
  await browser.close()
}
const output = join(desktopDir, 'build', 'icon.icns')
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', output])
rmSync(work, { recursive: true, force: true })
console.log(`已生成 ${output}`)
