import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { staticScan } from '../src/security/static.js'
import type { AddedLines } from '../src/security/types.js'

// 故意写了漏洞的样例项目，衡量静态检查拦得住哪些、拦不住哪些。
// 每处漏洞一行，标注类别和「静态检查应不应该拦下」；拦不住的是要理解业务或跨文件追踪的问题，留给轻量扫描和深度扫描。
interface Planted {
  file: string
  line: number
  ruleId: string
  // 静态检查应该拦下（true），还是只能靠模型扫描（false）
  static: boolean
  code: string
}

const fakeKey = (prefix: string, body: string) => `${prefix}${body}`

const SERVER_TS: Array<Omit<Planted, 'file' | 'line'> | string> = [
  "import express from 'express'",
  { ruleId: 'SEC-INJ-1', static: true, code: "app.get('/user', async (req, res) => res.json(await db.query(`SELECT * FROM users WHERE id = ${req.query.id}`)))" },
  { ruleId: 'SEC-INJ-4', static: false, code: "app.get('/download', (req, res) => res.sendFile(path.join(UPLOAD_DIR, String(req.query.name))))" },
  { ruleId: 'SEC-INJ-2', static: true, code: "app.post('/ping', (req, res) => exec(`ping -c 1 ${req.body.host}`, (err, out) => res.send(out)))" },
  { ruleId: 'SEC-REQ-2', static: false, code: "app.get('/fetch', async (req, res) => res.send(await (await fetch(String(req.query.url))).text()))" },
  { ruleId: 'SEC-REQ-2', static: false, code: "app.get('/go', (req, res) => res.redirect(String(req.query.next)))" },
  { ruleId: 'SEC-AUTH-1', static: false, code: "app.get('/orders/:id', async (req, res) => res.json(await db.query('SELECT * FROM orders WHERE id = ?', [req.params.id])))" },
  { ruleId: 'SEC-KEY-3', static: true, code: 'const resetToken = Math.random().toString(36).slice(2)' },
  { ruleId: 'SEC-KEY-2', static: true, code: "const passwordHash = crypto.createHash('md5').update(password).digest('hex')" },
  { ruleId: 'SEC-KEY-1', static: true, code: `const STRIPE_KEY = '${fakeKey('sk_live_', '4eC39HqLyjWDarjtT1zdp7dc0000')}'` },
  { ruleId: 'SEC-KEY-4', static: true, code: 'https.request({ hostname: PARTNER_HOST, rejectUnauthorized: false })' },
  { ruleId: 'SEC-REQ-4', static: false, code: "app.post('/upload', upload.single('file'), (req, res) => res.json({ path: req.file?.path }))" },
  { ruleId: 'SEC-OUT-4', static: false, code: 'app.use((err, req, res, next) => res.status(500).send(err.stack))' },
]

const CLIENT_TS: Array<Omit<Planted, 'file' | 'line'> | string> = [
  'export function renderComment(el: HTMLElement, comment: { body: string }) {',
  { ruleId: 'SEC-OUT-1', static: true, code: '  el.innerHTML = comment.body' },
  '}',
]

const APP_PY: Array<Omit<Planted, 'file' | 'line'> | string> = [
  'import os, pickle, random, string, subprocess, requests, yaml',
  { ruleId: 'SEC-INJ-1', static: true, code: "    cur.execute(f\"SELECT * FROM users WHERE name = '{name}'\")" },
  { ruleId: 'SEC-INJ-2', static: true, code: '    os.system("convert " + filename)' },
  { ruleId: 'SEC-INJ-6', static: true, code: '    data = pickle.loads(request.data)' },
  { ruleId: 'SEC-KEY-4', static: true, code: '    requests.get(url, verify=False)' },
  { ruleId: 'SEC-INJ-6', static: true, code: '    config = yaml.load(request.data)' },
  { ruleId: 'SEC-INJ-4', static: false, code: "    return send_file(os.path.join(UPLOADS, request.args['f']))" },
  { ruleId: 'SEC-INJ-2', static: true, code: '    subprocess.run(f"tar xf {archive}", shell=True)' },
  { ruleId: 'SEC-KEY-3', static: true, code: "    token = ''.join(random.choice(string.ascii_letters) for _ in range(32))" },
  { ruleId: 'SEC-AUTH-2', static: false, code: "@app.route('/admin/delete-user', methods=['POST'])" },
]

let project: string
let planted: Planted[]
let findings: Awaited<ReturnType<typeof staticScan>>['findings']

beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'diffra-vulnerable-'))
  planted = []
  const added: AddedLines = new Map()
  for (const [file, lines] of [
    ['src/server.ts', SERVER_TS],
    ['src/client.ts', CLIENT_TS],
    ['app.py', APP_PY],
  ] as const) {
    const text = lines.map((line, index) => {
      if (typeof line === 'string') return line
      planted.push({ ...line, file, line: index + 1 })
      return line.code
    })
    mkdirSync(dirname(join(project, file)), { recursive: true })
    writeFileSync(join(project, file), text.join('\n'))
    added.set(file, new Map(text.map((code, index) => [index + 1, code])))
  }
  findings = (await staticScan(project, added)).findings
})

afterAll(() => {
  rmSync(project, { recursive: true, force: true })
})

describe('漏洞样例项目', () => {
  test('静态检查拦下所有写法类的漏洞，不误报', () => {
    const hits = new Set(findings.map((item) => `${item.path}:${item.line}:${item.ruleId}`))
    const expected = planted.filter((item) => item.static)
    expect(expected.filter((item) => !hits.has(`${item.file}:${item.line}:${item.ruleId}`)).map((item) => item.code)).toEqual([])
    // 报出来的每一条都对应一处埋好的漏洞
    const plantedLines = new Set(planted.map((item) => `${item.file}:${item.line}`))
    expect(findings.filter((item) => !plantedLines.has(`${item.path}:${item.line}`))).toEqual([])
  })

  test('需要理解业务或跨文件追踪的漏洞静态检查拦不住，交给轻量扫描和深度扫描', () => {
    const hitLines = new Set(findings.map((item) => `${item.path}:${item.line}`))
    const logic = planted.filter((item) => !item.static)
    expect(logic.filter((item) => hitLines.has(`${item.file}:${item.line}`)).map((item) => item.code)).toEqual([])
    // 记下这份样例的覆盖情况，汇报时用
    const caught = planted.filter((item) => item.static).length
    expect(`${caught}/${planted.length}`).toBe('14/22')
  })
})
