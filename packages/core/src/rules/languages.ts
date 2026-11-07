import { extname } from 'node:path'
import { runProcess } from '../process.js'

const EXTENSION_LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.py': 'python',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.go': 'go',
  '.rs': 'rust',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.php': 'php',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.dart': 'dart',
  '.scala': 'scala',
  '.sql': 'sql',
}

const DETECT_TIMEOUT_MS = 20_000

export function languageOf(path: string): string | null {
  return EXTENSION_LANGUAGES[extname(path).toLowerCase()] ?? null
}

// 项目里的文件。rg --files 遵守 .gitignore，依赖目录和构建产物不会算进来；
// 文件特别多时输出会被截掉中间一段，只影响计数，不影响判断有哪些语言、有没有界面代码。
export async function listProjectFiles(cwd: string, rgPath: string): Promise<string[]> {
  try {
    const result = await runProcess(rgPath, ['--files'], { cwd, timeoutMs: DETECT_TIMEOUT_MS })
    return result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (error) {
    console.error('[rules] 列出项目文件失败', error)
    return []
  }
}

// 按文件数统计项目里出现的语言
export function countLanguages(files: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of files) {
    const language = languageOf(file)
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1)
  }
  return counts
}

export async function detectLanguages(cwd: string, rgPath: string): Promise<Map<string, number>> {
  return countLanguages(await listProjectFiles(cwd, rgPath))
}
