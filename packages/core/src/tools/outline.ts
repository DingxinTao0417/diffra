import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, type SgNode } from '@ast-grep/napi'
import { runProcess } from '../process.js'
import { type Language, languageOf, vueScripts } from '../syntax.js'
import { isProtectedFile } from './protected.js'
import { ToolError, type ToolContext, type ToolOutput } from './types.js'
import { resolveInWorkspace } from './workspace.js'

const SOURCE_GLOB = '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue,py}'
const MAX_FILE_BYTES = 1_000_000
const MAX_OUTLINED_FILES = 200
const MAX_OUTPUT_CHARS = 30_000
const MAX_SIGNATURE_CHARS = 160
const RG_TIMEOUT_MS = 30_000

interface OutlineEntry {
  line: number
  depth: number
  signature: string
}

// 列出一个文件或一个目录下所有源文件里定义的函数、类和方法、接口和类型，带行号
export async function outlineTool(context: ToolContext, input: { path?: string }): Promise<ToolOutput> {
  const target = await resolveInWorkspace(context.cwd, input.path ?? '.')
  const info = await stat(target.absolute).catch(() => null)
  if (!info) throw new ToolError(`Not found: ${target.display}`)
  const title = `大纲 ${target.display}`

  if (!info.isDirectory()) {
    if (isProtectedFile(target.display)) throw new ToolError(`${target.display} is protected because it may contain secrets.`)
    if (!languageOf(target.display)) {
      throw new ToolError(`outline supports TypeScript, JavaScript, Vue and Python files. Use read_file for ${target.display}.`)
    }
    const entries = await outlineFile(target.absolute)
    return { text: entries.length > 0 ? formatFile(target.display, entries) : `${target.display}: no top-level definitions.`, title }
  }

  const result = await runProcess(
    context.rgPath,
    ['--files', '--hidden', '--glob', '!.git', '--glob', SOURCE_GLOB, '--path-separator', '/', '--', target.display],
    { cwd: context.cwd, timeoutMs: RG_TIMEOUT_MS, signal: context.signal },
  )
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new ToolError(`outline failed: ${result.output.trim()}`)
  const files = result.output
    .split(/\r?\n/)
    .map((path) => path.replace(/^\.\//, ''))
    .filter((path) => path && !isProtectedFile(path) && languageOf(path))
    .sort()
  if (files.length === 0) return { text: `No TypeScript, JavaScript, Vue or Python files under ${target.display} (ignored files are skipped).`, title }

  const parts: string[] = []
  let chars = 0
  let shown = 0
  for (const path of files.slice(0, MAX_OUTLINED_FILES)) {
    const entries = await outlineFile(join(context.cwd, path))
    const part = entries.length > 0 ? formatFile(path, entries) : path
    if (chars + part.length > MAX_OUTPUT_CHARS) break
    parts.push(part)
    chars += part.length + 1
    shown++
  }
  const note = shown < files.length ? `\n... ${files.length - shown} more files. Outline a subdirectory or a single file to see them.` : ''
  return { text: `${parts.join('\n')}${note}`, title }
}

async function outlineFile(absolute: string): Promise<OutlineEntry[]> {
  const language = languageOf(absolute)
  const info = await stat(absolute).catch(() => null)
  if (!language || !info || info.size > MAX_FILE_BYTES) return []
  const source = await readFile(absolute, 'utf8')
  const blocks = language === 'vue' ? vueScripts(source) : [{ code: source, lang: language, lineOffset: 0 }]
  return blocks.flatMap((block) => topLevel(parse(block.lang, block.code).root(), block.lang).map((entry) => ({ ...entry, line: entry.line + block.lineOffset })))
}

function formatFile(path: string, entries: OutlineEntry[]): string {
  return [path, ...entries.map((entry) => `  ${entry.line}: ${'  '.repeat(entry.depth)}${entry.signature}`)].join('\n')
}

const lineOf = (node: SgNode) => node.range().start.line + 1

// 去掉函数体、类体，只留声明那一段，压成一行
function signatureOf(node: SgNode, body: SgNode | null, prefix = ''): string {
  const text = node.text()
  const head = body && text.endsWith(body.text()) ? text.slice(0, text.length - body.text().length) : text.split('\n')[0] ?? ''
  const signature = `${prefix}${head}`.replace(/\s+/g, ' ').replace(/\s*[{:]?\s*$/, '').trim()
  return signature.length > MAX_SIGNATURE_CHARS ? `${signature.slice(0, MAX_SIGNATURE_CHARS)}…` : signature
}

function topLevel(root: SgNode, language: Language): OutlineEntry[] {
  return root.children().flatMap((node) => (language === 'python' ? pythonDefinition(node, 0) : scriptDefinition(node, '')))
}

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function'])

function scriptDefinition(node: SgNode, prefix: string): OutlineEntry[] {
  switch (node.kind()) {
    case 'export_statement': {
      const declaration = node.field('declaration')
      if (declaration) return scriptDefinition(declaration, node.text().startsWith('export default') ? 'export default ' : 'export ')
      return []
    }
    case 'function_declaration':
    case 'generator_function_declaration':
      return [{ line: lineOf(node), depth: 0, signature: signatureOf(node, node.field('body'), prefix) }]
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const body = node.field('body')
      const methods = (body?.children() ?? []).flatMap((member) =>
        member.kind() === 'method_definition' || member.kind() === 'abstract_method_signature'
          ? [{ line: lineOf(member), depth: 1, signature: signatureOf(member, member.field('body')) }]
          : [],
      )
      return [{ line: lineOf(node), depth: 0, signature: signatureOf(node, body, prefix) }, ...methods]
    }
    case 'interface_declaration':
    case 'enum_declaration':
      return [{ line: lineOf(node), depth: 0, signature: signatureOf(node, node.field('body'), prefix) }]
    case 'type_alias_declaration':
      return [{ line: lineOf(node), depth: 0, signature: signatureOf(node, null, prefix) }]
    case 'lexical_declaration':
    case 'variable_declaration': {
      const keyword = node.child(0)?.text() ?? 'const'
      return node.children().flatMap((declarator) => {
        if (declarator.kind() !== 'variable_declarator') return []
        const value = declarator.field('value')
        const signature =
          value && FUNCTION_VALUES.has(String(value.kind()))
            ? signatureOf(declarator, value.field('body'), `${prefix}${keyword} `)
            : `${prefix}${keyword} ${declarator.field('name')?.text() ?? ''}`
        return [{ line: lineOf(declarator), depth: 0, signature }]
      })
    }
    default:
      return []
  }
}

function pythonDefinition(node: SgNode, depth: number): OutlineEntry[] {
  switch (node.kind()) {
    case 'decorated_definition': {
      const definition = node.field('definition')
      return definition ? pythonDefinition(definition, depth) : []
    }
    case 'function_definition':
      return [{ line: lineOf(node), depth, signature: signatureOf(node, node.field('body')) }]
    case 'class_definition': {
      const body = node.field('body')
      const methods = depth === 0 ? (body?.children() ?? []).flatMap((member) => pythonDefinition(member, 1)).filter((entry) => entry.depth === 1) : []
      return [{ line: lineOf(node), depth, signature: signatureOf(node, body) }, ...methods]
    }
    case 'expression_statement': {
      if (depth > 0) return []
      const assignment = node.child(0)
      const name = assignment?.kind() === 'assignment' ? assignment.field('left') : null
      return name?.kind() === 'identifier' ? [{ line: lineOf(node), depth, signature: name.text() }] : []
    }
    default:
      return []
  }
}
