import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { apiKeyOf, type EvalConfig, loadConfig } from './config.ts'
import { type DeepScanResult, runDeepScanSample } from './deep-scan.ts'
import { writeReport } from './report.ts'
import { copyProject, probeTask } from './probe.ts'
import { runTask, type TaskResult } from './run-task.ts'
import { selfCheck } from './selfcheck.ts'
import { EVAL_DIR, type EvalTask, loadDeepScanSamples, loadTasks } from './tasks.ts'

const USAGE = `用法：
  pnpm eval selfcheck [--tasks t01,t02]
      不调用模型，检查题目本身：没改时隐藏测试失败，套上参考答案后全部通过
  pnpm eval run --config eval.config.json [--models a,b] [--tasks t01,t02] [--category redteam,instruction] [--repeat 1] [--concurrency 2] [--deep-scan] [--out 目录]
      用配置里的模型跑题目，写出 results.json 和 report.md，每道题的过程记录在 runs/ 下的 transcript.md；--deep-scan 同时跑深度扫描准确率样例
  pnpm eval probe --project 目录 (--prompt 需求 | --script 脚本.json) [--goal] [--models a] [--out 目录]
      拿任意项目（复制一份，原目录不动）、任意需求跑一次，写出过程记录；脚本和 task.json 一样的写法，可以写多轮、提问怎么答、明确要求
  通用：--permission-mode ask|auto|full 覆盖题目的权限档；--effort low|medium|high|xhigh 覆盖模型的思考强度；--goal 第一轮用目标模式
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
      category: { type: 'string' },
      project: { type: 'string' },
      prompt: { type: 'string' },
      script: { type: 'string' },
      goal: { type: 'boolean', default: false },
      'permission-mode': { type: 'string' },
      effort: { type: 'string' },
      'runs-dir': { type: 'string' },
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

  if (command !== 'run' && command !== 'deep-scan' && command !== 'probe') {
    console.log(USAGE)
    process.exitCode = command ? 1 : 0
    return
  }

  const config = loadConfig(values.config)
  const wanted = list(values.models)
  const effort = values.effort as EvalConfig['models'][number]['reasoningEffort'] | undefined
  const models = (wanted ? config.models.filter((model) => wanted.includes(model.name)) : config.models).map((model) => (effort ? { ...model, reasoningEffort: effort } : model))
  const permissionMode = values['permission-mode'] as EvalTask['permissionMode'] | undefined
  if (permissionMode && !['ask', 'auto', 'full'].includes(permissionMode)) throw new Error(`--permission-mode 只能是 ask、auto、full`)
  // --goal：所有题第一轮都用目标模式（自己多轮推进），看模型一轮做不完时能不能自己做完
  const withMode = (task: EvalTask): EvalTask => ({ ...task, ...(permissionMode ? { permissionMode } : {}), ...(values.goal ? { goal: true } : {}) })
  if (models.length === 0) throw new Error(`配置里没有这些模型：${wanted?.join('、')}`)
  const reviewer = config.reviewer ? (config.models.find((model) => model.name === config.reviewer) ?? null) : null
  if (config.reviewer && !reviewer) throw new Error(`评审模型 ${config.reviewer} 不在 models 里`)
  // 先确认密钥都在，免得每道题都因为同一个原因失败
  for (const model of reviewer ? [...models, reviewer] : models) apiKeyOf(model)

  const now = new Date()
  const startedAt = now.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' })
  // 一律转成绝对路径：core 拿检查点目录在项目目录里跑 git，相对路径会解析到项目里面去
  const outDir = values.out ? resolve(values.out) : join(EVAL_DIR, 'results', `${stamp(now)}-${models.map((model) => model.name).join('+')}`)
  mkdirSync(outDir, { recursive: true })
  // 题目项目放在 Diffra 仓库外面：放在仓库里的话，智能体顺着路径往上找就能翻到题目的隐藏测试和参考答案（攻击题 r05 里真翻过）
  const runsDir = values['runs-dir'] ? resolve(values['runs-dir']) : join(process.env.DIFFRA_EVAL_RUNS_DIR ?? join(tmpdir(), 'diffra-eval-runs'), basename(outDir))
  mkdirSync(runsDir, { recursive: true })
  console.log(`题目项目放在 ${runsDir}`)

  const taskResults: TaskResult[] = []
  if (command === 'probe') {
    if (!values.project || (!values.prompt && !values.script)) throw new Error('probe 要写 --project，以及 --prompt 或 --script')
    const project = resolve(values.project)
    const base = probeTask(project, values.prompt, values.script)
    const task = withMode(base)
    for (const model of models) {
      const runDir = join(runsDir, model.name)
      const workDir = join(runDir, task.id, 'project')
      const copied = await copyProject(project, workDir)
      console.log(`复制了 ${copied >= 0 ? `${copied} 个文件` : '整个目录'}到 ${workDir}`)
      const result = await runTask(task, model, reviewer, runDir, { workDir })
      console.log(`${model.name}：${result.stopReason ?? '没有结束原因'}，${result.usage.calls} 次模型调用，${Math.round(result.durationMs / 1000)} 秒，改了 ${result.changedFiles.length} 个文件`)
      for (const item of result.constraints) console.log(`  ${item.ok ? '做到' : '没做到'}  ${item.note}${item.detail ? `：${item.detail}` : ''}`)
      if (result.error) console.log(`  出错：${result.error}`)
      console.log(`  过程记录：${result.transcript}`)
      taskResults.push(result)
    }
  }

  if (command === 'run') {
    const tasks = loadTasks(list(values.tasks)).filter((task) => !values.category || list(values.category)?.includes(task.category)).map(withMode)
    const jobs = models.flatMap((model) => Array.from({ length: Number(values.repeat) }, (_, round) => tasks.map((task) => ({ task, model, round }))).flat())
    let done = 0
    taskResults.push(
      ...(await pool(jobs, Number(values.concurrency), async ({ task, model, round }) => {
        const result = await runTask(task, model, reviewer, join(runsDir, `${model.name}-${round + 1}`))
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
        const result = await runDeepScanSample(sample, model, reviewer, join(runsDir, model.name))
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
