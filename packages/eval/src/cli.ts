import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { apiKeyOf, loadConfig } from './config.ts'
import { type DeepScanResult, runDeepScanSample } from './deep-scan.ts'
import { writeReport } from './report.ts'
import { runTask, type TaskResult } from './run-task.ts'
import { selfCheck } from './selfcheck.ts'
import { EVAL_DIR, loadDeepScanSamples, loadTasks } from './tasks.ts'

const USAGE = `用法：
  pnpm eval selfcheck [--tasks t01,t02]
      不调用模型，检查题目本身：没改时隐藏测试失败，套上参考答案后全部通过
  pnpm eval run --config eval.config.json [--models a,b] [--tasks t01,t02] [--repeat 1] [--concurrency 2] [--deep-scan] [--out 目录]
      用配置里的模型跑题目，写出 results.json 和 report.md；--deep-scan 同时跑深度扫描准确率样例
  pnpm eval deep-scan --config eval.config.json [--models a] [--samples s01]
      只跑深度扫描准确率样例`

// 同时跑几道题；每道题一个 core 进程
async function pool<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

// 目录名用本机时间，和报告里的开始时间对得上
const stamp = (date: Date) => date.toLocaleString('sv-SE', { hour12: false }).replace(/[-:]/g, '').replace(' ', '-')
const list = (value: string | undefined) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined)

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: join(EVAL_DIR, 'eval.config.json') },
      models: { type: 'string' },
      tasks: { type: 'string' },
      samples: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '2' },
      'deep-scan': { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  })
  const command = positionals[0]

  if (command === 'selfcheck') {
    const tasks = loadTasks(list(values.tasks))
    const results = await pool(tasks, Number(values.concurrency), selfCheck)
    for (const result of results) console.log(`${result.ok ? '通过' : '失败'}  ${result.id}${result.detail ? `\n${result.detail}` : ''}`)
    const failed = results.filter((result) => !result.ok).length
    console.log(`\n${results.length - failed}/${results.length} 道题自检通过`)
    process.exitCode = failed > 0 ? 1 : 0
    return
  }

  if (command !== 'run' && command !== 'deep-scan') {
    console.log(USAGE)
    process.exitCode = command ? 1 : 0
    return
  }

  const config = loadConfig(values.config)
  const wanted = list(values.models)
  const models = wanted ? config.models.filter((model) => wanted.includes(model.name)) : config.models
  if (models.length === 0) throw new Error(`配置里没有这些模型：${wanted?.join('、')}`)
  const reviewer = config.reviewer ? (config.models.find((model) => model.name === config.reviewer) ?? null) : null
  if (config.reviewer && !reviewer) throw new Error(`评审模型 ${config.reviewer} 不在 models 里`)
  // 先确认密钥都在，免得每道题都因为同一个原因失败
  for (const model of reviewer ? [...models, reviewer] : models) apiKeyOf(model)

  const now = new Date()
  const startedAt = now.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' })
  const outDir = values.out ?? join(EVAL_DIR, 'results', `${stamp(now)}-${models.map((model) => model.name).join('+')}`)
  mkdirSync(outDir, { recursive: true })

  const taskResults: TaskResult[] = []
  if (command === 'run') {
    const tasks = loadTasks(list(values.tasks))
    const jobs = models.flatMap((model) => Array.from({ length: Number(values.repeat) }, (_, round) => tasks.map((task) => ({ task, model, round }))).flat())
    let done = 0
    taskResults.push(
      ...(await pool(jobs, Number(values.concurrency), async ({ task, model, round }) => {
        const result = await runTask(task, model, reviewer, join(outDir, 'runs', `${model.name}-${round + 1}`))
        done++
        console.log(`[${done}/${jobs.length}] ${model.name} ${task.id}：${result.passed ? '通过' : '失败'}（${result.usage.calls} 次模型调用，${Math.round(result.durationMs / 1000)} 秒）`)
        return result
      })),
    )
  }

  const scanResults: DeepScanResult[] = []
  if (command === 'deep-scan' || values['deep-scan']) {
    const samples = loadDeepScanSamples(list(values.samples))
    for (const model of models) {
      for (const sample of samples) {
        const result = await runDeepScanSample(sample, model, reviewer, join(outDir, 'runs', model.name))
        console.log(`深度扫描 ${model.name} ${sample.id}：查出 ${result.matched.length}/${result.answers}，误报 ${result.falsePositives.length}`)
        scanResults.push(result)
      }
    }
  }

  const report = writeReport(outDir, { startedAt, models: models.map((model) => model.name), reviewer: reviewer?.name ?? null }, taskResults, scanResults)
  console.log(`\n报告：${report}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
