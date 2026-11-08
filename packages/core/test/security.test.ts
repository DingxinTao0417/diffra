import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findBash } from '../src/environment.js'
import { auditDependencies } from '../src/security/deps.js'
import { parseLightScanOutput } from '../src/security/light.js'
import { staticScan } from '../src/security/static.js'
import { type AddedLines, addedLinesOf, blocking, formatFindings } from '../src/security/types.js'

let project: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'diffra-security-'))
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

// 写文件，并把指定的行（默认全部）记成本轮新增
function write(added: AddedLines, path: string, lines: string[], addedLineNumbers?: number[]): void {
  const target = join(project, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, lines.join('\n'))
  const numbers = addedLineNumbers ?? lines.map((_, index) => index + 1)
  added.set(path, new Map(numbers.map((line) => [line, lines[line - 1] ?? ''])))
}

const summary = (findings: Awaited<ReturnType<typeof staticScan>>) => findings.map((item) => `${item.line} ${item.ruleId} ${item.severity}`)

describe('静态检查：JS / TS', () => {
  test('该报的都报，安全写法不报', async () => {
    const added: AddedLines = new Map()
    write(added, 'src/app.ts', [
      'const a = await db.query(`SELECT * FROM users WHERE id = ${id}`)',
      "const b = await db.query('SELECT * FROM users WHERE name = ' + name)",
      "const ok = await db.query('SELECT * FROM users WHERE id = ?', [id])",
      'logger.run(`update ${count} items`)',
      'exec(`git log ${branch}`)',
      'db.exec(`CREATE TABLE ${table} (id int)`)',
      "spawn('ls', [dir], { shell: true })",
      'eval(code)',
      "eval('1 + 1')",
      "const fn = new Function('a', body)",
      'el.innerHTML = userInput',
      "el.innerHTML = '<b>固定内容</b>'",
      "el.insertAdjacentHTML('beforeend', html)",
      'https.request({ host, rejectUnauthorized: false })',
      "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'",
      'const token = Math.random().toString(36)',
      'const jitter = Math.random() * 100',
      "const passwordHash = crypto.createHash('md5').update(password).digest('hex')",
      "const etag = crypto.createHash('md5').update(body).digest('hex')",
      "const s = 'eval(x) 只是一段文字'",
    ])
    expect(summary(await staticScan(project, added))).toEqual([
      '1 SEC-INJ-1 high',
      '2 SEC-INJ-1 high',
      '5 SEC-INJ-2 high',
      '7 SEC-INJ-2 medium',
      '8 SEC-INJ-2 high',
      '10 SEC-INJ-2 high',
      '11 SEC-OUT-1 high',
      '13 SEC-OUT-1 high',
      '14 SEC-KEY-4 high',
      '15 SEC-KEY-4 high',
      '16 SEC-KEY-3 medium',
      '18 SEC-KEY-2 medium',
    ])
  })

  test('只看本轮新增的行；JSX 里的 dangerouslySetInnerHTML 只提醒', async () => {
    const added: AddedLines = new Map()
    write(added, 'src/old.ts', ['eval(code)', 'const x = 1'], [2])
    write(added, 'src/View.tsx', ['export const View = ({ html }) => <div dangerouslySetInnerHTML={{ __html: html }} />'])
    expect(summary(await staticScan(project, added))).toEqual(['1 SEC-OUT-1 medium'])
  })

  test('带理由的放行注释生效，没写理由或规则号不对的不算', async () => {
    const added: AddedLines = new Map()
    write(added, 'src/run.ts', [
      '// diffra-allow SEC-INJ-2: branch 来自固定列表',
      'exec(`git log ${branch}`)',
      'exec(`git show ${ref}`) // diffra-allow SEC-INJ-2:',
      '// diffra-allow SEC-INJ-1: 规则号不对',
      'exec(`git diff ${ref}`)',
    ])
    const findings = await staticScan(project, added)
    expect(findings.map((item) => [item.line, item.suppressed])).toEqual([
      [2, 'branch 来自固定列表'],
      [3, null],
      [5, null],
    ])
    expect(blocking(findings).map((item) => item.line)).toEqual([3, 5])
    expect(formatFindings(findings)).toContain('已放行  SEC-INJ-2  src/run.ts:2')
    expect(formatFindings(findings)).toContain('高危  SEC-INJ-2  src/run.ts:3')
  })

  test('Vue 只查 <script>，行号对应整个文件；模板里的 v-html 提醒', async () => {
    const added: AddedLines = new Map()
    write(added, 'src/Comp.vue', [
      '<template>',
      '  <div v-html="content"></div>',
      '</template>',
      '<script setup lang="ts">',
      "const props = defineProps<{ html: string }>()",
      'el.innerHTML = props.html',
      '</script>',
    ])
    expect(summary(await staticScan(project, added))).toEqual(['2 SEC-OUT-1 medium', '6 SEC-OUT-1 high'])
  })
})

