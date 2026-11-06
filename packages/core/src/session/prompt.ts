import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RulePack, SessionChecks, SessionConfig } from '../protocol.js'
import { renderRules } from '../rules/select.js'

// 项目里的规则文件，按顺序都读，合计最多 8000 字
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md']
const MAX_RULES_CHARS = 8000

// 提示词用英文：弱模型对英文指令的遵循度更稳定；回复语言跟随用户
export async function buildSystemPrompt(
  cwd: string,
  bashPath: string | null,
  { checks, readOnlyPaths, rules }: Pick<SessionConfig, 'checks' | 'readOnlyPaths' | 'rules'>,
  rulePacks: RulePack[],
): Promise<string> {
  const shell = bashPath
    ? 'run_command uses bash (Git Bash on Windows): use bash syntax and forward slashes.'
    : 'run_command is unavailable because bash was not found.'
  const lines = [
    'You are Diffra, a coding agent working in the user\'s project.',
    `Project directory: ${cwd}`,
    `Operating system: ${process.platform === 'win32' ? 'Windows' : process.platform}. ${shell}`,
    '',
    'How to work:',
    '- Explore before you edit: use list_files, search and read_file. Never guess what a file contains.',
    '- Read a file before editing it. Make small, focused edits with edit_file, copying old_string exactly from read_file output (without line numbers).',
    '- Only change files inside the project directory.',
    '- Files that may contain secrets (.env, private keys, credential files such as .npmrc) are protected: you cannot read, search or edit them. If you need something from them, ask the user.',
    ...(readOnlyPaths.length > 0
      ? [`- Never modify anything under these paths, they hold the user's data: ${readOnlyPaths.join(', ')}. Reading them is fine.`]
      : []),
    '- Do not weaken tests to make them pass: no deleting or skipping tests, no catch-all exception handling, no hard-coded expected values, unless the user asks for it.',
    ...checkLines(checks),
    '- If the user only asked a question and you changed nothing, just answer without calling finish.',
    '- Reply in the same language the user writes in.',
  ]
  const projectRules = await readProjectRules(cwd)
  if (projectRules) lines.push('', 'Project rules from the repository (follow them):', projectRules)
  lines.push(...codingRuleLines(rulePacks, rules.review))
  return lines.join('\n')
}

// 编码规范排在项目规则之后，并写明优先级更低；只约束这次写或改的代码，免得模型顺手大改旧代码
function codingRuleLines(rulePacks: RulePack[], review: boolean): string[] {
  const { text, omitted } = renderRules(rulePacks)
  if (!text) return []
  return [
    '',
    "Coding rules (written in Chinese; each starts with its rule ID). They rank below the user's instructions and the project rules: when they conflict, follow those. " +
      'Apply them to the code you write or change; do not rewrite unrelated existing code just to satisfy them.',
    ...(review ? ['When you call finish, a reviewer checks your changes against these rules and reports violations by rule ID.'] : []),
    text,
    ...(omitted > 0 ? [`(${omitted} more rules were left out to save space.)`] : []),
  ]
}

// 告诉模型哪些检查会自动跑，免得它自己再跑一遍、还多弹一次权限确认
function checkLines(checks: SessionChecks): string[] {
  const finishCheck = checks.beforeFinish ?? checks.afterEdit
  const lines: string[] = []
  if (checks.afterEdit) {
    lines.push(
      `- After every step in which you edit files, Diffra automatically runs \`${checks.afterEdit}\` and tells you if it fails. Do not run it yourself.`,
    )
  } else {
    lines.push('- After changing code, verify it, for example by running the relevant tests with run_command.')
  }
  if (finishCheck) {
    lines.push(
      `- When the task is done, call finish with a short summary. If you changed files, Diffra then runs \`${finishCheck}\`; if it fails, fix the problems and call finish again.`,
    )
  } else {
    lines.push('- When the task is done, call finish with a short summary. No project checks are configured, so make sure you verified your changes.')
  }
  return lines
}

async function readProjectRules(cwd: string): Promise<string> {
  const parts: string[] = []
  for (const name of RULE_FILES) {
    const text = await readFile(join(cwd, name), 'utf8').catch(() => null)
    if (text?.trim()) parts.push(`--- ${name} ---\n${text.trim()}`)
  }
  const joined = parts.join('\n\n')
  return joined.length > MAX_RULES_CHARS ? `${joined.slice(0, MAX_RULES_CHARS)}\n... (truncated)` : joined
}
