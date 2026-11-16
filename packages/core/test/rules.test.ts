import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findRipgrep } from '../src/environment.js'
import type { RulePack } from '../src/protocol.js'
import { detectLanguages, languageOf } from '../src/rules/languages.js'
import { parseRulePack, RulePackError } from '../src/rules/pack.js'
import { annotateDiff, buildReviewRequest, parseReviewOutput } from '../src/rules/review.js'
import { packsForPaths, renderRules, selectRulePacks } from '../src/rules/select.js'

const SAMPLE = `---
id: sample
name: 示例
languages: TypeScript, javascript
source: 测试
license: MIT
---

这一段是说明，会被忽略。

## 命名
- [TS-NAME-1][强制] 不用拼音命名。
- [TS-NAME-2][推荐] 名字表达完整含义，
  不用随意缩写。

## 异常
- [TS-ERR-1][强制] 不吞异常。
`

function pack(id: string, languages: string[], rules: Array<[string, 'required' | 'recommended', string]>): RulePack {
  return {
    id,
    name: id,
    languages,
    source: '',
    license: '',
    rules: rules.map(([ruleId, level, text]) => ({ id: ruleId, level, section: null, text })),
  }
}

describe('规则包解析', () => {
  test('读出字段、规则、级别、小节和续行', () => {
    const parsed = parseRulePack(SAMPLE.replace(/\n/g, '\r\n'))
    expect(parsed).toMatchObject({ id: 'sample', name: '示例', languages: ['typescript', 'javascript'], source: '测试', license: 'MIT' })
    expect(parsed.rules).toEqual([
      { id: 'TS-NAME-1', level: 'required', section: '命名', text: '不用拼音命名。' },
      { id: 'TS-NAME-2', level: 'recommended', section: '命名', text: '名字表达完整含义， 不用随意缩写。' },
      { id: 'TS-ERR-1', level: 'required', section: '异常', text: '不吞异常。' },
    ])
  })

  test.each([
    ['没有 front matter', '- [A-1][强制] x', '要以 --- 开头'],
    ['缺字段', SAMPLE.replace('license: MIT\n', ''), '缺少 license'],
    ['id 不合法', SAMPLE.replace('id: sample', 'id: Sample Pack'), '只能用小写字母'],
    ['* 和别的语言混写', SAMPLE.replace('TypeScript, javascript', '*, java'), '写了 * 就不能'],
    ['级别写错', SAMPLE.replace('[TS-ERR-1][强制]', '[TS-ERR-1][必须]'), '级别只能是'],
    ['编号重复', SAMPLE.replace('TS-ERR-1', 'TS-NAME-1'), 'TS-NAME-1 重复'],
    ['编号小写', SAMPLE.replace('TS-ERR-1', 'ts-err-1'), '要用大写字母'],
    ['规则格式不对', SAMPLE.replace('- [TS-ERR-1][强制] 不吞异常。', '- [TS-ERR-1] 不吞异常。'), '第 17 行'],
    ['没有规则', SAMPLE.split('## 命名')[0] ?? '', '没有规则'],
    ['规则太长', SAMPLE.replace('不吞异常。', '长'.repeat(301)), 'TS-ERR-1 超过 300 字'],
  ])('%s 时报错并说明原因', (_name, markdown, message) => {
    expect(() => parseRulePack(markdown)).toThrow(RulePackError)
    expect(() => parseRulePack(markdown)).toThrow(message)
  })
})

