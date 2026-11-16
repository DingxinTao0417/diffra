import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolFinding } from './external.js'

// 动态测试（v2 · M10）：对本机跑着的服务（只许 localhost、127.0.0.1、::1）的接口发几种探测请求，看响应有没有出问题：
// 原样回显标签（反射型 XSS）、跳到外部地址（开放跳转）、读到系统文件（路径穿越）、数据库报错（SQL 注入）、返回堆栈（错误泄露）、
// 缺安全响应头。只发 GET，不带登录态；接口从代码里认（Express/Koa/Fastify、Flask/FastAPI、Spring 的路由写法），也可以自己填。
// 发的请求会真的到达服务，有副作用的 GET 接口也会被调到，开始前要用户确认
export const DYNAMIC_REQUEST_TIMEOUT_MS = 5000
export const DYNAMIC_MAX_ROUTES = 60
const MARKER = 'diffra-probe-7f3a'
const XSS = `<${MARKER}>`
const EXTERNAL = 'https://diffra-probe.invalid/x'
const TRAVERSAL = ['../../../../../../../../etc/hosts', '..\\..\\..\\..\\..\\..\\..\\..\\Windows\\win.ini']
const QUERY_NAMES = ['q', 'query', 'search', 'name', 'message', 'text', 'title']
const REDIRECT_NAMES = ['next', 'url', 'redirect', 'redirect_uri', 'return', 'returnTo', 'return_to', 'callback', 'continue', 'to']
const FILE_NAMES = ['file', 'path', 'filename', 'name', 'page', 'template', 'doc']
const ID_NAMES = ['id', 'user', 'userId', 'item', 'page', 'q']
const STACK = /\bat [\w.<>$]+ \([^)]*:\d+:\d+\)|Traceback \(most recent call last\)|Exception in thread|\.java:\d+\)|\bat [\w.]+\.[\w<>$]+\([\w.]+\.java:\d+\)/
const SQL_ERROR = /SQL syntax|SQLITE_ERROR|SQLite3::|syntax error at or near|ORA-\d{5}|psycopg2\.|unterminated quoted string|SQLSTATE\[|Unclosed quotation mark|mysql_fetch|near ".*": syntax error/i
const HOSTS_FILE = /^\s*127\.0\.0\.1\s+localhost/m
const WIN_INI = /\[fonts\]|for 16-bit app support/i

export function localUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`不是有效的地址：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http 和 https')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('动态测试只对本机跑着的服务（localhost、127.0.0.1、::1），不对外网发请求')
  return url
}

// 从代码里认接口路径：GET 的和不限方法的；路径参数换成 1
export async function discoverRoutes(cwd: string, files: string[]): Promise<string[]> {
  const routes = new Set<string>()
  const patterns = [
    /\b(?:app|router|server|fastify|api)\.(?:get|all)\(\s*['"`](\/[^'"`]*)['"`]/g,
    /@\w+\.(?:route|get)\(\s*['"](\/[^'"]*)['"]/g,
    /@(?:GetMapping|RequestMapping)\(\s*(?:value\s*=\s*|path\s*=\s*)?["'](\/[^"']*)["']/g,
    /\bpath\(\s*['"]([^'"]*)['"]\s*,/g,
  ]
  for (const file of files) {
    const text = await readFile(join(cwd, file), 'utf8').catch(() => '')
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const route = `/${match[1]!.replace(/^\//, '')}`.replace(/:[A-Za-z_]\w*|\{[^}]+\}|<[^>]+>/g, '1').replace(/\*.*$/, '')
        routes.add(route)
        if (routes.size >= DYNAMIC_MAX_ROUTES) return [...routes]
      }
    }
  }
  return [...routes].sort()
}

interface Probe {
  query: Record<string, string>
  check(response: { status: number; location: string | null; body: string; html: boolean }): { ruleId: string; severity: ToolFinding['severity']; message: string } | null
}

