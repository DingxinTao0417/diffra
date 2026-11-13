import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

export const EVAL_DIR = resolve(import.meta.dirname, '..')
export const TASKS_DIR = join(EVAL_DIR, 'tasks')
export const DEEP_SCAN_DIR = join(EVAL_DIR, 'deep-scan')

// 判定一条明确的要求有没有做到（第 618 步）：source 是这条要求从哪来的，按来源分组统计遵循率
const constraintBase = {
  id: z.string().min(1),
  source: z.enum(['prompt', 'follow-up', 'agents-root', 'agents-sub', 'implicit']),
  // 报告里写给人看的要求原意
  note: z.string().min(1),
}
// pattern 是正则；路径都相对项目根目录，用 / 分隔，写目录就是这个目录下的全部
export const constraintSchema = z.discriminatedUnion('kind', [
  // 只能改这些路径
  z.object({ ...constraintBase, kind: z.literal('only-change'), paths: z.array(z.string().min(1)).min(1) }),
  // 这些路径不能动
  z.object({ ...constraintBase, kind: z.literal('no-change'), paths: z.array(z.string().min(1)).min(1) }),
  // 一个文件都不能改
  z.object({ ...constraintBase, kind: z.literal('no-edits') }),
  // 不能跑匹配的命令 / 必须跑过匹配的命令
  z.object({ ...constraintBase, kind: z.literal('no-command'), pattern: z.string().min(1) }),
  z.object({ ...constraintBase, kind: z.literal('command'), pattern: z.string().min(1) }),
  // 最后一轮的回复必须（absent 时是不能）匹配
  z.object({ ...constraintBase, kind: z.literal('reply'), pattern: z.string().min(1), absent: z.boolean().default(false) }),
  // 最后一轮的回复和过程说明用的语言
  z.object({ ...constraintBase, kind: z.literal('reply-language'), language: z.enum(['zh', 'en']) }),
  // 跑完后这个文件的内容必须（absent 时是不能）匹配
  z.object({ ...constraintBase, kind: z.literal('file'), path: z.string().min(1), pattern: z.string().min(1), absent: z.boolean().default(false) }),
  // 这次新增的代码行（只看 paths 下，不写是全部）不能匹配
  z.object({ ...constraintBase, kind: z.literal('added-lines'), pattern: z.string().min(1), paths: z.array(z.string().min(1)).default([]) }),
  // 不能自己提交
  z.object({ ...constraintBase, kind: z.literal('no-commit') }),
  // 该问的要问（expected: true），不该问的别问
  z.object({ ...constraintBase, kind: z.literal('question'), expected: z.boolean() }),
])
export type Constraint = z.infer<typeof constraintSchema>

// 后面几轮用户说的话；cancelAfterSeconds：这一轮开始后这么久用户点停止（测中途改主意）
const turnSchema = z.object({
  text: z.string().min(1),
  goal: z.boolean().default(false),
  cancelAfterSeconds: z.number().positive().optional(),
})

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(['feature', 'bugfix', 'multi-file', 'refactor', 'security', 'protection', 'gate', 'rules', 'delegation', 'redteam', 'instruction', 'language', 'large']),
  language: z.enum(['ts', 'python']),
  // 像真实用户那样提需求
  prompt: z.string().min(1),
  // 第一轮用目标模式；第一轮开始后这么久用户点停止
  goal: z.boolean().default(false),
  cancelAfterSeconds: z.number().positive().optional(),
  // 后面几轮：上一轮结束后接着说
  followUps: z.array(turnSchema).default([]),
  // 给智能体的检查命令（在 Git Bash 里跑），和项目设置里填的一样
  checks: z.object({ afterEdit: z.string().nullable(), beforeFinish: z.string().nullable() }),
  readOnlyPaths: z.array(z.string()).default([]),
  // 开不开完成前的规范审查；规则包总是按应用的默认值带上（内置包、只放强制级）
  review: z.boolean().default(false),
  security: z.object({ staticCheck: z.boolean(), lightScan: z.boolean() }).default({ staticCheck: true, lightScan: true }),
  // 命令权限档，和设置里的一样；评测默认 auto
  permissionMode: z.enum(['ask', 'auto', 'full']).default('auto'),
  // 还要确认的命令怎么答：允许一次，或者拒绝
  permission: z.enum(['allow', 'reject']).default('allow'),
  // 智能体提问时按顺序怎么答：选标签匹配这个正则的选项（同一个意思写几种说法，比如「支付|付款」）；没写或对不上就选第一个
  answers: z.array(z.string()).default([]),
  // 隐藏测试：跑完后把 hidden/ 放进项目根目录的 hidden/ 再执行，退出码 0 算通过。只考指令遵循、不考代码的题可以不写
  hidden: z.object({ command: z.array(z.string()).min(1), timeoutSeconds: z.number().int().positive().default(120) }).optional(),
  // 跑完后必须和原来一模一样的文件（相对项目根目录）
  unchanged: z.array(z.string()).default([]),
  // 不能出现在对话里的字符串（比如 .env 里的密钥）
  secrets: z.array(z.string()).default([]),
  // 放在项目外面（和项目目录同级的 outside/ 下）的哨兵文件：跑完必须原样还在。题目文件和需求里写 {{OUTSIDE_DIR}} 指向那里
  outside: z.record(z.string(), z.string()).default({}),
  // 用户还没提交的改动：题目的初始提交之后再写进去（相对项目根目录 → 内容）。智能体不该把它们冲掉；内容没变就不算智能体的改动
  dirty: z.record(z.string(), z.string()).default({}),
  // 可判定的明确要求
  constraints: z.array(constraintSchema).default([]),
  // 改小模型的上下文窗口（token），逼出上下文压缩
  contextWindow: z.number().int().positive().optional(),
  // 一轮任务最长跑多久（多轮的题是全部轮次加起来）
  timeoutMinutes: z.number().positive().default(15),
  // 这道题该不该派子智能体：expected 是要先在很多文件里摸清情况的题，unexpected 是自己几步就能做完的题。只用来统计，不影响判分
  delegate: z.enum(['expected', 'unexpected']).optional(),
})

// probe 的脚本：和题目一样的写法，只是不需要 id、标题、类别、隐藏测试
export const probeScriptSchema = taskSchema.partial({ id: true, title: true, category: true, language: true, checks: true })

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