describe('静态检查：Python', () => {
  test('该报的都报，安全写法不报', async () => {
    const added: AddedLines = new Map()
    write(added, 'app/db.py', [
      'cursor.execute(f"SELECT * FROM users WHERE id = {uid}")',
      'cursor.execute("SELECT * FROM users WHERE id = %s" % uid)',
      'cursor.execute("SELECT * FROM users WHERE id = %s", (uid,))',
      'cur.execute("SELECT * FROM t WHERE a = {}".format(a))',
      'os.system("rm -rf " + path)',
      'os.system("ls")',
      'subprocess.run(cmd, shell=True)',
      'subprocess.run(f"tar xf {name}", shell=True)',
      'subprocess.run(["ls", path])',
      'value = eval(expr)',
      'data = pickle.loads(blob)',
      'cfg = yaml.load(text)',
      'cfg2 = yaml.load(text, Loader=yaml.SafeLoader)',
      'requests.get(url, verify=False)',
      'digest = hashlib.md5(password.encode()).hexdigest()',
      'checksum = hashlib.md5(data).hexdigest()',
      'token = random.randint(0, 999999)',
    ])
    expect(summary(await staticScan(project, added))).toEqual([
      '1 SEC-INJ-1 high',
      '2 SEC-INJ-1 high',
      '4 SEC-INJ-1 high',
      '5 SEC-INJ-2 high',
      '7 SEC-INJ-2 medium',
      '8 SEC-INJ-2 high',
      '8 SEC-INJ-2 medium',
      '10 SEC-INJ-2 high',
      '11 SEC-INJ-6 high',
      '12 SEC-INJ-6 high',
      '14 SEC-KEY-4 high',
      '15 SEC-KEY-2 medium',
      '17 SEC-KEY-3 medium',
    ])
  })
})

// 测试用的假密钥在运行时拼出来，仓库里不出现完整的密钥格式，免得被代码托管平台的密钥扫描拦下
const fakeKey = (prefix: string, body: string) => `${prefix}${body}`

describe('硬写的密钥', () => {
  test('格式明确的密钥高危，像密码的固定值提醒，示例值和锁文件不报', async () => {
    const added: AddedLines = new Map()
    write(added, 'config/app.json', [
      `{ "aws": "${fakeKey('AKIA', 'IOSFODNN7EXAMPLE')}" ,`,
      `  "openai": "${fakeKey('sk-proj-', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD')}",`,
      '  "password": "hunter2hunter2",',
      '  "secret": "your_secret_here",',
      '  "apiKey": "${API_KEY}" }',
      `  "stripe": "${fakeKey('sk_live_', 'abcdefghijklmnopqrstuvwx0123')}"`,
    ])
    write(added, 'pnpm-lock.yaml', [`integrity: ${fakeKey('sk-', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF')}`])
    expect(summary(await staticScan(project, added))).toEqual(['1 SEC-KEY-1 high', '2 SEC-KEY-1 high', '3 SEC-KEY-1 medium', '6 SEC-KEY-1 high'])
  })
})

describe('新增行', () => {
  test('从 git diff 里取出每个文件新增的行和行号，删掉的文件不算', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@',
      ' keep',
      '-old',
      '+new one',
      '+new two',
      ' tail',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n')
    expect(addedLinesOf(diff)).toEqual(new Map([['a.ts', new Map([[2, 'new one'], [3, 'new two']])]]))
  })
})

describe('轻量扫描的输出解析', () => {
  test('只收规则号存在、落在新增行上的问题；low 和 medium 只提醒', () => {
    const added = new Map([['src/files.ts', new Set([2, 3])]])
    const output = [
      '- high | SEC-INJ-4 | src/files.ts:2 | 路径来自请求参数，没有限制在上传目录内',
      'medium | SEC-REQ-2 | src/files.ts:3 | 跳转地址来自参数',
      'low | SEC-KEY-3 | src/files.ts:3 | 建议用 crypto',
      'high | SEC-FAKE-1 | src/files.ts:2 | 不存在的规则号',
      'high | SEC-INJ-1 | src/files.ts:9 | 不是新增的行',
      'high | SEC-INJ-1 | other.ts:2 | 不是改动的文件',
      '其他说明文字',
    ].join('\n')
    expect(parseLightScanOutput(output, added).map((item) => `${item.line} ${item.ruleId} ${item.severity}`)).toEqual([
      '2 SEC-INJ-4 high',
      '3 SEC-REQ-2 medium',
      '3 SEC-KEY-3 medium',
    ])
    expect(parseLightScanOutput('NO_FINDINGS', added)).toEqual([])
  })
})

