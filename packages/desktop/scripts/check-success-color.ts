// 颜色门禁：node scripts/check-success-color.ts，两条规则，命中的行同一行或上一行要有对应的放行注释
// 成功色：renderer 里用到 success 令牌或 'success' 字面量（tone、variant、映射的键）的行，要有「success-color-allow: 理由」；styles.css 只放行令牌定义行
// 强调色：renderer 里显式的 primary 类名或变量，要有「primary-color-allow: 理由」；components/ui 不扫（原语的 variant 和选中标记），styles.css 放行令牌定义行和 chart-1 别名
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

const desktopDir = resolve(import.meta.dirname, '..')
const rendererDir = join(desktopDir, 'src/renderer')
const stylesFile = join(rendererDir, 'src/styles.css')
const uiDir = join(rendererDir, 'src/components/ui')
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.vue'])

interface Rule {
  name: string
  pattern: RegExp
  definition: RegExp
  allow: RegExp
  // styles.css 里除了令牌定义，其余行能不能靠注释放行
  stylesComments: boolean
  skipDir?: string
  failure: string
}

const RULES: Rule[] = [
  {
    name: '成功色',
    // 任意工具类前缀（text-、border-l-、from-…）和 --success、--color-success 变量都算
    pattern: /[\w-]-success(-soft)?\b|["']success["']/,
    definition: /^\s*--(color-)?success(-soft)?\s*:/,
    allow: /success-color-allow:(.*)/,
    stylesComments: false,
    failure: 'success 只留给验证结果。以下用法要在同一行或上一行写「success-color-allow: 理由」；styles.css 里只能定义令牌：',
  },
  {
    name: '强调色',
    // 任意工具类前缀和 --primary 变量（含 var()、cssVar()）都算；cell.primary、primaryAxisAlign 这类字段名前面不是 -，不会命中
    pattern: /[\w-]-primary(-foreground)?\b/,
    definition: /^\s*--(color-)?primary(-foreground)?\s*:|^\s*--chart-1\s*:\s*var\(--primary\)/,
    allow: /primary-color-allow:(.*)/,
    stylesComments: true,
    skipDir: uiDir,
    failure: 'primary 只给下一步动作和规则里的例外（品牌标、光标、拖放、选中标记）。以下用法要在同一行或上一行写「primary-color-allow: 理由」；components/ui 不扫：',
  },
]

function allowed(rule: Rule, line: string | undefined): boolean {
  const reason = line?.match(rule.allow)?.[1]?.replace(/(\*\/|-->).*$/, '').trim()
  return Boolean(reason)
}

const files = readdirSync(rendererDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && EXTENSIONS.has(extname(entry.name)))
  .map((entry) => join(entry.parentPath, entry.name))

for (const rule of RULES) {
  const scanned = rule.skipDir ? files.filter((file) => !file.startsWith(rule.skipDir + sep)) : files
  const violations: string[] = []
  let definitions = 0
  let comments = 0

  for (const file of scanned) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (!rule.pattern.test(line)) return
      if (file === stylesFile && rule.definition.test(line)) {
        definitions++
        return
      }
      if ((file !== stylesFile || rule.stylesComments) && (allowed(rule, line) || allowed(rule, lines[index - 1]))) comments++
      else violations.push(`${relative(desktopDir, file)}:${index + 1}  ${line.trim()}`)
    })
  }

  if (violations.length > 0) {
    console.error(rule.failure)
    for (const violation of violations) console.error(violation)
    process.exitCode = 1
  } else {
    console.log(`${rule.name}检查通过：扫描 ${scanned.length} 个文件，放行 ${definitions + comments} 处（令牌定义 ${definitions}，注释放行 ${comments}）`)
  }
}
