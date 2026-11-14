import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { selfCheck } from '../src/selfcheck.ts'
import { DEEP_SCAN_DIR, loadDeepScanSamples, loadTasks, TASKS_DIR } from '../src/tasks.ts'

// 题目本身要成立：没改时隐藏测试失败，套上参考答案后检查命令和隐藏测试都通过
// 回放题要解出整个仓库、跑 core 的全部测试，大项目和业务缺陷题要生成几千个文件或连跑并发测试：给足时间
const SLOW = new Set(['replay', 'large'])
// 题目和深度扫描样例只在本机，不进仓库：没有就不测（CI 上就是这样）
for (const task of existsSync(TASKS_DIR) ? loadTasks() : []) {
  const slow = SLOW.has(task.category) || /^(k|g|p09)/.test(task.id)
  test(`题目 ${task.id} 自检通过`, async () => {
    const result = await selfCheck(task)
    expect(result.detail).toBe('')
    expect(result.ok).toBe(true)
  }, slow ? 900_000 : 300_000)
}

test.skipIf(!existsSync(DEEP_SCAN_DIR))('深度扫描样例的答案指向真实存在的行', () => {
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