const params = (names: string[], value: string) => Object.fromEntries(names.map((name) => [name, value]))

const PROBES: Probe[] = [
  {
    query: params(QUERY_NAMES, XSS),
    check: ({ body, html }) => (html && body.includes(XSS) ? { ruleId: 'SEC-OUT-1', severity: 'high', message: '请求参数里的 HTML 标签原样回显在页面里（反射型 XSS）' } : null),
  },
  {
    query: params(REDIRECT_NAMES, EXTERNAL),
    check: ({ status, location }) => (status >= 300 && status < 400 && location?.startsWith('https://diffra-probe.invalid') ? { ruleId: 'SEC-REQ-2', severity: 'high', message: '按请求参数跳转到了外部地址（开放跳转）' } : null),
  },
  ...TRAVERSAL.map((value) => ({
    query: params(FILE_NAMES, value),
    check: ({ body }: { body: string }) => (HOSTS_FILE.test(body) || WIN_INI.test(body) ? { ruleId: 'SEC-INJ-4', severity: 'high' as const, message: '带 ../ 的参数读到了系统文件（路径穿越）' } : null),
  })),
  {
    query: params(ID_NAMES, `1'"`),
    check: ({ status, body }) => {
      if (SQL_ERROR.test(body)) return { ruleId: 'SEC-INJ-1', severity: 'high', message: '参数里带引号时响应里出现了数据库报错（可能有 SQL 注入）' }
      if (status >= 500 && STACK.test(body)) return { ruleId: 'SEC-OUT-4', severity: 'medium', message: '出错时把堆栈返回给了客户端' }
      return null
    },
  },
]

export interface DynamicOptions {
  baseUrl: string
  routes: string[]
  signal?: AbortSignal
  timeoutMs?: number
}

export async function runDynamicTests(options: DynamicOptions): Promise<{ findings: ToolFinding[]; notes: string[] }> {
  const base = localUrl(options.baseUrl)
  const routes = [...new Set(options.routes.length > 0 ? options.routes : ['/'])].slice(0, DYNAMIC_MAX_ROUTES)
  const findings: ToolFinding[] = []
  const notes: string[] = []
  let reached = 0
  let failed = 0
  let headersChecked = false
  for (const route of routes) {
    for (const probe of PROBES) {
      if (options.signal?.aborted) throw new Error('取消了')
      const url = new URL(route, base)
      for (const [key, value] of Object.entries(probe.query)) url.searchParams.set(key, value)
      let response: Response
      try {
        const timeout = AbortSignal.timeout(options.timeoutMs ?? DYNAMIC_REQUEST_TIMEOUT_MS)
        response = await fetch(url, { redirect: 'manual', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
      } catch (error) {
        if (options.signal?.aborted) throw new Error('取消了')
        failed++
        if (failed === 1) notes.push(`有请求没有回应：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      reached++
      const type = response.headers.get('content-type') ?? ''
      const body = (await response.text().catch(() => '')).slice(0, 200_000)
      const html = /html/i.test(type)
      const issue = probe.check({ status: response.status, location: response.headers.get('location'), body, html })
      if (issue && !findings.some((item) => item.path === route && item.ruleId === issue.ruleId)) findings.push({ tool: 'dynamic', ...issue, path: route, line: null })
      if (!headersChecked && html && response.status < 400) {
        headersChecked = true
        if (!/nosniff/i.test(response.headers.get('x-content-type-options') ?? '')) findings.push({ tool: 'dynamic', ruleId: 'SEC-OUT-3', severity: 'low', path: route, line: null, message: '页面响应没有 X-Content-Type-Options: nosniff' })
      }
    }
  }
  if (reached === 0) throw new Error(`连不上 ${base.origin}，先把服务跑起来`)
  notes.push(`探测了 ${routes.length} 个接口，发了 ${reached + failed} 个请求${failed > 0 ? `（${failed} 个没回应）` : ''}`)
  return { findings, notes }
}
