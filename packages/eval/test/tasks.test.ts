import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { selfCheck } from '../src/selfcheck.ts'
import { loadDeepScanSamples, loadTasks } from '../src/tasks.ts'

// 题目本身要成立：没改时隐藏测试失败，套上参考答案后检查命令和隐藏测试都通过
test.each(loadTasks().map((task) => [task.id, task] as const))('题目 %s 自检通过', async (_id, task) => {
  const result = await selfCheck(task)
  expect(result.detail).toBe('')
  expect(result.ok).toBe(true)
})

test('深度扫描样例的答案指向真实存在的行', () => {
  const samples = loadDeepScanSamples()
  expect(samples.length).toBeGreaterThan(0)
  for (const sample of samples) {
    for (const location of sample.answers.flatMap((answer) => [answer, ...answer.alternatives])) {
      const lines = readFileSync(join(sample.dir, 'repo', location.path), 'utf8').split('\n')
      expect(lines.length, `${sample.id} ${location.path}`).toBeGreaterThanOrEqual(location.line)
      expect(lines[location.line - 1]?.trim(), `${sample.id} ${location.path}:${location.line}`).not.toBe('')
    }
  }
})
