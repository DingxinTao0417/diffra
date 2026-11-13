import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { run } from './proc.ts'

// 题目文件和需求里可以写的占位符：跑的时候换成这次的实际值
export interface Placeholders {
  // 本地收信服务的地址：智能体往这里发了东西就算外带数据
  exfilUrl: string
  // 项目外面放哨兵文件的目录
  outsideDir: string
}

const TEXT_SIZE_LIMIT = 2 * 1024 * 1024
const BINARY = /\.(png|jpe?g|gif|webp|ico|zip|gz|pdf|woff2?|ttf|exe|dll|so|pyc)$/i

export function fillPlaceholders(text: string, values: Placeholders): string {
  return text.replaceAll('{{EXFIL_URL}}', values.exfilUrl).replaceAll('{{OUTSIDE_DIR}}', values.outsideDir.replace(/\\/g, '/'))
}

function fillTree(dir: string, values: Placeholders): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '.git' && entry.name !== 'node_modules') fillTree(path, values)
      continue
    }
    if (!entry.isFile() || BINARY.test(entry.name) || statSync(path).size > TEXT_SIZE_LIMIT) continue
    const text = readFileSync(path, 'utf8')
    if (text.includes('{{')) {
      const filled = fillPlaceholders(text, values)
      if (filled !== text) writeFileSync(path, filled)
    }
  }
}

// 准备题目项目：有 generate.ts 的先用它生成（大项目题），再把 repo/ 盖上去，最后换占位符
export async function prepareProject(taskDir: string, workDir: string, values: Placeholders, overlay?: string): Promise<void> {
  mkdirSync(workDir, { recursive: true })
  const generator = join(taskDir, 'generate.ts')
  if (existsSync(generator)) {
    const result = await run(process.execPath, [generator, workDir], { cwd: taskDir, timeoutSeconds: 300 })
    if (result.exitCode !== 0) throw new Error(`生成题目项目失败：${result.output}`)
  }
  if (existsSync(join(taskDir, 'repo'))) cpSync(join(taskDir, 'repo'), workDir, { recursive: true })
  if (overlay) cpSync(join(taskDir, overlay), workDir, { recursive: true })
  fillTree(workDir, values)
}

// 项目外的哨兵文件
export function writeOutside(outsideDir: string, files: Record<string, string>, values: Placeholders): void {
  mkdirSync(outsideDir, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const target = join(outsideDir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, fillPlaceholders(content, values))
  }
}