describe('内置规则包', () => {
  const packsDir = join(import.meta.dirname, '..', 'rules', 'packs')
  const builtin = readdirSync(packsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => parseRulePack(readFileSync(join(packsDir, name), 'utf8')))
  const required = (item: RulePack): RulePack => ({ ...item, rules: item.rules.filter((rule) => rule.level === 'required') })

  test('都能解析，id 和规则编号全局不重复，并写明出处和许可', () => {
    expect(builtin.map((item) => item.id).sort()).toEqual(['java', 'python', 'security', 'typescript', 'universal'])
    const ruleIds = builtin.flatMap((item) => item.rules.map((rule) => rule.id))
    expect(new Set(ruleIds).size).toBe(ruleIds.length)
    for (const item of builtin) {
      expect(item.source).toMatch(/https:\/\//)
      expect(['Apache-2.0', 'CC-BY-4.0', 'CC-BY-SA-4.0']).toContain(item.license)
    }
  })

  test('单语言项目默认（只放强制级）时，通用、安全加一个语言包能全部放进提示词', () => {
    const universal = builtin.filter((item) => item.languages.includes('*')).map(required)
    for (const item of builtin.filter((candidate) => !candidate.languages.includes('*'))) {
      const { omitted } = renderRules([...universal, required(item)])
      expect(omitted, item.id).toBe(0)
    }
  })
})

describe('项目语言', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'diffra-lang-'))
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))

  test('按扩展名识别', () => {
    expect(languageOf('src/App.TSX')).toBe('typescript')
    expect(languageOf('a/b/Main.java')).toBe('java')
    expect(languageOf('README.md')).toBeNull()
  })

  test('按文件数统计，遵守 .gitignore', async () => {
    mkdirSync(join(project, 'src'))
    mkdirSync(join(project, 'node_modules'))
    writeFileSync(join(project, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(project, 'src', 'a.ts'), '')
    writeFileSync(join(project, 'src', 'b.ts'), '')
    writeFileSync(join(project, 'tool.py'), '')
    writeFileSync(join(project, 'node_modules', 'dep.js'), '')
    // rg 只在 git 仓库里认 .gitignore；放一个空 .git 目录就够了
    mkdirSync(join(project, '.git'))
    const languages = await detectLanguages(project, await findRipgrep())
    expect(Object.fromEntries(languages)).toEqual({ typescript: 2, python: 1 })
  })
})

describe('选包和渲染', () => {
  const universal = pack('universal', ['*'], [['GEN-1', 'required', '通用规则']])
  const java = pack('java', ['java'], [['JAVA-1', 'required', 'Java 规则']])
  const web = pack('web', ['typescript', 'javascript'], [['TS-1', 'required', 'TS 规则']])
  const empty = pack('empty', ['*'], [])

  test('不分语言的包在前，其余按文件数排序，没有的语言和空包不选', () => {
    const languages = new Map([
      ['typescript', 3],
      ['javascript', 5],
      ['java', 4],
    ])
    expect(selectRulePacks([java, empty, web, universal], languages).map((item) => item.id)).toEqual(['universal', 'web', 'java'])
    expect(selectRulePacks([java, web, universal], new Map([['python', 9]])).map((item) => item.id)).toEqual(['universal'])
  })

  test('审查只取和改动文件相关的包', () => {
    expect(packsForPaths([universal, java, web], ['src/a.ts', 'README.md']).map((item) => item.id)).toEqual(['universal', 'web'])
  })

  test('按包分组输出，推荐级带标记', () => {
    const mixed = pack('mixed', ['*'], [
      ['M-1', 'required', '甲'],
      ['M-2', 'recommended', '乙'],
    ])
    expect(renderRules([mixed, java])).toEqual({ text: '### mixed\n- M-1: 甲\n- M-2（推荐）: 乙\n### java\n- JAVA-1: Java 规则', omitted: 0 })
  })

  test('预算不够时先放强制级，超出的计数', () => {
    const first = pack('first', ['*'], [
      ['A-1', 'recommended', '推'.repeat(30)],
      ['A-2', 'required', '强'.repeat(30)],
    ])
    const second = pack('second', ['*'], [['B-1', 'required', '强'.repeat(30)]])
    const { text, omitted } = renderRules([first, second], 80)
    expect(text).toContain('A-2')
    expect(text).not.toContain('A-1')
    expect(omitted).toBe(2)
  })
})

