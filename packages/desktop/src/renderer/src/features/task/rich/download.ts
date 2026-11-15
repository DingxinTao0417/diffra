// 回答里的图（流程图、图表）另存为文件：用 <a download> 交给 Electron 的下载流程，和可视化卡片的另存为 HTML 一样

export function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 80) || 'diffra'
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// SVG 画到画布上再导出 PNG：SVG 里不能有 foreignObject（会污染画布），流程图已经关掉了 HTML 标签。scale 是放大倍数，图更清楚
export async function svgToPng(svg: string, background: string, scale = 2): Promise<Blob> {
  const source = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const box = source.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  const width = Number.parseFloat(source.getAttribute('width') ?? '') || box?.[2] || 800
  const height = Number.parseFloat(source.getAttribute('height') ?? '') || box?.[3] || 600
  source.setAttribute('width', String(width))
  source.setAttribute('height', String(height))
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(source))}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width * scale)
  canvas.height = Math.ceil(height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('画布不可用')
  context.fillStyle = background
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('导出图片失败'))), 'image/png'))
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
