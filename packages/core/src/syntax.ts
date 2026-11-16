import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { type DynamicLangRegistrations, Lang, registerDynamicLanguage } from '@ast-grep/napi'
import go from '@ast-grep/lang-go'
import java from '@ast-grep/lang-java'
import python from '@ast-grep/lang-python'
import rust from '@ast-grep/lang-rust'

// ast-grep 能解析的语言：内置的 TS/JS，加上动态加载的 Python、Java（v2 的 Java 适配器）。静态安全检查用
export type Language = Lang | 'python' | 'java'

export type DynamicLanguage = 'python' | 'go' | 'rust' | 'java'

const DYNAMIC_LANGUAGES = [
  { name: 'python', label: 'Python', registration: python },
  { name: 'go', label: 'Go', registration: go },
  { name: 'rust', label: 'Rust', registration: rust },
  { name: 'java', label: 'Java', registration: java },
] as const

// 动态加载的解析器整个进程只能注册一次（再调一次不报错，但新语言不生效），所以第一次用到任何一种时四种一起注册；
// 某种加载不了时只跳过这种语言的语法分析。
// 打包后包在 app.asar 里，解析器文件被解到 app.asar.unpacked，ast-grep 用自己的原生代码加载、不认 asar 路径，
// 找不到文件时会直接让进程崩溃（Rust panic，try/catch 接不住），所以先换成真实路径并确认文件存在
let dynamicReady: Set<DynamicLanguage> | null = null
export function dynamicLanguageAvailable(name: DynamicLanguage): boolean {
  if (dynamicReady === null) {
    dynamicReady = new Set()
    const registrations: DynamicLangRegistrations = {}
    const ready: Array<(typeof DYNAMIC_LANGUAGES)[number]> = []
    for (const language of DYNAMIC_LANGUAGES) {
      let libraryPath: string
      try {
        // 没有当前平台的预编译解析器时，读 libraryPath 就会抛错
        libraryPath = language.registration.libraryPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
      } catch (error) {
        console.error(`[syntax] 找不到 ${language.label} 语法的解析器，${language.label} 文件跳过语法分析`, error)
        continue
      }
      if (!existsSync(libraryPath)) {
        console.error(`[syntax] 找不到 ${language.label} 语法的解析器（${libraryPath}），${language.label} 文件跳过语法分析`)
        continue
      }
      registrations[language.name] = { ...language.registration, libraryPath }
      ready.push(language)
    }
    if (ready.length > 0) {
      try {
        registerDynamicLanguage(registrations)
        dynamicReady = new Set(ready.map((language) => language.name))
      } catch (error) {
        const labels = ready.map((language) => language.label).join('、')
        console.error(`[syntax] ${labels} 语法加载失败，${labels} 文件跳过语法分析`, error)
      }
    }
  }
  return dynamicReady.has(name)
}

export function pythonAvailable(): boolean {
  return dynamicLanguageAvailable('python')
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
    case '.java':
      return dynamicLanguageAvailable('java') ? 'java' : null
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