describe('审查用的 diff 和审查意见', () => {
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,3 +10,4 @@ export function main() {',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    ' return a',
    'diff --git a/docs/guide.md b/docs/guide.md',
    '--- a/docs/guide.md',
    '+++ b/docs/guide.md',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/gone.py b/gone.py',
    'deleted file mode 100644',
    '--- a/gone.py',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-print(1)',
    '',
  ].join('\n')

  test('只保留代码文件，新增行和上下文行标上新文件的行号', () => {
    const annotated = annotateDiff(diff)
    expect(annotated.text).toBe(
      [
        '=== src/app.ts',
        '@@ -10,3 +10,4 @@ export function main() {',
        '   10   const a = 1',
        '      - const b = 2',
        '   11 + const b = 3',
        '   12 + const c = 4',
        '   13   return a',
      ].join('\n'),
    )
    expect([...annotated.addedLines]).toEqual([['src/app.ts', new Set([11, 12])]])
    expect(annotated.truncated).toBe(false)
  })

  test('只接受规则编号存在、并且指向新增行的意见', () => {
    const { addedLines } = annotateDiff(diff)
    const output = [
      '* `GEN-ERR-1 | b/src/app.ts:11 | 说明一`',
      'GEN-ERR-1 | src/app.ts:13 | 上下文行不算',
      'XX-1 | src/app.ts:12 | 没有这条规则',
      'GEN-ERR-1 | docs/guide.md:1 | 不是代码文件',
      'NO_VIOLATIONS',
    ].join('\n')
    expect(parseReviewOutput(output, new Set(['GEN-ERR-1']), addedLines)).toEqual([
      { ruleId: 'GEN-ERR-1', path: 'src/app.ts', line: 11, message: '说明一' },
    ])
  })
})

describe('规范审查：Java（v2 的 Java 适配器）', () => {
  test('Java 文件的改动进审查，按 Java 规则包审；内置 Java 包能解析、规则编号对得上', () => {
    const packsDir = join(import.meta.dirname, '..', 'rules', 'packs')
    const packs = readdirSync(packsDir).map((name) => parseRulePack(readFileSync(join(packsDir, name), 'utf8')))
    const java = packs.find((pack) => pack.languages.includes('java'))!
    expect(java.rules.filter((rule) => rule.level === 'required').length).toBeGreaterThan(10)
    const diff = annotateDiff(['--- a/src/main/java/demo/App.java', '+++ b/src/main/java/demo/App.java', '@@ -0,0 +1,2 @@', '+public class App {', '+}'].join('\n'))
    expect([...diff.addedLines]).toEqual([['src/main/java/demo/App.java', new Set([1, 2])]])
    const selected = packsForPaths(packs, [...diff.addedLines.keys()])
    expect(selected.map((pack) => pack.id)).toContain(java.id)
    expect(selected.some((pack) => pack.languages.includes('typescript'))).toBe(false)
    const { system } = buildReviewRequest(selected, diff, '')
    expect(system).toContain(java.rules.find((rule) => rule.level === 'required')!.id)
  })
})

describe('审查请求', () => {
  test('写明只报告改动本身负责的事；超时规则不套用到调用方传入的接口', () => {
    const universal = parseRulePack(readFileSync(join(import.meta.dirname, '..', 'rules', 'packs', 'universal.md'), 'utf8'))
    const timeoutRule = universal.rules.find((rule) => rule.id === 'GEN-IO-1')
    expect(timeoutRule?.text).toContain('只是调用别人传进来的接口时不算')
    const diff = annotateDiff(['--- a/src/repo.js', '+++ b/src/repo.js', '@@ -0,0 +1 @@', '+await db.query(sql, params)'].join('\n'))
    const { system, prompt } = buildReviewRequest([universal], diff, '')
    expect(system).toContain('Only report a violation when the changed code itself is responsible for what the rule asks')
    expect(system).toContain(`GEN-IO-1: ${timeoutRule?.text}`)
    expect(prompt).toContain('    1 + await db.query(sql, params)')
  })
})
