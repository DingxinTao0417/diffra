import type { SgNode } from '@ast-grep/napi'
import type { SecurityFinding } from './types.js'

// 污点分析（v2 · M10）：在一个函数里按语句顺序跟踪「来自请求的数据」（查询参数、表单、请求体、请求头……），
// 赋给了哪些变量；这些数据没经过校验、转义就流进 SQL、命令、文件路径、跳转、服务端请求、HTML 输出时报出来。
// 只看函数内部（不跨函数、不跨文件），只认常见框架的写法；比按写法匹配的规则准，但漏掉的照样交给模型扫描。
// 规则号对应「安全」规则包；放行注释和静态检查一样
type Dialect = 'script' | 'python'

interface Sink {
  callee: RegExp
  // 只在文件里出现这个词时才算（比如 exec 要是 child_process 的）
  requires?: RegExp
  // 哪些参数带了污点算数：第一个，还是任意一个
  args: 'first' | 'any'
  // Python 的 subprocess：参数是列表、没开 shell 时安全
  shellOnly?: boolean
  // 只在参数像 HTML 时算（res.send(`<p>${x}</p>`)）
  html?: boolean
  ruleId: string
  label: string
}

const SCRIPT_SOURCES = /\b(?:req|request)\.(?:query|body|params|headers|cookies|files|hostname|originalUrl|url)\b|\bctx\.(?:query|params|request\.(?:body|query))\b|\bevent\.(?:queryStringParameters|pathParameters|body)\b|\blocation\.(?:search|hash|href)\b|\bnew URLSearchParams\(\s*location/
const PYTHON_SOURCES = /\brequest\.(?:args|form|values|json|data|files|cookies|headers|GET|POST|get_json\s*\(|query_params|path_params)\b/
const SCRIPT_SANITIZERS = /^(?:path\.basename|encodeURIComponent|encodeURI|parseInt|parseFloat|Number|Boolean|escape\w*|sanitize\w*|validator\.\w+|DOMPurify\.sanitize|xss|he\.encode|String\(Number)\s*\(/
const PYTHON_SANITIZERS = /^(?:int|float|bool|os\.path\.basename|secure_filename|shlex\.quote|quote|quote_plus|escape|html\.escape|markupsafe\.escape|bleach\.clean|uuid\.UUID)\s*\(/

const SCRIPT_SINKS: Sink[] = [
  { callee: /(?:^|\.)(?:query|execute|raw|unsafe|\$queryRawUnsafe|\$executeRawUnsafe)$/, args: 'first', ruleId: 'SEC-INJ-1', label: 'SQL' },
  { callee: /^(?:(?:child_process|cp|childProcess)\.)?(?:exec|execSync)$/, requires: /child_process/, args: 'first', ruleId: 'SEC-INJ-2', label: '系统命令' },
  { callee: /^(?:eval|Function|vm\.runIn\w*)$/, args: 'any', ruleId: 'SEC-INJ-2', label: '动态执行的代码' },
  {
    callee: /^(?:fs|fsp|fs\.promises|promises)\.(?:readFile|readFileSync|createReadStream|createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|readdir|readdirSync|open|openSync)$|^(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|unlink|unlinkSync)$|^res\.(?:sendFile|download)$/,
    args: 'first',
    ruleId: 'SEC-INJ-4',
    label: '文件路径',
  },
  { callee: /^(?:res|reply|ctx|response)\.redirect$/, args: 'any', ruleId: 'SEC-REQ-2', label: '跳转地址' },
  { callee: /^(?:fetch|axios(?:\.(?:get|post|put|patch|delete|head|request))?|got(?:\.\w+)?|https?\.(?:get|request)|superagent\.\w+|ky(?:\.\w+)?|undici\.request)$/, args: 'first', ruleId: 'SEC-REQ-2', label: '服务端发出的请求地址' },
  { callee: /^res\.(?:send|write|end)$/, args: 'first', html: true, ruleId: 'SEC-OUT-1', label: '返回的 HTML' },
]

const PYTHON_SINKS: Sink[] = [
  { callee: /\.(?:execute|executemany|raw|executescript)$/, args: 'first', ruleId: 'SEC-INJ-1', label: 'SQL' },
  { callee: /^(?:os\.system|os\.popen|commands\.getoutput)$/, args: 'first', ruleId: 'SEC-INJ-2', label: '系统命令' },
  { callee: /^subprocess\.(?:run|call|Popen|check_output|check_call)$/, args: 'first', shellOnly: true, ruleId: 'SEC-INJ-2', label: '系统命令' },
  { callee: /^(?:eval|exec)$/, args: 'first', ruleId: 'SEC-INJ-2', label: '动态执行的代码' },
  { callee: /^render_template_string$/, args: 'first', ruleId: 'SEC-INJ-2', label: '模板' },
  { callee: /^(?:open|send_file|os\.remove|os\.unlink|shutil\.rmtree|shutil\.copy\w*|Path)$/, args: 'first', ruleId: 'SEC-INJ-4', label: '文件路径' },
  { callee: /^(?:redirect|HttpResponseRedirect|RedirectResponse)$/, args: 'first', ruleId: 'SEC-REQ-2', label: '跳转地址' },
  { callee: /^(?:requests\.(?:get|post|put|patch|delete|head|request)|httpx\.(?:get|post|put|patch|delete|request)|urllib\.request\.urlopen|urlopen)$/, args: 'first', ruleId: 'SEC-REQ-2', label: '服务端发出的请求地址' },
  { callee: /^(?:Markup|mark_safe)$/, args: 'first', ruleId: 'SEC-OUT-1', label: '标成安全的 HTML' },
]

const SCOPE_KINDS: Record<Dialect, Set<string>> = {
  script: new Set(['function_declaration', 'function_expression', 'arrow_function', 'method_definition', 'generator_function_declaration', 'function']),
  python: new Set(['function_definition']),
}

const NODE_RULES: Record<Dialect, { rule: { any: Array<{ kind: string }> } }> = {
  script: { rule: { any: [{ kind: 'variable_declarator' }, { kind: 'assignment_expression' }, { kind: 'call_expression' }, { kind: 'new_expression' }] } },
  python: { rule: { any: [{ kind: 'assignment' }, { kind: 'call' }] } },
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

class Scope {
  private readonly tainted = new Map<string, string>()

  taint(name: string, origin: string): void {
    this.tainted.set(name, origin)
  }

  clear(name: string): void {
    this.tainted.delete(name)
  }

  // 表达式里用到的带污点的变量（不算属性名 a.name 里的 name）；返回它的来源说明
  find(text: string): string | null {
    for (const [name, origin] of this.tainted) if (new RegExp(`(?<![.\\w$])${escapeRegExp(name)}(?![\\w$])`).test(text)) return origin
    return null
  }
}

function scopeKey(node: SgNode, dialect: Dialect): string {
  for (let current = node.parent(); current; current = current.parent()) {
    if (SCOPE_KINDS[dialect].has(String(current.kind()))) {
      const start = current.range().start
      return `${start.line}:${start.column}`
    }
  }
  return 'module'
}

// 绑定的变量名：a、{ a, b: c }、[a, b]、a, b（Python）
function boundNames(node: SgNode): string[] {
  const kind = String(node.kind())
  if (kind === 'identifier') return [node.text()]
  if (kind === 'shorthand_property_identifier_pattern') return [node.text()]
  return node.children().flatMap((child) => {
    const childKind = String(child.kind())
    if (childKind === 'pair_pattern') {
      const value = child.field('value')
      return value ? boundNames(value) : []
    }
    if (childKind === 'identifier' || childKind === 'shorthand_property_identifier_pattern' || childKind.endsWith('pattern') || childKind === 'pattern_list' || childKind === 'tuple_pattern') return boundNames(child)
    return []
  })
}

export function taintScan(root: SgNode, dialect: Dialect, path: string, added: Map<number, string>, lineOffset: number, fileText: string): SecurityFinding[] {
  const sources = dialect === 'script' ? SCRIPT_SOURCES : PYTHON_SOURCES
  const sanitizers = dialect === 'script' ? SCRIPT_SANITIZERS : PYTHON_SANITIZERS
  const sinks = dialect === 'script' ? SCRIPT_SINKS : PYTHON_SINKS
  const scopes = new Map<string, Scope>()
  const scopeOf = (node: SgNode) => {
    const key = scopeKey(node, dialect)
    let scope = scopes.get(key)
    if (!scope) {
      scope = new Scope()
      scopes.set(key, scope)
    }
    return scope
  }
  // 表达式带不带污点：经过校验、转义函数的不算；直接写了请求参数的算；用到带污点的变量的算
  const taintOf = (expression: SgNode | null, scope: Scope): string | null => {
    if (!expression) return null
    const text = expression.text().trim()
    if (sanitizers.test(text)) return null
    const source = sources.exec(text)
    if (source) return source[0]
    return scope.find(text)
  }

  const findings: SecurityFinding[] = []
  for (const node of root.findAll(NODE_RULES[dialect])) {
    const kind = String(node.kind())
    const scope = scopeOf(node)
    if (kind === 'variable_declarator' || kind === 'assignment_expression' || kind === 'assignment') {
      const target = kind === 'variable_declarator' ? node.field('name') : node.field('left')
      const value = kind === 'variable_declarator' ? node.field('value') : node.field('right')
      if (!target) continue
      const origin = taintOf(value, scope)
      for (const name of boundNames(target)) {
        if (origin) scope.taint(name, origin)
        else scope.clear(name)
      }
      continue
    }
    const callee = (kind === 'new_expression' ? node.field('constructor') : node.field('function'))?.text().replace(/\s+/g, '') ?? ''
    const sink = sinks.find((item) => item.callee.test(callee) && (!item.requires || item.requires.test(fileText)))
    if (!sink) continue
    const args = (node.field('arguments')?.namedChildren() ?? []).filter((child) => child.kind() !== 'comment')
    if (sink.shellOnly && !args.some((arg) => arg.kind() === 'keyword_argument' && /^shell\s*=\s*True$/.test(arg.text().replace(/\s+/g, ' ')))) continue
    const checked = (sink.args === 'first' ? args.slice(0, 1) : args).filter((arg) => arg.kind() !== 'keyword_argument')
    for (const arg of checked) {
      const origin = taintOf(arg, scope)
      if (!origin) continue
      if (sink.html && !/<[a-z!/]/i.test(arg.text())) continue
      const range = node.range()
      let line: number | null = null
      for (let current = range.start.line + 1; current <= range.end.line + 1; current++) {
        if (added.has(current + lineOffset)) {
          line = current + lineOffset
          break
        }
      }
      if (line === null) break
      findings.push({
        ruleId: sink.ruleId,
        severity: 'high',
        path,
        line,
        message: `${sink.label}用了来自请求的数据（${origin}），没有校验或转义（污点分析）`,
        suppressed: null,
      })
      break
    }
  }
  return findings
}
