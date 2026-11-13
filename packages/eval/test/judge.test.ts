import { expect, test } from 'vitest'
import { languageOf, matchPath } from '../src/judge.ts'

test('路径：不带 * 的是文件或目录，带 * 的按通配', () => {
  expect(matchPath('src/a.ts', 'src')).toBe(true)
  expect(matchPath('src/a.ts', 'src/')).toBe(true)
  expect(matchPath('src2/a.ts', 'src')).toBe(false)
  expect(matchPath('src/a.ts', 'src/a.ts')).toBe(true)
  expect(matchPath('src/deep/a.test.ts', 'src/**/*.test.ts')).toBe(true)
  expect(matchPath('src/a.test.ts', 'src/**/*.test.ts')).toBe(true)
  expect(matchPath('src/deep/a.ts', 'src/*.ts')).toBe(false)
})

test('语言：去掉代码和路径再看，太短的不判', () => {
  expect(languageOf('改好了：`src/a.ts` 里的 checkout 现在会先校验参数，测试都过了。')).toBe('zh')
  expect(languageOf('Fixed the checkout in `src/a.ts`; all tests pass now.')).toBe('en')
  expect(languageOf('好的')).toBe('unknown')
  expect(languageOf('```ts\nconst value = computeEverythingNow()\n```\n已经改好。')).toBe('unknown')
})
