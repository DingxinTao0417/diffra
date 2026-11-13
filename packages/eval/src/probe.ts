import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { gitOutput } from './proc.ts'
import { type EvalTask, probeScriptSchema } from './tasks.ts'

// probe（第 616 步）：拿任意项目、任意需求跑 Diffra。项目复制一份再跑，原目录不动：
// Git 仓库只复制跟踪的和没被忽略的新文件（不带 node_modules、构建产物），不是 Git 仓库就整个复制但跳过 node_modules 和 .git。
// 需求可以直接写，也可以写成和题目一样格式的脚本（多轮、目标模式、权限档、提问怎么答、明确要求）
export async function copyProject(source: string, target: string): Promise<number> {
  mkdirSync(target, { recursive: true })
  if (!existsSync(join(source, '.git'))) {
    cpSync(source, target, { recursive: true, filter: (path) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(path.slice(source.length)) })
    return -1
  }
  const files = (await gitOutput(source, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  for (const file of files) {
    const from = join(source, file)
    if (!existsSync(from)) continue
    const to = join(target, file)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
  return files.length
}

// 把 probe 的参数拼成一道没有隐藏测试的题
export function probeTask(project: string, prompt: string | undefined, scriptPath: string | undefined): EvalTask {
  const script = scriptPath ? probeScriptSchema.parse(JSON.parse(readFileSync(scriptPath, 'utf8'))) : probeScriptSchema.parse({ prompt })
  const name = basename(resolve(project))
  return {
    ...script,
    id: script.id ?? `probe-${name}`,
    title: script.title ?? `${name}：${script.prompt.slice(0, 40)}`,
    category: script.category ?? 'feature',
    language: script.language ?? 'ts',
    checks: script.checks ?? { afterEdit: null, beforeFinish: null },
    hidden: undefined,
    dir: resolve(project),
  }
}
