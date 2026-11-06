import type { Rule } from '@ast-grep/napi'
import type { Severity } from './types.js'

// has / inside 里的规则，可以多写 field、stopBy
type Relation = NonNullable<Rule['has']>

export interface StaticRule {
  ruleId: string
  severity: Severity
  message: string
  rule: Rule
}

// 像 SQL 的字符串：要求是完整的语句片段，免得把「update ${x}」这类普通文字当成 SQL
const SQL_TEXT = '(?i)(select .+ from |insert into |update .+ set |delete from )'
// ast-grep 的正则里 \b 不生效，名字匹配都不用它
const SECRET_NAME = '(?i)(token|secret|password|passwd|nonce|salt|otp|apikey|api_key)'
const PASSWORD_TEXT = '(?i)(password|passwd|pwd)'

// JS/TS：模板字符串里有插值，或者字符串和变量相加
const JS_DYNAMIC_STRING: Rule = {
  any: [
    { kind: 'template_string', has: { kind: 'template_substitution' } },
    { kind: 'binary_expression', has: { kind: 'string' } },
  ],
}

const jsCall = (name: string): Relation => ({ field: 'function', regex: `(^|\\.)(${name})$` })
const jsFirstArg = (rule: Rule): Relation => ({ field: 'arguments', has: { nthChild: 1, ...rule } })

export const JS_RULES: StaticRule[] = [
  {
    ruleId: 'SEC-INJ-1',
    severity: 'high',
    message: 'SQL 语句里拼接了变量，改用参数绑定（占位符加参数数组）',
    rule: {
      kind: 'call_expression',
      all: [
        { has: { field: 'function', kind: 'member_expression', has: { field: 'property', regex: '^(query|execute|raw|exec|run|all|get|prepare|queryRawUnsafe|executeRawUnsafe)$' } } },
        { has: jsFirstArg({ regex: SQL_TEXT, ...JS_DYNAMIC_STRING }) },
      ],
    },
  },
  {
    ruleId: 'SEC-INJ-2',
    severity: 'high',
    message: '执行 shell 命令时拼接了变量，改用 execFile 或 spawn 传参数数组',
    // 只认 child_process 的 exec，不把数据库的 db.exec 算进来
    rule: {
      kind: 'call_expression',
      all: [{ has: { field: 'function', regex: '^((child_process|childProcess|cp)\\.)?(exec|execSync|execAsync)$' } }, { has: jsFirstArg(JS_DYNAMIC_STRING) }],
    },
  },
  {
    ruleId: 'SEC-INJ-2',
    severity: 'medium',
    message: '开了 shell: true，参数会经过 shell 解析，确认里面没有外部输入',
    rule: { kind: 'pair', all: [{ has: { field: 'key', regex: '^shell$' } }, { has: { field: 'value', kind: 'true' } }] },
  },
  {
    ruleId: 'SEC-INJ-2',
    severity: 'high',
    message: 'eval / new Function 会执行动态代码，换成不执行代码的写法',
    rule: {
      any: [
        { kind: 'call_expression', all: [{ has: { field: 'function', regex: '^eval$' } }, { not: { has: jsFirstArg({ kind: 'string' }) } }] },
        { kind: 'new_expression', has: { field: 'constructor', regex: '^Function$' } },
      ],
    },
  },
  {
    ruleId: 'SEC-OUT-1',
    severity: 'high',
    message: '把不是固定文字的内容写进了 HTML，改用 textContent 或先转义',
    rule: {
      any: [
        {
          kind: 'assignment_expression',
          all: [
            { has: { field: 'left', kind: 'member_expression', has: { field: 'property', regex: '^(innerHTML|outerHTML)$' } } },
            { not: { has: { field: 'right', kind: 'string' } } },
          ],
        },
        {
          kind: 'call_expression',
          all: [
            { has: jsCall('insertAdjacentHTML|document\\.write|document\\.writeln') },
            { has: { field: 'arguments', has: { any: [{ kind: 'identifier' }, { kind: 'member_expression' }, { kind: 'call_expression' }, ...(JS_DYNAMIC_STRING.any ?? [])] } } },
          ],
        },
      ],
    },
  },
  {
    ruleId: 'SEC-KEY-4',
    severity: 'high',
    message: '关闭了 TLS 证书校验，去掉这个设置',
    rule: {
      any: [
        { kind: 'pair', all: [{ has: { field: 'key', regex: '^rejectUnauthorized$' } }, { has: { field: 'value', kind: 'false' } }] },
        { kind: 'assignment_expression', has: { field: 'left', regex: 'NODE_TLS_REJECT_UNAUTHORIZED' } },
      ],
    },
  },
  {
    ruleId: 'SEC-KEY-3',
    severity: 'medium',
    message: '用 Math.random 生成令牌、密钥这类值，改用 crypto.randomBytes 或 crypto.randomUUID',
    rule: { pattern: 'Math.random()', inside: { kind: 'variable_declarator', has: { field: 'name', regex: SECRET_NAME }, stopBy: 'end' } },
  },
  {
    ruleId: 'SEC-KEY-2',
    severity: 'medium',
    message: '用 MD5 或 SHA-1 处理密码，改用 bcrypt、scrypt 或 Argon2',
    rule: {
      kind: 'call_expression',
      all: [{ has: jsCall('createHash') }, { has: jsFirstArg({ regex: '(?i)^.(md5|sha1).$' }) }],
      inside: { any: [{ kind: 'lexical_declaration' }, { kind: 'expression_statement' }, { kind: 'return_statement' }], regex: PASSWORD_TEXT, stopBy: 'end' },
    },
  },
]

