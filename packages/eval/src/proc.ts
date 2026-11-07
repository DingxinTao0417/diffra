import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { EVAL_DIR } from './tasks.ts'

export const CORE_DIST = resolve(EVAL_DIR, '../core/dist')
// 输出只留最后这么多字，报告里够看出错在哪
const MAX_OUTPUT_CHARS = 8000

// 题目里的 Python 会打印中文：Windows 英文系统（比如 CI）往管道输出默认用 cp1252，打印中文直接报错。
// 评测跑的所有命令（检查、隐藏测试、智能体所在的 core 进程）统一用 UTF-8，结果不随机器的语言变
export const EVAL_ENV: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }

export interface RunResult {
  exitCode: number | null
  timedOut: boolean
  output: string
}

// 跑一个命令，合并 stdout 和 stderr，超时就结束它
export function run(file: string, args: string[], options: { cwd: string; timeoutSeconds: number; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? EVAL_ENV, windowsHide: true })
    let output = ''
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS * 2)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, options.timeoutSeconds * 1000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: null, timedOut, output: `${output}\n${error.message}`.slice(-MAX_OUTPUT_CHARS) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ exitCode: code, timedOut, output: output.slice(-MAX_OUTPUT_CHARS) })
    })
  })
}

// 检查命令和任务里一样用 Git Bash 跑
let bashPath: Promise<string | null> | null = null
export function findBash(): Promise<string | null> {
  if (!bashPath) {
    bashPath = import(pathToFileURL(join(CORE_DIST, 'environment.js')).href).then((module: { findBash(): Promise<string | null> }) => module.findBash())
  }
  return bashPath
}

export async function runShell(command: string, cwd: string, timeoutSeconds: number): Promise<RunResult> {
  const bash = await findBash()
  if (!bash) throw new Error('没找到 Git Bash，跑不了检查命令')
  return run(bash, ['-c', command], { cwd, timeoutSeconds })
}
