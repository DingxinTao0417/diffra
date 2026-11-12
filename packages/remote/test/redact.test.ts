import type { SessionUpdate, StoredTurn } from '@diffra/core/types'
import { describe, expect, test } from 'vitest'
import { MAX_DIFF_CHARS } from '../src/messages.js'
import { hidePaths, MAX_TEXT_CHARS, previewTurn, redactDiff, redactText, redactToolCall, redactTurn, redactUpdate } from '../src/redact.js'

// 测试用的假密钥在运行时拼出来，仓库里不出现完整的密钥格式，免得被代码托管平台的密钥扫描拦下
const fakeKey = (prefix: string, body: string) => `${prefix}${body}`
const PEM = [fakeKey('-----BEGIN RSA ', 'PRIVATE KEY-----'), 'A'.repeat(64), 'B'.repeat(64), fakeKey('-----END RSA ', 'PRIVATE KEY-----')].join('\n')

describe('文字脱敏', () => {
  test('格式明确的密钥换成名字', () => {
    const text = [
      `OPENAI 的 key 是 sk-proj-${'a'.repeat(40)}`,
      `token ghp_${'b'.repeat(36)}`,
      fakeKey('AKIA', 'IOSFODNN7EXAMPLE'),
      `AIza${'c'.repeat(35)}`,
      `xoxb-${'1'.repeat(12)}`,
    ].join('\n')
    expect(redactText(text)).toBe(['OPENAI 的 key 是 [已脱敏：模型服务的 API Key]', 'token [已脱敏：GitHub 令牌]', '[已脱敏：AWS 访问密钥]', '[已脱敏：Google API Key]', '[已脱敏：Slack 令牌]'].join('\n'))
  })

  test('PEM 私钥整块换掉，行数不变', () => {
    const text = `前面\n${PEM}\n后面`
    const redacted = redactText(text)
    expect(redacted).toBe(`前面\n[已脱敏：私钥]\n\n\n\n后面`)
    expect(redacted.split('\n')).toHaveLength(text.split('\n').length)
  })

  test('带引号的赋值、环境变量、Authorization 头、地址里的账号密码只换值', () => {
    expect(redactText(`const apiKey = "abcd1234efgh5678"`)).toBe(`const apiKey = "[已脱敏]"`)
    expect(redactText(`{"client_secret": "s3cr3t-value-123"}`)).toBe(`{"client_secret": "[已脱敏]"}`)
    expect(redactText('DB_PASSWORD=hunter2hunter2\nexport GITHUB_TOKEN=abc123\nset MY_API_KEY=xyz\nPORT=3000')).toBe('DB_PASSWORD=[已脱敏]\nexport GITHUB_TOKEN=[已脱敏]\nset MY_API_KEY=[已脱敏]\nPORT=3000')
    expect(redactText('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" https://api')).toBe('curl -H "Authorization: Bearer [已脱敏]" https://api')
    expect(redactText('连 postgres://admin:p4ss@db.local:5432/app 和 https://user:tok@github.com/x.git')).toBe('连 postgres://[已脱敏]@db.local:5432/app 和 https://[已脱敏]@github.com/x.git')
  })

  test('普通代码不动：类型声明、短值、没引号的赋值、普通地址', () => {
    const code = [
      'interface Login { password: string; token?: string }',
      'const password = form.value',
      'const secret = process.env.SECRET',
      'max_tokens: 4096',
      "const pwd = 'short'",
      'fetch("https://diffra.dev/download")',
    ].join('\n')
    expect(redactText(code)).toBe(code)
  })

  // 这几种输入在规则没加上限时会回溯成平方级（64000 个 x 曾经要 4 秒多）；按线性算 20 万字远用不到 1 秒
  test('很长的病态输入也很快', () => {
    const inputs = [
      'x'.repeat(200_000),
      'a.'.repeat(100_000),
      'A'.repeat(200_000),
      `${'PASSWORD'.repeat(25_000)}=`,
      'x://'.repeat(50_000),
      fakeKey('-----BEGIN ', 'PRIVATE KEY-----\n').repeat(7_000),
      `apiKey = "${'v'.repeat(200_000)}`,
    ]
    for (const input of inputs) {
      const started = performance.now()
      redactText(input)
      expect(performance.now() - started, input.slice(0, 30)).toBeLessThan(1000)
    }
  })

  test('超过 64000 字截断并说明；不截断时只脱敏', () => {
    const long = 'x'.repeat(MAX_TEXT_CHARS + 10)
    const redacted = redactText(long)
    expect(redacted.startsWith('x'.repeat(MAX_TEXT_CHARS))).toBe(true)
    expect(redacted).toContain('已截断；完整内容在对方电脑上')
    expect(redactText(long, false)).toBe(long)
  })
})

