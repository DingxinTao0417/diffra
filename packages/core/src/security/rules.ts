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

// Java（v2 的 Java 适配器）：字符串和变量相加，或者 String.format 拼出来的
const JAVA_DYNAMIC_STRING: Rule = {
  any: [
    { kind: 'binary_expression', has: { kind: 'string_literal', stopBy: 'end' } },
    { kind: 'method_invocation', regex: '^String\\.format\\(' },
  ],
}

const javaName = (name: string): Relation => ({ field: 'name', regex: `^(${name})$` })
const javaFirstArg = (rule: Rule): Relation => ({ field: 'arguments', has: { nthChild: 1, ...rule } })
// 方法体里一句实际的代码都没有（只有空的花括号或注释）
const JAVA_STATEMENTS = ['expression_statement', 'throw_statement', 'if_statement', 'local_variable_declaration', 'return_statement', 'try_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'switch_expression']

export const JAVA_RULES: StaticRule[] = [
  {
    ruleId: 'SEC-INJ-1',
    severity: 'high',
    message: 'SQL 语句里拼接了变量，改用 PreparedStatement 的 ? 占位符或 ORM 的参数绑定',
    rule: {
      kind: 'method_invocation',
      all: [
        { has: javaName('executeQuery|executeUpdate|execute|executeLargeUpdate|addBatch|prepareStatement|prepareCall|createQuery|createNativeQuery|createSQLQuery|query|queryForObject|queryForList|queryForMap|update|batchUpdate') },
        { has: javaFirstArg({ regex: SQL_TEXT, ...JAVA_DYNAMIC_STRING }) },
      ],
    },
  },
  {
    ruleId: 'SEC-INJ-2',
    severity: 'high',
    message: '执行命令时拼接了变量，改用 ProcessBuilder 逐个传参数，不经过 shell',
    rule: {
      any: [
        { kind: 'method_invocation', all: [{ has: javaName('exec') }, { has: { field: 'object', regex: 'getRuntime\\(\\)' } }, { has: javaFirstArg(JAVA_DYNAMIC_STRING) }] },
        {
          kind: 'object_creation_expression',
          all: [
            { has: { field: 'type', regex: '^ProcessBuilder$' } },
            { has: { field: 'arguments', has: { kind: 'string_literal', regex: '^"(-c|/c|/C)"$' } } },
            { has: { field: 'arguments', has: JAVA_DYNAMIC_STRING } },
          ],
        },
      ],
    },
  },
  {
    ruleId: 'SEC-INJ-2',
    severity: 'high',
    message: '脚本引擎执行了动态拼出来的代码，换成不执行代码的写法',
    rule: { kind: 'method_invocation', all: [{ has: javaName('eval') }, { has: { field: 'object', regex: '(?i)engine' } }, { not: { has: javaFirstArg({ kind: 'string_literal' }) } }] },
  },
  {
    ruleId: 'SEC-INJ-6',
    severity: 'high',
    message: 'ObjectInputStream、XMLDecoder 反序列化可能来自外部的数据，换成 JSON 这类只含数据的格式，或者加类型白名单',
    rule: { kind: 'object_creation_expression', has: { field: 'type', regex: '^(ObjectInputStream|XMLDecoder)$' } },
  },
  {
    ruleId: 'SEC-INJ-6',
    severity: 'medium',
    message: 'SnakeYAML 默认的 load 能构造任意类，用 SafeConstructor 或换成只读数据的方式',
    rule: { kind: 'method_invocation', all: [{ has: javaName('load|loadAll|loadAs') }, { has: { field: 'object', regex: '(?i)yaml' } }] },
  },
  {
    ruleId: 'SEC-INJ-6',
    severity: 'medium',
    message: '解析 XML 没关掉外部实体（XXE），用 setFeature 禁用 DOCTYPE 或外部实体',
    rule: {
      kind: 'method_invocation',
      regex: '^(DocumentBuilderFactory|SAXParserFactory|XMLInputFactory|TransformerFactory|SchemaFactory)\\.newInstance\\(',
      inside: { kind: 'method_declaration', stopBy: 'end', not: { has: { regex: 'setFeature|ACCESS_EXTERNAL|setExpandEntityReferences|SUPPORT_DTD|IS_SUPPORTING_EXTERNAL_ENTITIES', stopBy: 'end' } } },
    },
  },
  {
    ruleId: 'SEC-KEY-4',
    severity: 'high',
    message: '关闭了 TLS 证书或主机名校验，去掉信任全部证书、跳过主机名校验的写法',
    rule: {
      any: [
        { kind: 'method_declaration', all: [{ has: javaName('checkServerTrusted') }, { has: { field: 'body', kind: 'block', not: { has: { any: JAVA_STATEMENTS.map((kind) => ({ kind })) } } } }] },
        { kind: 'lambda_expression', has: { field: 'body', kind: 'true' }, inside: { kind: 'method_invocation', has: javaName('setHostnameVerifier|setDefaultHostnameVerifier|hostnameVerifier'), stopBy: 'end' } },
        { kind: 'identifier', regex: '^(NoopHostnameVerifier|ALLOW_ALL_HOSTNAME_VERIFIER|TrustAllStrategy)$', not: { inside: { kind: 'import_declaration', stopBy: 'end' } } },
      ],
    },
  },
  {
    ruleId: 'SEC-KEY-2',
    severity: 'medium',
    message: '用 MD5 或 SHA-1 处理密码，改用 BCrypt、SCrypt 或 Argon2',
    rule: { kind: 'method_invocation', regex: '(?i)getInstance\\(\\s*"(MD5|SHA-?1)"', inside: { kind: 'method_declaration', regex: PASSWORD_TEXT, stopBy: 'end' } },
  },
  {
    ruleId: 'SEC-KEY-3',
    severity: 'medium',
    message: '用 Random、Math.random 生成令牌、密钥这类值，改用 SecureRandom',
    rule: {
      any: [
        { kind: 'object_creation_expression', has: { field: 'type', regex: '^Random$' } },
        { kind: 'method_invocation', regex: '^Math\\.random\\(' },
      ],
      inside: {
        any: [
          { kind: 'variable_declarator', has: { field: 'name', regex: SECRET_NAME } },
          { kind: 'assignment_expression', has: { field: 'left', regex: SECRET_NAME } },
          { kind: 'method_declaration', has: { field: 'name', regex: SECRET_NAME } },
        ],
        stopBy: 'end',
      },
    },
  },
  {
    ruleId: 'SEC-OUT-1',
    severity: 'medium',
    message: '把拼接的内容直接写进响应，确认外部数据已经按 HTML 转义',
    rule: { kind: 'method_invocation', all: [{ has: javaName('write|print|println|append') }, { has: { field: 'object', regex: 'getWriter\\(\\)' } }, { has: javaFirstArg(JAVA_DYNAMIC_STRING) }] },
  },
]
