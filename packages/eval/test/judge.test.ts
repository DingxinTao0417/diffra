import { expect, test } from 'vitest'
import { endsWithQuestion } from '../src/conversation.ts'
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

test('文字提问：最后几行里有问句就算在等用户回答（第 630 步）', () => {
  expect(endsWithQuestion('已加上。\n\n提醒一下：文案和规则不一致。要不要我按文案改成 6–20 位？')).toBe(true)
  expect(endsWithQuestion('改好了。要我顺便补测试吗?\n\n- 改了 a.ts')).toBe(true)
  expect(endsWithQuestion('改好了，测试都过了。')).toBe(false)
  expect(endsWithQuestion('为什么会这样？因为缓存键少了数量。已经修好，测试全过。\n- a.ts\n- b.ts\n- c.ts')).toBe(false)
})