describe('依赖审计', () => {
  let bin: string
  let savedPath: string | undefined

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), 'diffra-fake-bin-'))
    savedPath = process.env.PATH
    process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${savedPath ?? ''}`
  })

  afterEach(() => {
    process.env.PATH = savedPath
    rmSync(bin, { recursive: true, force: true })
  })

  // 假的包管理器：audit 时输出固定的 JSON，不联网
  function fakeTool(name: string, report: object): void {
    writeFileSync(join(bin, name), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(report)}\nJSON\nexit 1\n`, { mode: 0o755 })
  }

  test('pnpm：本轮加的依赖有高危漏洞时打回，原有的只计数；锁文件没变时说明', async () => {
    fakeTool('pnpm', {
      advisories: {
        1: { module_name: 'lodash', severity: 'high', title: 'Prototype pollution', patched_versions: '>=4.17.21', findings: [{ paths: ['.>lodash'] }] },
        2: { module_name: 'minimist', severity: 'moderate', title: 'Old issue', patched_versions: '>=1.2.6', findings: [{ paths: ['.>mkdirp>minimist'] }] },
      },
      metadata: {},
    })
    writeFileSync(join(project, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.17.0', mkdirp: '^0.5.0' } }, null, 2))
    const added: AddedLines = new Map([['package.json', new Map([[3, '    "lodash": "^4.17.0",']])]])
    const result = await auditDependencies(project, added, await findBash(), new AbortController().signal)
    expect(result.findings).toEqual([
      expect.objectContaining({ ruleId: 'DEP-VULN', severity: 'high', path: 'package.json', line: 3, message: expect.stringContaining('lodash >=4.17.21') }),
    ])
    expect(result.notes.join('\n')).toContain('项目原有 1 个依赖漏洞')
    expect(result.notes.join('\n')).toContain('锁文件没变')
    // 新依赖没进锁文件，审计里没有它们，只算审计了一部分
    expect(result).toMatchObject({ complete: false, existing: 1 })
  })

  test('npm：中危只提醒；yarn 项目说明暂不支持', async () => {
    fakeTool('npm', { vulnerabilities: { axios: { name: 'axios', severity: 'moderate', via: [{ title: 'SSRF' }], fixAvailable: { name: 'axios', version: '1.7.4' } } } })
    writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { axios: '1.6.0' } }, null, 2))
    const added: AddedLines = new Map([['package.json', new Map([[3, '    "axios": "1.6.0"']])], ['package-lock.json', new Map([[1, '{']])]])
    const result = await auditDependencies(project, added, await findBash(), new AbortController().signal)
    expect(result.findings.map((item) => [item.severity, item.message.includes('axios@1.7.4')])).toEqual([['medium', true]])
    expect(result).toMatchObject({ complete: true, existing: 0 })

    writeFileSync(join(project, 'yarn.lock'), '')
    rmSync(join(project, 'package-lock.json'), { force: true })
    const yarn = await auditDependencies(project, new Map([['package.json', new Map([[3, '    "axios": "1.6.0"']])]]), await findBash(), new AbortController().signal)
    expect(yarn.notes).toContain('yarn 项目暂不支持依赖审计')
    expect(yarn.complete).toBe(false)
  })

  test('npm 输出 error 对象时（如没有锁文件）记为没跑完，不说没有漏洞', async () => {
    fakeTool('npm', { error: { code: 'ENOLOCK', summary: 'This command requires an existing lockfile.', detail: 'Try creating one first with: npm i --package-lock-only' } })
    writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { axios: '1.6.0' } }, null, 2))
    const added: AddedLines = new Map([['package.json', new Map([[3, '    "axios": "1.6.0"']])], ['package-lock.json', new Map([[1, '{']])]])
    const result = await auditDependencies(project, added, await findBash(), new AbortController().signal)
    expect(result).toMatchObject({ complete: false, existing: 0, findings: [] })
    expect(result.notes).toEqual(['依赖审计没有完成，这次不拦截：This command requires an existing lockfile.'])
  })

  test('Python：没有虚拟环境时记为没跑完；有时本轮加的依赖打回，原有的只计数', async () => {
    const added: AddedLines = new Map([['requirements.txt', new Map([[2, 'requests==2.19.0']])]])
    const missing = await auditDependencies(project, added, await findBash(), new AbortController().signal)
    expect(missing).toMatchObject({ complete: false, existing: 0, findings: [] })
    expect(missing.notes).toEqual(['没找到项目的虚拟环境，跳过了 Python 依赖审计'])

    const report = {
      dependencies: [
        { name: 'requests', version: '2.19.0', vulns: [{ id: 'PYSEC-2018-28', fix_versions: ['2.20.0'] }] },
        { name: 'urllib3', version: '1.24.0', vulns: [{ id: 'PYSEC-2019-133', fix_versions: [] }] },
      ],
    }
    mkdirSync(join(project, '.venv', 'bin'), { recursive: true })
    writeFileSync(join(project, '.venv', 'bin', 'python'), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(report)}\nJSON\nexit 1\n`, { mode: 0o755 })
    const result = await auditDependencies(project, added, await findBash(), new AbortController().signal)
    expect(result.findings).toEqual([
      expect.objectContaining({ ruleId: 'DEP-VULN', severity: 'high', path: 'requirements.txt', line: 2, message: expect.stringContaining('升级到 2.20.0') }),
    ])
    expect(result).toMatchObject({ complete: true, existing: 1 })
    expect(result.notes).toEqual(['项目原有 1 个 Python 依赖漏洞，和本轮改动无关，没有计入'])
  })
})