describe('会话更新和轮次脱敏', () => {
  test('发给远程的权限请求：标题和参数里的密钥脱敏，原对象不改', () => {
    const token = fakeKey('ghp_', 'a'.repeat(36))
    const toolCall = { toolCallId: 't1', title: `执行 git push https://me:${token}@github.com/me/repo`, kind: 'execute', rawInput: { command: `curl -H "Authorization: Bearer ${token}" https://api.example.com` } }
    const before = JSON.stringify(toolCall)
    const redacted = redactToolCall(toolCall)
    expect(JSON.stringify(redacted)).not.toContain(token)
    expect(redacted.rawInput.command).toBe('curl -H "Authorization: Bearer [已脱敏]" https://api.example.com')
    expect(redacted.toolCallId).toBe('t1')
    expect(JSON.stringify(toolCall)).toBe(before)
  })

  test('工具输出里的密钥脱敏、截图换成文字；原对象不改', () => {
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: `export OPENAI_API_KEY=sk-${'k'.repeat(40)}` } },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
      ],
    } as unknown as SessionUpdate
    const before = JSON.stringify(update)
    expect(redactUpdate(update)).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'export OPENAI_API_KEY=[已脱敏]' } },
        { type: 'content', content: { type: 'text', text: '（图片未同步）' } },
      ],
    })
    expect(JSON.stringify(update)).toBe(before)
  })

  test('改动卡片：很长也不截断（界面要按顺序重放），只脱敏；可能含密钥的文件整项不发，保留路径', () => {
    const big = `${'line\n'.repeat(20_000)}const apiKey = "abcd1234efgh5678"\n`
    const diff = { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', content: [{ type: 'diff', path: 'src/big.ts', oldText: null, newText: big, _meta: { diffra: { edit: { startLine: 1, oldLines: 0, newLines: 20_001, base: big } } } }] } as unknown as SessionUpdate
    const redacted = redactUpdate(diff) as unknown as { content: Array<{ newText: string; _meta: { diffra: { edit: { base: string; newLines: number } } } }> }
    const newText = redacted.content[0]!.newText
    expect(newText.length).toBeGreaterThan(MAX_TEXT_CHARS)
    expect(newText.split('\n')).toHaveLength(big.split('\n').length)
    expect(newText).toContain('const apiKey = "[已脱敏]"')
    expect(redacted.content[0]!._meta.diffra.edit).toMatchObject({ base: newText, newLines: 20_001 })

    const env = { sessionUpdate: 'tool_call', toolCallId: 't3', title: '改 .env', status: 'completed', rawInput: { path: 'config/.env.local', old_string: 'A=1', new_string: 'A=2' }, content: [{ type: 'diff', path: 'config/.env.local', oldText: 'A=1', newText: 'A=2' }] } as unknown as SessionUpdate
    expect(redactUpdate(env)).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 't3',
      title: '改 .env',
      status: 'completed',
      rawInput: { path: 'config/.env.local', old_string: '（可能含密钥的文件，内容未同步）', new_string: '（可能含密钥的文件，内容未同步）' },
      content: [{ type: 'diff', path: 'config/.env.local', oldText: '（可能含密钥的文件，内容未同步）', newText: '（可能含密钥的文件，内容未同步）' }],
    })
    // 示例配置不算
    const example = { sessionUpdate: 'tool_call', toolCallId: 't4', rawInput: { path: '.env.example', new_string: 'A=' } } as unknown as SessionUpdate
    expect(redactUpdate(example)).toEqual(example)
  })

  test('可视化只留标题；回复里的图片换成文字', () => {
    const visual = { sessionUpdate: 'tool_call', toolCallId: 't5', title: '图表', _meta: { diffra: { visual: { title: '用量', code: '<svg>…</svg>' } } } } as unknown as SessionUpdate
    expect(redactUpdate(visual)).toEqual({ sessionUpdate: 'tool_call', toolCallId: 't5', title: '图表', _meta: { diffra: { visual: { title: '用量', code: '<p>（可视化内容未同步）</p>' } } } })
    const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } } as unknown as SessionUpdate
    expect(redactUpdate(chunk)).toEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '（图片未同步）' } })
  })

  test('轮次：提问脱敏，图片不发、记下张数，更新逐条脱敏；没有敏感内容的原样', () => {
    const turn: StoredTurn = {
      id: 'turn-1',
      kind: 'prompt',
      prompt: `用这个 key 试试 sk-${'z'.repeat(40)}`,
      startedAt: '2026-11-10T08:00:00.000Z',
      endedAt: null,
      stopReason: null,
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的，password: string 是类型' } }],
      skills: ['review'],
      images: [{ mimeType: 'image/png', data: 'AAAA' }, { mimeType: 'image/png', data: 'BBBB' }],
    }
    expect(redactTurn(turn)).toEqual({ ...turn, prompt: '用这个 key 试试 [已脱敏：模型服务的 API Key]', images: [], omittedImages: 2 })
    const plain: StoredTurn = { ...turn, prompt: '普通的问题', images: [] }
    expect(redactTurn(plain)).toEqual(plain)
  })
})

