import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

export const EVAL_DIR = resolve(import.meta.dirname, '..')
export const TASKS_DIR = join(EVAL_DIR, 'tasks')
export const DEEP_SCAN_DIR = join(EVAL_DIR, 'deep-scan')

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(['feature', 'bugfix', 'multi-file', 'refactor', 'security', 'protection', 'gate', 'rules', 'delegation']),
  language: z.enum(['ts', 'python']),
  // 像真实用户那样提需求
  prompt: z.string().min(1),
  // 给智能体的检查命令（在 Git Bash 里跑），和项目设置里填的一样
  checks: z.object({ afterEdit: z.string().nullable(), beforeFinish: z.string().nullable() }),
  readOnlyPaths: z.array(z.string()).default([]),
  // 开不开完成前的规范审查；规则包总是按应用的默认值带上（内置包、只放强制级）
  review: z.boolean().default(false),
  security: z.object({ staticCheck: z.boolean(), lightScan: z.boolean() }).default({ staticCheck: true, lightScan: true }),
  // 还要确认的命令怎么答：允许一次，或者拒绝
  permission: z.enum(['allow', 'reject']).default('allow'),
  // 隐藏测试：跑完后把 hidden/ 放进项目根目录的 hidden/ 再执行，退出码 0 算通过
  hidden: z.object({ command: z.array(z.string()).min(1), timeoutSeconds: z.number().int().positive().default(120) }),
  // 跑完后必须和原来一模一样的文件（相对项目根目录）
  unchanged: z.array(z.string()).default([]),
  // 不能出现在对话里的字符串（比如 .env 里的密钥）
  secrets: z.array(z.string()).default([]),
  // 一轮任务最长跑多久
  timeoutMinutes: z.number().positive().default(15),
  // 这道题该不该派子智能体：expected 是要先在很多文件里摸清情况的题，unexpected 是自己几步就能做完的题。只用来统计，不影响判分
  delegate: z.enum(['expected', 'unexpected']).optional(),
})

export type EvalTask = z.infer<typeof taskSchema> & { dir: string }

export function loadTasks(ids?: string[]): EvalTask[] {
  const all = readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(TASKS_DIR, entry.name, 'task.json')))
    .map((entry) => {
      const dir = join(TASKS_DIR, entry.name)
      const parsed = taskSchema.safeParse(JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')))
      if (!parsed.success) throw new Error(`题目 ${entry.name} 的 task.json 不对：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`)
      if (parsed.data.id !== entry.name) throw new Error(`题目目录 ${entry.name} 和 id ${parsed.data.id} 不一致`)
      return { ...parsed.data, dir }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  if (!ids || ids.length === 0) return all
  const missing = ids.filter((id) => !all.some((task) => task.id === id || task.id.startsWith(`${id}-`)))
  if (missing.length > 0) throw new Error(`没有这些题目：${missing.join('、')}`)
  return all.filter((task) => ids.some((id) => task.id === id || task.id.startsWith(`${id}-`)))
}

const locationSchema = z.object({ path: z.string(), line: z.number().int().positive() })

const answerSchema = locationSchema.extend({
  ruleId: z.string(),
  note: z.string(),
  // 同样合理的其他修复位置，比如越权既可以在路由里校验归属，也可以在查询里按当前用户过滤
  alternatives: z.array(locationSchema).default([]),
})

export interface DeepScanSample {
  id: string
  dir: string
  answers: z.infer<typeof answerSchema>[]
}

// 深度扫描的样例项目：repo/ 是代码，answers.json 是埋好的漏洞
export function loadDeepScanSamples(ids?: string[]): DeepScanSample[] {
  return readdirSync(DEEP_SCAN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (!ids || ids.length === 0 || ids.some((id) => entry.name === id || entry.name.startsWith(`${id}-`))))
    .map((entry) => {
      const dir = join(DEEP_SCAN_DIR, entry.name)
      const answers = z.array(answerSchema).parse(JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8')))
      return { id: entry.name, dir, answers }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}
