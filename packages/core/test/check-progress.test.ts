import { describe, expect, test } from 'vitest'
import {
  checkExhaustion,
  compareCheckErrors,
  MAX_CHECK_FAILURES_PER_TURN,
  newCheckTracker,
  onlyKnownErrors,
  parseCheckErrors,
  progressSummary,
  recordCheckFailure,
  recordCheckPass,
  remainingLines,
} from '../src/session/check-progress.js'

const keys = (output: string, root?: string) => parseCheckErrors(output, root).errors?.map((error) => error.key) ?? null

describe('整理检查输出', () => {
  // 这次改 Composer 的 draftKey 时 pnpm -r typecheck 报的两条
  const taskView = "packages/desktop typecheck: src/renderer/src/features/task/TaskView.tsx(161,17): error TS2741: Property 'draftKey' is missing in type '{ sessionId: string; }' but required in type 'ComposerProps'."
  const homeView = (line: number) =>
    `packages/desktop typecheck: src/renderer/src/features/home/HomeView.tsx(${line},10): error TS2741: Property 'draftKey' is missing in type '{ projectPath: string; }' but required in type 'ComposerProps'.`
  const tsc = (lines: string[]) => ['Exit code: 1', 'Scope: 3 of 4 workspace projects', ...lines, 'packages/desktop typecheck: Failed', ' ELIFECYCLE  Command failed with exit code 2.'].join('\n')

  test('tsc：两条修好一条，算有进展，剩一条', () => {
    const before = parseCheckErrors(tsc([taskView, homeView(188)]))
    const after = parseCheckErrors(tsc([homeView(190)]))
    expect(before.errors?.map((error) => error.key)).toEqual([
      "src/renderer/src/features/task/TaskView.tsx: error TS2741: Property 'draftKey' is missing in type '{ sessionId: string; }' but required in type 'ComposerProps'.",
      "src/renderer/src/features/home/HomeView.tsx: error TS2741: Property 'draftKey' is missing in type '{ projectPath: string; }' but required in type 'ComposerProps'.",
    ])
    const comparison = compareCheckErrors(before, after)
    expect(comparison.progress).toBe(true)
    expect(comparison.resolved).toHaveLength(1)
    expect(comparison.resolved?.[0]).toContain('TaskView.tsx')
    expect(comparison.added).toEqual([])
    expect(comparison.remaining).toHaveLength(1)
    expect(progressSummary(after, comparison)).toBe('Since the last check: 1 of 2 errors fixed, 0 new, 1 remaining.')
    // 给人看的保留行号
    expect(remainingLines(after, 5)).toEqual([homeView(190).replace('packages/desktop typecheck: ', '')])
  })

  test('tsc：只是行号列号变了，算同一条错误，没有进展', () => {
    const comparison = compareCheckErrors(parseCheckErrors(tsc([homeView(188)])), parseCheckErrors(tsc([homeView(240)])))
    expect(comparison).toEqual({ progress: false, resolved: [], added: [], remaining: [expect.stringContaining('HomeView.tsx')] })
  })

  test('同一文件里同样的错误出现两次，修好一处也算进展', () => {
    const twice = parseCheckErrors(['src/a.ts(1,1): error TS2304: Cannot find name \'x\'.', 'src/a.ts(9,1): error TS2304: Cannot find name \'x\'.'].join('\n'))
    const once = parseCheckErrors('src/a.ts(5,1): error TS2304: Cannot find name \'x\'.')
    expect(compareCheckErrors(twice, once)).toMatchObject({ progress: true, remaining: ["src/a.ts: error TS2304: Cannot find name 'x'."] })
  })

  test('tsc --pretty、去掉颜色码和项目根路径', () => {
    const output = '\u001b[96mD:\\work\\app\\src\\a.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m7\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType \'string\' is not assignable to type \'number\'.'
    expect(keys(output, 'D:\\work\\app')).toEqual(["src/a.ts: error TS2322: Type 'string' is not assignable to type 'number'."])
    expect(keys('/d/work/app/src/a.ts(1,2): error TS1005: \';\' expected.', 'D:\\work\\app')).toEqual(["src/a.ts: error TS1005: ';' expected."])
  })

  test('eslint：文件行加缩进的错误行', () => {
    const output = [
      'Exit code: 1',
      '',
      '/home/me/app/src/a.ts',
      "  12:5   error    'x' is defined but never used  @typescript-eslint/no-unused-vars",
      '  30:1   warning  Unexpected console statement   no-console',
      '',
      '/home/me/app/src/b.ts',
      "  3:10  error  'y' is defined but never used  @typescript-eslint/no-unused-vars",
      '',
      '✖ 3 problems (2 errors, 1 warning)',
    ].join('\n')
    // 警告不算错误
    expect(keys(output, '/home/me/app')).toEqual([
      "src/a.ts: error 'x' is defined but never used @typescript-eslint/no-unused-vars",
      "src/b.ts: error 'y' is defined but never used @typescript-eslint/no-unused-vars",
    ])
  })

  test('pnpm -r 的行前缀先剥掉再认', () => {
    const output = [
      'Scope: 2 of 3 workspace projects',
      'packages/core lint$ eslint .',
      'packages/core lint: D:\\w\\app\\packages\\core\\src\\a.ts',
      "packages/core lint:   12:5  error  'x' is defined but never used  no-unused-vars",
      'packages/core lint:   14:1  warning  Unexpected console statement  no-console',
      'packages/py test: FAILED tests/test_a.py::test_x - AssertionError: assert 1 == 2',
      'packages/core lint: Failed',
    ].join('\n')
    expect(keys(output, 'D:\\w\\app')).toEqual([
      "packages/core/src/a.ts: error 'x' is defined but never used no-unused-vars",
      'tests/test_a.py::test_x',
    ])
    // 不是 pnpm 前缀的行不剥：go 的位置行、go test 的 FAIL 行
    expect(keys('./main.go:12:5: undefined: foo\n--- FAIL: TestAdd (0.00s)')).toEqual(['main.go: undefined: foo', 'FAIL TestAdd'])
  })

  test('通用的「文件:行:列: warning」行和 tsc 的 warning 不算错误', () => {
    const output = ["src/a.c:3:5: warning: unused variable 'x'", "src/a.c:9:1: error: expected ';'", "src/b.ts(1,1): warning TS6133: 'y' is declared but never used."].join('\n')
    expect(keys(output)).toEqual(["src/a.c: error: expected ';'"])
  })

  test('pytest：FAILED 和 ERROR 行；耗时不同不影响', () => {
    const run = (seconds: string, failed: string[]) =>
      ['=========================== short test summary info ============================', ...failed, `========================= ${failed.length} failed, 5 passed in ${seconds}s =========================`].join('\n')
    const first = parseCheckErrors(run('0.52', ['FAILED tests/test_app.py::test_add - AssertionError: assert 3 == 4', 'ERROR tests/test_db.py - ModuleNotFoundError: No module named \'db\'']))
    expect(first.errors?.map((error) => error.key)).toEqual(['tests/test_app.py::test_add', 'tests/test_db.py'])
    const second = parseCheckErrors(run('0.61', ['FAILED tests/test_app.py::test_add - AssertionError: assert 3 == 4']))
    expect(compareCheckErrors(first, second)).toMatchObject({ progress: true, resolved: ['tests/test_db.py'] })
  })

  test('pytest：参数化 id 里可以有空格；同一个用例只是断言的值变了不算修好', () => {
    expect(keys('FAILED tests/test_a.py::test_x[a b] - AssertionError: assert 1 == 2')).toEqual(['tests/test_a.py::test_x[a b]'])
    const before = parseCheckErrors('FAILED tests/test_a.py::test_x - AssertionError: assert 3 == 4')
    const after = parseCheckErrors('FAILED tests/test_a.py::test_x - AssertionError: assert 5 == 4')
    expect(compareCheckErrors(before, after)).toMatchObject({ progress: false, resolved: [], remaining: ['tests/test_a.py::test_x'] })
  })

  test('cargo/rustc：错误行加下一行的位置；没有位置的汇总行不算', () => {
    const output = [
      'error[E0425]: cannot find value `x` in this scope',
      ' --> src/main.rs:3:5',
      '  |',
      '3 |     x + 1',
      '  |     ^ not found in this scope',
      '',
      'error: could not compile `demo` (bin "demo") due to 1 previous error',
    ].join('\n')
    expect(keys(output)).toEqual(['src/main.rs: error[E0425]: cannot find value `x` in this scope'])
  })

  test('go：文件:行:列: 内容，go test 的 FAIL 行', () => {
    const output = ['# example.com/demo', './main.go:12:5: undefined: foo', '--- FAIL: TestAdd (0.00s)', '    add_test.go:9: got 3, want 4', 'FAIL\texample.com/demo\t0.012s'].join('\n')
    expect(keys(output)).toEqual(['main.go: undefined: foo', 'FAIL TestAdd', 'add_test.go: got 3, want 4'])
  })

  // 这个项目自己的完成检查（pnpm -r test 里 desktop 的 node --test）：以前认不出失败的用例，汇总里的 duration_ms 每次不一样，
  // 一模一样的失败也算「有进展」，卡住永远判不出来，要失败满每轮上限才停
  test('node --test：「✖ 用例名 (耗时)」算一条错误，汇总标题不算；duration_ms 不同不算有进展', () => {
    const run = (ms: string, total: string) =>
      [
        `packages/desktop test: ✖ 读得到鼠标位置 (${ms}ms)`,
        'packages/desktop test: ✔ 别的都好 (0.09ms)',
        'packages/desktop test: ℹ tests 2',
        'packages/desktop test: ℹ fail 1',
        `packages/desktop test: ℹ duration_ms ${total}`,
        'packages/desktop test: ✖ failing tests:',
        'packages/desktop test: test at scripts/computer.test.ts:40:1',
        `packages/desktop test: ✖ 读得到鼠标位置 (${ms}ms)`,
        "packages/desktop test:   AssertionError [ERR_ASSERTION]: {\"fx\":1.37,\"fy\":0.68}",
      ].join('\n')
    const first = parseCheckErrors(run('0.7113', '49.8789'))
    expect(first.errors?.map((error) => error.key)).toEqual(['✖ 读得到鼠标位置', '✖ 读得到鼠标位置'])
    expect(compareCheckErrors(first, parseCheckErrors(run('0.6993', '48.1538'))).progress).toBe(false)
    // eslint 的总数行不是一条错误
    expect(keys('✖ 3 problems (3 errors, 0 warnings)')).toBeNull()
  })

  test('都是之前就有的错误：认出的按条比，修好几条也算；有新的一条就不算；认不出时整段比', () => {
    const known = parseCheckErrors(['✖ 旧的一 (1ms)', '✖ 旧的二 (1ms)'].join('\n'))
    expect(onlyKnownErrors(known, parseCheckErrors('✖ 旧的二 (3ms)'))).toBe(true)
    expect(onlyKnownErrors(known, parseCheckErrors(['✖ 旧的一 (1ms)', '✖ 新的 (1ms)'].join('\n')))).toBe(false)
    const crash = (ms: number) => `Exit code: 1\nSegmentation fault after ${ms}ms`
    expect(onlyKnownErrors(parseCheckErrors(crash(10)), parseCheckErrors(crash(20)))).toBe(true)
    expect(onlyKnownErrors(parseCheckErrors(crash(10)), parseCheckErrors('Exit code: 1\nBus error'))).toBe(false)
    // 一次认出一次没认出：说不清，按有新问题算
    expect(onlyKnownErrors(known, parseCheckErrors(crash(10)))).toBe(false)
  })

  test('认不出格式时按规范化后的整段输出比较：只是耗时、行号变了算没进展，内容变了算有进展', () => {
    const crash = (ms: number, line: number) => `Exit code: 1\nSegmentation fault (core dumped) after ${ms}ms at main.c:${line}:3`
    const first = parseCheckErrors(crash(120, 10))
    expect(first.errors).toBeNull()
    expect(compareCheckErrors(first, parseCheckErrors(crash(340, 12)))).toEqual({ progress: false, resolved: null, added: null, remaining: null })
    expect(compareCheckErrors(first, parseCheckErrors('Exit code: 1\nBus error')).progress).toBe(true)
    expect(progressSummary(first, null)).toBe('')
    expect(progressSummary(first, compareCheckErrors(first, first))).toBe('The output is the same as after the last check: nothing was fixed.')
    expect(remainingLines(first, 5)).toEqual(['Segmentation fault (core dumped) after 120ms at main.c:10:3'])
  })

  test('认不出格式时整段比较也去掉 eslint 风格的「行:列」', () => {
    const item = (line: number) => `  ${line}:5  error  'x' is defined but never used  no-unused-vars`
    expect(compareCheckErrors(parseCheckErrors(item(12)), parseCheckErrors(item(14))).progress).toBe(false)
  })

  test('认不出格式时剩余内容取输出末尾几行，跳过 Exit code、Scope 和 npm 脚本头', () => {
    const output = ['Exit code: 1', 'Scope: 2 of 3 workspace projects', '> app@1.0.0 test', '> jest', ...Array.from({ length: 8 }, (_, index) => `line ${index + 1}`)].join('\n')
    expect(remainingLines(parseCheckErrors(output), 3)).toEqual(['line 6', 'line 7', 'line 8'])
    expect(remainingLines(parseCheckErrors('Exit code: 1\n> app@1.0.0 test\n> jest\nboom'), 3)).toEqual(['boom'])
  })

  // lint 只有警告，jest 的失败认不出
  const lint = ['/w/app/src/a.ts', '  3:1  warning  Unexpected console statement  no-console', '', '✖ 1 problem (0 errors, 1 warning)']
  const jest = (names: string[]) => ['FAIL src/sum.test.ts', ...names.map((name) => `  ● sum › ${name}\n\n    expect(received).toBe(expected)`), `Tests:       ${names.length} failed, 3 passed`]

  test('警告不算剩余错误：lint 只有警告、jest 修好一部分时算有进展', () => {
    const before = parseCheckErrors(['Exit code: 1', ...lint, ...jest(['adds', 'subtracts', 'multiplies'])].join('\n'), '/w/app')
    const after = parseCheckErrors(['Exit code: 1', ...lint, ...jest(['multiplies'])].join('\n'), '/w/app')
    expect(after.errors).toBeNull()
    const comparison = compareCheckErrors(before, after)
    expect(comparison.progress).toBe(true)
    expect(progressSummary(after, null)).toBe('')
    expect(progressSummary(after, comparison)).toBe('The output changed since the last check.')
    expect(remainingLines(after, 20).some((line) => line.includes('Unexpected console statement'))).toBe(false)
    expect(remainingLines(after, 20)).toContain('● sum › multiplies')
  })

  test('认出的错误一条没修好、其余输出变了也算有进展', () => {
    const tscError = "src/a.ts(1,1): error TS2304: Cannot find name 'x'."
    const before = parseCheckErrors(['Exit code: 1', tscError, ...jest(['adds', 'subtracts'])].join('\n'))
    const after = parseCheckErrors(['Exit code: 1', tscError, ...jest(['subtracts'])].join('\n'))
    expect(compareCheckErrors(before, after)).toMatchObject({ progress: true, resolved: [], added: [], remaining: ["src/a.ts: error TS2304: Cannot find name 'x'."] })
    // 其余输出一样时还是没进展
    expect(compareCheckErrors(before, before).progress).toBe(false)
  })
})