describe('快照里的工具输出只发开头', () => {
  const text = (value: string) => ({ type: 'content', content: { type: 'text', text: value } })
  const long = 'x'.repeat(5000)
  const turn = (updates: unknown[]): StoredTurn => ({ id: 'turn-1', kind: 'prompt', prompt: '看看', startedAt: '2026-11-11T08:00:00.000Z', endedAt: null, stopReason: null, updates: updates as SessionUpdate[], skills: [], images: [] })

  test('读取、执行、搜索超过 2000 字的文字输出留开头，_meta 记全文长度；种类按 tool_call 上的算', () => {
    const result = previewTurn(
      turn([
        { sessionUpdate: 'tool_call', toolCallId: 'r', title: 'read_file', kind: 'read' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'r', status: 'completed', content: [text(long)] },
        { sessionUpdate: 'tool_call', toolCallId: 'e', title: 'run_command', kind: 'execute', content: [text(long), text('短的')] },
      ]),
    )
    expect(result.updates[1]).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'r', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(2000), _meta: { diffraRemotePreview: 5000 } } }] })
    expect(result.updates[2]).toMatchObject({ content: [{ content: { text: 'x'.repeat(2000), _meta: { diffraRemotePreview: 5000 } } }, text('短的')] })
  })

  test('改动块、别的种类（完成卡、审查）、不到 2000 字的、别的更新都原样', () => {
    const updates = [
      { sessionUpdate: 'tool_call', toolCallId: 'd', title: 'edit_file', kind: 'edit', content: [{ type: 'diff', path: 'a.ts', oldText: long, newText: long }] },
      { sessionUpdate: 'tool_call', toolCallId: 'f', title: '完成', kind: 'other', content: [text(long)] },
      { sessionUpdate: 'tool_call', toolCallId: 's', title: '搜索', kind: 'search', content: [text('x'.repeat(2000))] },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: long } },
    ]
    expect(previewTurn(turn(updates))).toEqual(turn(updates))
  })
})

describe('任务改动的差异', () => {
  const file = (path: string, line: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${line}\n`

  test('可能含密钥的文件只留文件头和一行说明，其余文件里的密钥脱敏、结构不变', () => {
    const key = `sk-${'z'.repeat(40)}`
    const diff = file('src/a.ts', `const key = "${key}"`) + file('.env', `OPENAI_API_KEY=${key}`)
    expect(redactDiff(diff)).toBe(
      `${file('src/a.ts', 'const key = "[已脱敏：模型服务的 API Key]"')}diff --git a/.env b/.env\n@@ -0,0 +1 @@\n+（可能含密钥的文件，内容未同步）\n`,
    )
  })

  test('超过上限时截在文件边界，末尾说明后面没有同步', () => {
    const big = file('big.txt', 'x'.repeat(MAX_DIFF_CHARS - 100))
    const result = redactDiff(file('a.txt', '第一个') + big)
    expect(result.startsWith(file('a.txt', '第一个'))).toBe(true)
    expect(result).not.toContain('big.txt')
    expect(result).toContain('太长，后面的文件没有同步')
  })
})

describe('发出去的副本不带本机的目录结构', () => {
  const roots = { project: 'D:\\work\\proj', home: 'C:\\Users\\alice' }

  test('路径字段：项目里的换成相对项目的（斜杠统一），用户目录换成 ~，别处只留文件名；相对路径不动', () => {
    const update = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      content: [
        { type: 'diff', path: 'D:/work/proj/src/a.ts', oldText: 'x', newText: 'y' },
        { type: 'diff', path: 'd:\\WORK\\proj\\b.ts', oldText: null, newText: 'z' },
      ],
      locations: [{ path: 'C:\\Users\\alice\\notes.md' }, { path: 'E:\\other\\secret\\plan.txt' }, { path: 'src/c.ts' }],
      rawInput: { path: 'D:\\work\\proj' },
    }
    expect(hidePaths(update, roots)).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      content: [
        { type: 'diff', path: 'src/a.ts', oldText: 'x', newText: 'y' },
        { type: 'diff', path: 'b.ts', oldText: null, newText: 'z' },
      ],
      locations: [{ path: '~/notes.md' }, { path: '…/plan.txt' }, { path: 'src/c.ts' }],
      rawInput: { path: '.' },
    })
  })

  test('文字里只换项目目录和用户目录这两个前缀；名字相近的目录不算；改动卡片的原文不动', () => {
    const tool = {
      title: '编辑 D:/work/proj/src/a.ts',
      text: '在 D:\\work\\proj 里跑了 cd D:\\work\\proj\\pkg，日志在 C:\\Users\\alice\\AppData\\x.log，D:\\work\\proj-old 不是项目',
      oldText: 'const root = "D:/work/proj/src"',
    }
    expect(hidePaths(tool, roots)).toEqual({
      title: '编辑 src/a.ts',
      text: '在 . 里跑了 cd pkg，日志在 ~/AppData\\x.log，D:\\work\\proj-old 不是项目',
      oldText: 'const root = "D:/work/proj/src"',
    })
  })

  test('不知道项目目录时只换用户目录', () => {
    expect(hidePaths({ title: '读取 C:/Users/alice/a.txt', path: 'D:\\work\\proj\\a.txt' }, { project: null, home: 'C:\\Users\\alice' })).toEqual({ title: '读取 ~/a.txt', path: '…/a.txt' })
  })
})
