// 成功色门禁：node scripts/check-success-color.ts
// renderer 里用到 success 令牌或 'success' 字面量（tone、variant、映射的键）的行，同一行或上一行要有「success-color-allow: 理由」；styles.css 只放行令牌定义行
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const desktopDir = resolve(import.meta.dirname, '..')
const rendererDir = join(desktopDir, 'src/renderer')
const stylesFile = join(rendererDir, 'src/styles.css')
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.vue'])
// 任意工具类前缀（text-、border-l-、from-…）和 --success、--color-success 变量都算
const SUCCESS_PATTERN = /[\w-]-success(-soft)?\b|["']success["']/
const TOKEN_DEFINITION = /^\s*--(color-)?success(-soft)?\s*:/
const ALLOW_PATTERN = /success-color-allow:(.*)/

function allowed(line: string | undefined): boolean {
  const reason = line?.match(ALLOW_PATTERN)?.[1]?.replace(/(\*\/|-->).*$/, '').trim()
  return Boolean(reason)
}

const files = readdirSync(rendererDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && EXTENSIONS.has(extname(entry.name)))
  .map((entry) => join(entry.parentPath, entry.name))
const violations: string[] = []
let definitions = 0
let comments = 0

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!SUCCESS_PATTERN.test(line)) return
    if (file === stylesFile) {
      if (TOKEN_DEFINITION.test(line)) definitions++
      else violations.push(`${relative(desktopDir, file)}:${index + 1}  ${line.trim()}`)
      return
    }
    if (allowed(line) || allowed(lines[index - 1])) comments++
    else violations.push(`${relative(desktopDir, file)}:${index + 1}  ${line.trim()}`)
  })
}

if (violations.length > 0) {
  console.error('success 只留给验证结果。以下用法要在同一行或上一行写「success-color-allow: 理由」；styles.css 里只能定义令牌：')
  for (const violation of violations) console.error(violation)
  process.exitCode = 1
} else {
  console.log(`成功色检查通过：扫描 ${files.length} 个文件，放行 ${definitions + comments} 处（令牌定义 ${definitions}，注释放行 ${comments}）`)
}