// 只用在 TSX 和 JS 上：TypeScript 的语法里没有 JSX 节点，用了会报规则无效
export const JSX_RULES: StaticRule[] = [
  {
    ruleId: 'SEC-OUT-1',
    severity: 'medium',
    message: '用了 dangerouslySetInnerHTML，确认内容已经过滤',
    rule: { kind: 'jsx_attribute', has: { kind: 'property_identifier', regex: '^dangerouslySetInnerHTML$' } },
  },
]

// Python：f-string、% 或 + 拼接、.format()
const PY_DYNAMIC_STRING: Rule = {
  any: [
    { kind: 'string', has: { kind: 'interpolation' } },
    { kind: 'binary_operator', has: { kind: 'string' } },
    { kind: 'call', has: { field: 'function', kind: 'attribute', has: { field: 'attribute', regex: '^format$' } } },
  ],
}

const pyCall = (name: string): Relation => ({ field: 'function', regex: `^(${name})$` })
const pyFirstArg = (rule: Rule): Relation => ({ field: 'arguments', has: { nthChild: 1, ...rule } })
const pyKeyword = (name: string, valueKind: string): Rule => ({
  kind: 'keyword_argument',
  all: [{ has: { field: 'name', regex: `^${name}$` } }, { has: { field: 'value', kind: valueKind } }],
})

export const PYTHON_RULES: StaticRule[] = [
  {
    ruleId: 'SEC-INJ-1',
    severity: 'high',
    message: 'SQL 语句里拼接了变量，改用参数绑定（execute(sql, params)）',
    rule: {
      kind: 'call',
      all: [
        { has: { field: 'function', kind: 'attribute', has: { field: 'attribute', regex: '^(execute|executemany|executescript|raw)$' } } },
        { has: pyFirstArg({ regex: SQL_TEXT, ...PY_DYNAMIC_STRING }) },
      ],
    },
  },
  {
    ruleId: 'SEC-INJ-2',
    severity: 'high',
    message: '执行 shell 命令时拼接了变量，改用 subprocess.run 传参数列表',
    rule: {
      any: [
        { kind: 'call', all: [{ has: pyCall('os\\.system|os\\.popen') }, { has: pyFirstArg({ not: { kind: 'string' } }) }] },
        { kind: 'call', all: [{ has: pyCall('os\\.system|os\\.popen') }, { has: pyFirstArg(PY_DYNAMIC_STRING) }] },
        {
          kind: 'call',
          all: [{ has: pyCall('subprocess\\.\\w+') }, { has: { field: 'arguments', has: pyKeyword('shell', 'true') } }, { has: pyFirstArg(PY_DYNAMIC_STRING) }],
        },
      ],
    },
  },
  {
    ruleId: 'SEC-INJ-2',
    severity: 'medium',
    message: '开了 shell=True，命令会经过 shell 解析，确认里面没有外部输入',
    rule: pyKeyword('shell', 'true'),
  },
  {
    ruleId: 'SEC-INJ-2',
    severity: 'high',
    message: 'eval / exec 会执行动态代码，换成不执行代码的写法',
    rule: { kind: 'call', all: [{ has: pyCall('eval|exec') }, { not: { has: pyFirstArg({ kind: 'string' }) } }] },
  },
  {
    ruleId: 'SEC-INJ-6',
    severity: 'high',
    message: '反序列化可能来自外部的数据，pickle、marshal 不能用于不可信数据；YAML 用 safe_load',
    rule: {
      any: [
        { kind: 'call', has: pyCall('(pickle|cPickle|marshal|dill)\\.loads?') },
        { kind: 'call', all: [{ has: pyCall('yaml\\.(load|load_all)') }, { not: { has: { field: 'arguments', has: { kind: 'keyword_argument', regex: 'SafeLoader' } } } }] },
      ],
    },
  },
  {
    ruleId: 'SEC-KEY-4',
    severity: 'high',
    message: '关闭了 TLS 证书校验（verify=False），去掉这个参数',
    rule: pyKeyword('verify', 'false'),
  },
  {
    ruleId: 'SEC-KEY-2',
    severity: 'medium',
    message: '用 MD5 或 SHA-1 处理密码，改用 bcrypt、scrypt 或 Argon2',
    rule: { kind: 'call', all: [{ has: pyCall('hashlib\\.(md5|sha1)') }, { regex: PASSWORD_TEXT }] },
  },
  {
    ruleId: 'SEC-KEY-3',
    severity: 'medium',
    message: '用 random 模块生成令牌、密钥这类值，改用 secrets 模块',
    rule: {
      kind: 'call',
      has: pyCall('random\\.\\w+'),
      inside: { kind: 'assignment', has: { field: 'left', regex: SECRET_NAME }, stopBy: 'end' },
    },
  },
]
