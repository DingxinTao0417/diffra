import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Windows 上不能用 PATH 里的 bash：C:\Windows\System32\bash.exe 是 WSL 的入口。
// 从 git.exe 的位置往上找 Git for Windows 自带的 bin\bash.exe。
export async function findBash(): Promise<string | null> {
  if (process.env.DIFFRA_BASH_PATH) return process.env.DIFFRA_BASH_PATH
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : null

  const candidates: string[] = []
  try {
    const { stdout } = await execFileAsync('where.exe', ['git'], { timeout: 5000, windowsHide: true })
    for (const line of stdout.split(/\r?\n/)) {
      let dir = dirname(line.trim())
      for (let level = 0; level < 3 && line.trim(); level++) {
        candidates.push(join(dir, 'bin', 'bash.exe'))
        dir = dirname(dir)
      }
    }
  } catch {
    // PATH 里没有 git 时 where.exe 返回非 0，继续看默认安装位置
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe')
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// 打进桌面端以后 @vscode/ripgrep 找不到自己的平台包，由主进程通过 DIFFRA_RG_PATH 传入
export async function findRipgrep(): Promise<string> {
  if (process.env.DIFFRA_RG_PATH) return process.env.DIFFRA_RG_PATH
  const { rgPath } = await import('@vscode/ripgrep')
  return rgPath
}
