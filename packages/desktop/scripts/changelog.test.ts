// 更新日志的生成规则：node --test scripts/changelog.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions, formatNotes, parseNotes, releaseItems } from '../src/shared/changelog.ts'
import { RELEASE_OVERRIDES, SUBJECT_OVERRIDES } from './changelog-overrides.ts'
import { checkRelease } from './changelog.ts'

test('只收 feat 和 fix，按「；」分条，去掉末尾的开发步骤；fix 和以「修」开头的算修复', () => {
  const items = releaseItems([
    'feat: 停下后有原因说明和下一步；卡住时能只重发这一步；修用量页出现两根滚动条（第 189–208 步）',
    'fix: 密钥存储改用 safeStorage 异步接口',
    'chore: 发布 v0.1.7',
    'docs: decisions.md 补上说明（第 186 步）',
    'test: 补测试',
    'feat(ui): 输入框加提示词优化。',
    'feat: 停下后有原因说明和下一步',
  ])
  assert.deepEqual(items, {
    added: ['停下后有原因说明和下一步', '卡住时能只重发这一步', '输入框加提示词优化'],
    fixed: ['修用量页出现两根滚动条', '密钥存储改用 safeStorage 异步接口'],
  })
})

test('步骤写法有几种：多段、半角括号、前面带阶段名；正文里的括号不动', () => {
  assert.deepEqual(
    releaseItems([
      'feat: 设计任务能放真实图片（第 156–163、173–186 步）',
      'feat: 侧栏待办 (第 248 步)',
      'feat: 界面基础组件改版（改版第 1–7 步）',
      'feat: 统一本轮结论（语义层第 61–66 步）',
      'feat: 侧栏待办（快速记、派给任务）',
    ]).added,
    ['设计任务能放真实图片', '侧栏待办', '界面基础组件改版', '统一本轮结论', '侧栏待办（快速记、派给任务）'],
  )
})

test('发版前检查：这一版没有日志、或者有英文条目都不行', () => {
  assert.match(checkRelease('0.2.0', undefined) ?? '', /0\.2\.0 没有更新日志/)
  assert.match(checkRelease('0.2.0', { version: '0.2.0', date: '2026-11-10', added: [], fixed: [] }) ?? '', /没有更新日志/)
  assert.match(checkRelease('0.2.0', { version: '0.2.0', date: '2026-11-10', added: ['能用自己的 Chrome', 'add usage dashboard'], fixed: [] }) ?? '', /要用中文[\s\S]*- add usage dashboard/)
  assert.equal(checkRelease('0.2.0', { version: '0.2.0', date: '2026-11-10', added: ['能用自己的 Chrome'], fixed: ['修 CI'] }), null)
})

test('换掉的说法：feat、fix 开头的都是中文条目，chore 开头的不进更新日志', () => {
  for (const subject of Object.values(SUBJECT_OVERRIDES)) {
    const { added, fixed } = releaseItems([subject])
    if (subject.startsWith('chore:')) {
      assert.equal(added.length + fixed.length, 0, subject)
      continue
    }
    assert.ok(added.length + fixed.length > 0, subject)
    assert.equal(checkRelease('x', { version: 'x', date: '', added, fixed }), null, subject)
  }
})

test('整版改写的日志：每版至少一条、都是中文，一条一句不带「；」，修复都以「修」开头，写成文字再读回来一样', () => {
  for (const [version, release] of Object.entries(RELEASE_OVERRIDES)) {
    assert.match(version, /^\d+\.\d+\.\d+$/)
    assert.equal(checkRelease(version, { version, date: '', ...release }), null, version)
    for (const item of [...release.added, ...release.fixed]) assert.doesNotMatch(item, /[；;]|^\s|\s$/, `${version}：${item}`)
    for (const item of release.added) assert.ok(!item.startsWith('修'), `${version}：${item}`)
    for (const item of release.fixed) assert.ok(item.startsWith('修'), `${version}：${item}`)
    assert.deepEqual(parseNotes(formatNotes(release)), release, version)
  }
})

test('版本号按数字比', () => {
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0)
  assert.ok(compareVersions('0.2.0', '0.1.99') > 0)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.ok(compareVersions('0.1.8', '0.1.9') < 0)
})

test('说明写成文字再读回来一样；没有修复时不写修复', () => {
  const release = { added: ['能用自己的 Chrome'], fixed: ['修面板画面不更新'] }
  assert.equal(formatNotes(release), '新增\n- 能用自己的 Chrome\n修复\n- 修面板画面不更新')
  assert.deepEqual(parseNotes(formatNotes(release)), release)
  assert.equal(formatNotes({ added: ['一条'], fixed: [] }), '新增\n- 一条')
  assert.deepEqual(parseNotes('随便写的说明'), { added: [], fixed: [] })
})
