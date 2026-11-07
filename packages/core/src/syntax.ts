import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { Lang, registerDynamicLanguage } from '@ast-grep/napi'
import python from '@ast-grep/lang-python'

// ast-grep 能解析的语言：内置的 TS/JS，加上动态加载的 Python。静态安全检查和代码大纲共用
export type Language = Lang | 'python'

// Python 语法是动态加载的解析器，整个进程只能注册一次；加载不了时跳过 Python 文件的语法分析。
// 打包后包在 app.asar 里，解析器文件被解到 app.asar.unpacked，ast-grep 用自己的原生代码加载、不认 asar 路径，
// 找不到文件时会直接让进程崩溃（Rust panic，try/catch 接不住），所以先换成真实路径并确认文件存在
let pythonReady: boolean | null = null
export function pythonAvailable(): boolean {
  if (pythonReady === null) {
    const libraryPath = python.libraryPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
    if (!existsSync(libraryPath)) {
      console.error(`[syntax] 找不到 Python 语法的解析器（${libraryPath}），Python 文件跳过语法分析`)
      pythonReady = false
      return false
    }
    try {
      registerDynamicLanguage({ python: { ...python, libraryPath } })
      pythonReady = true
    } catch (error) {
      console.error('[syntax] Python 语法加载失败，Python 文件跳过语法分析', error)
      pythonReady = false
    }
  }
  return pythonReady
}

export function languageOf(path: string): Language | 'vue' | null {
  switch (extname(path).toLowerCase()) {
    case '.ts':
    case '.mts':
    case '.cts':
      return Lang.TypeScript
    case '.tsx':
    case '.jsx':
      return Lang.Tsx
    case '.js':
    case '.mjs':
    case '.cjs':
      return Lang.JavaScript
    case '.vue':
      return 'vue'
    case '.py':
      return pythonAvailable() ? 'python' : null
    default:
      return null
  }
}

// Vue 单文件组件只分析 <script> 部分；记下它在文件里从哪一行开始
export function vueScripts(source: string): Array<{ code: string; lang: Language; lineOffset: number }> {
  const blocks: Array<{ code: string; lang: Language; lineOffset: number }> = []
  for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = match[1] ?? ''
    const code = match[2] ?? ''
    const start = (match.index ?? 0) + match[0].indexOf(code)
    const lang = /lang=["']tsx["']/.test(attrs) ? Lang.Tsx : /lang=["']ts["']/.test(attrs) ? Lang.TypeScript : Lang.JavaScript
    blocks.push({ code, lang, lineOffset: source.slice(0, start).split('\n').length - 1 })
  }
  return blocks
}