describe('按进展计数', () => {
  const output = (...names: string[]) => names.map((name) => `src/a.ts(1,1): error TS2304: Cannot find name '${name}'.`).join('\n')

  test('第一次失败没有可比的也算一次没进展；连续 3 次没进展算卡住，有进展清零', () => {
    const tracker = newCheckTracker()
    expect(recordCheckFailure(tracker, parseCheckErrors(output('a', 'b')))).toBeNull()
    expect(progressSummary(tracker.last!, null)).toBe('The check reported 2 errors.')
    expect(recordCheckFailure(tracker, parseCheckErrors(output('a', 'b')))?.progress).toBe(false)
    expect(checkExhaustion(tracker, 2)).toBeNull()
    expect(recordCheckFailure(tracker, parseCheckErrors(output('b')))?.progress).toBe(true)
    expect(tracker.stalled).toBe(0)
    recordCheckFailure(tracker, parseCheckErrors(output('b')))
    recordCheckFailure(tracker, parseCheckErrors(output('b')))
    expect(checkExhaustion(tracker, 5)).toBeNull()
    recordCheckFailure(tracker, parseCheckErrors(output('b')))
    expect(checkExhaustion(tracker, 6)).toBe('stalled')
  })

  test('通过时连续计数清零；失败总数由调用方按轮计（两个检查共用），满上限算到头', () => {
    const tracker = newCheckTracker()
    recordCheckFailure(tracker, parseCheckErrors(output('a')))
    recordCheckPass(tracker)
    expect(tracker).toEqual({ last: null, stalled: 0 })
    recordCheckFailure(tracker, parseCheckErrors(output('a')))
    expect(checkExhaustion(tracker, MAX_CHECK_FAILURES_PER_TURN - 1)).toBeNull()
    expect(checkExhaustion(tracker, MAX_CHECK_FAILURES_PER_TURN)).toBe('limit')
  })
})
