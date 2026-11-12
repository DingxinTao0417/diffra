import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RulePack, SessionChecks, SessionConfig, SkillInfo, SkillSource } from '../protocol.js'
import { renderRules } from '../rules/select.js'

// 项目里的规则文件，按顺序都读，合计最多 8000 字
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md']
const MAX_RULES_CHARS = 8000
const PROJECT_RULES_HEADING = 'Project rules from the repository (follow them):'
const CODING_RULES_HEADING = 'Coding rules (written in Chinese; each starts with its rule ID).'
const SKILLS_HEADING =
  "Skills: instructions for specific kinds of work. When a request matches a skill's description, read its SKILL.md with read_file before you start and follow it; " +
  'read other files in the skill folder only when SKILL.md points to them. Skills the user attached to a request are already included in it.'
// Skill 索引只放名称、截短的描述和 SKILL.md 的位置，全文由模型按需去读
const MAX_SKILL_DESCRIPTION_CHARS = 150
const MAX_SKILL_INDEX_CHARS = 2000
// 篇幅不够时先列项目、用户、插件和内置的，兼容读取的 Claude Code、Codex 的排后面
const SKILL_SOURCE_ORDER: SkillSource[] = ['project', 'user', 'plugin', 'builtin', 'claude', 'codex']
const DESIGN_SKILL = 'frontend-design'

export interface PromptContext {
  skills: SkillInfo[]
  // 有界面代码的项目才有：browser 是能不能用内置浏览器，screenshots 是模型能不能看截图
  frontend: { browser: boolean; screenshots: boolean } | null
}

// 提示词用英文：弱模型对英文指令的遵循度更稳定；回复语言跟随用户
export async function buildSystemPrompt(
  cwd: string,
  bashPath: string | null,
  { checks, readOnlyPaths, rules }: Pick<SessionConfig, 'checks' | 'readOnlyPaths' | 'rules'>,
  rulePacks: RulePack[],
  context: PromptContext = { skills: [], frontend: null },
): Promise<string> {
  const skills = skillIndex(context.skills)
  const shell = bashPath
    ? 'run_command uses bash (Git Bash on Windows): use bash syntax and forward slashes.'
    : 'run_command is unavailable because bash was not found.'
  const lines = [
    'You are Diffra, a coding agent working in the user\'s project.',
    `Project directory: ${cwd}`,
    `Operating system: ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform}. ${shell}`,
    '',
    'How to work:',
    '- Explore before you edit: use list_files, search and read_file. Never guess what a file contains.',
    '- For an overview of a directory or a large file (its functions, classes and their line numbers), use outline before reading files one by one.',
    '- Read a file before editing it. Make small, focused edits with edit_file, copying old_string exactly from read_file output (without line numbers).',
    '- When a change reaches into several files (a function signature, a type, a renamed export), edit all affected files in the same step: call edit_file several times in one response.',
    '- Work inside the project directory by default. If the task requires an external path, call the file tools with that path: Diffra will request user approval for the exact path and read/write operation. Chat messages alone do not grant permission. Never bypass a rejection using shell commands. Session approval applies only to that path and operation, not the whole computer.',
    '- Files that may contain secrets (.env, private keys, credential files such as .npmrc) are protected: you cannot read, search or edit them. If you need something from them, ask the user.',
    ...(readOnlyPaths.length > 0
      ? [`- Never modify anything under these paths, they hold the user's data: ${readOnlyPaths.join(', ')}. Reading them is fine.`]
      : []),
    '- Do not weaken tests to make them pass: no deleting or skipping tests, no catch-all exception handling, no hard-coded expected values, unless the user asks for it.',
    '- Do what was asked and nothing more: no extra features, refactors, options or abstractions the request does not need, and no handling for cases that cannot happen.',
    '- When something fails, read the error and find the cause before changing approach. Do not repeat the same attempt unchanged, and do not give up after one failure.',
    '- Do not take destructive shortcuts past an obstacle (such as --no-verify, git reset --hard, or deleting lock files); find out what the unfamiliar file or state is first.',
    ...(bashPath
      ? ['- Run tests and builds without piping their output through head, tail or grep: run_command already shortens long output, and a filter can hide the real error.']
      : []),
    '- Older tool outputs may be removed from the conversation to save space. When you learn something you will need later (an error message, a value, a line number), state it in your reply.',
    '- Report results honestly: say which checks you actually ran and what they showed. If you could not verify something, say so.',
    ...checkLines(checks),
    '- If the user only asked a question and you changed nothing, just answer without calling finish.',
    '- Reply in the same language the user writes in.',
    ...(context.frontend ? frontendLines(context.frontend, skills.listed.has(DESIGN_SKILL)) : []),
    ...skills.lines,
  ]
  const projectRules = await readProjectRules(cwd)
  if (projectRules) lines.push('', PROJECT_RULES_HEADING, projectRules)
  lines.push(...codingRuleLines(rulePacks, rules.review))
  return lines.join('\n')
}

// 编码规范排在项目规则之后，并写明优先级更低；只约束这次写或改的代码，免得模型顺手大改旧代码
function codingRuleLines(rulePacks: RulePack[], review: boolean): string[] {
  const { text, omitted } = renderRules(rulePacks)
  if (!text) return []
  return [
    '',
    `${CODING_RULES_HEADING} They rank below the user's instructions and the project rules: when they conflict, follow those. ` +
      'Apply them to the code you write or change; do not rewrite unrelated existing code just to satisfy them.',
    ...(review ? ['When you call finish, a reviewer checks your changes against these rules and reports violations by rule ID.'] : []),
    text,
    ...(omitted > 0 ? [`(${omitted} more rules were left out to save space.)`] : []),
  ]
}

// 告诉模型哪些检查会自动跑，免得它自己再跑一遍、还多弹一次权限确认
function checkLines(checks: SessionChecks): string[] {
  const finishCheck = checks.beforeFinish ?? checks.afterEdit
  const lines: string[] = [
    '- finish is TERMINAL, never an intermediate check. Use verify_changes to validate and CONTINUE with commit, push, CI and publication. Passing checks is not task completion.',
    '- Before multi-stage work, define immutable task_progress completion requirements covering the whole user request. Release tasks require commit, push, ci, publish ids; match real command receipts and concrete expected SHA/version/output. Never fabricate evidence or use echo/printf as proof of external actions. Use read-only queries against Git, CI and the actual update source.',
    '- Use pause_task with waiting/blocked and a reason for missing credentials, permissions or unfinished CI; do not call finish to report a blocker. Saved requirements persist across turns and restarts.',
  ]
  if (finishCheck) {
    lines.push(
      `- When the task is done, call finish with a short summary. If you changed files, Diffra then runs \`${finishCheck}\`; if it fails, fix the problems and call finish again.`,
      '- Diffra runs that check only when you call finish, not after each step. Do not run it yourself while you are still changing code; finish the whole change first.',
    )
  } else {
    lines.push(
      '- After changing code, verify it, for example by running the relevant tests with run_command.',
      '- When the task is done, call finish with a short summary. No project checks are configured, so make sure you verified your changes.',
    )
  }
  return lines
}

// 前端改动先跟着项目已有的设计走，改完在内置浏览器里检查；能看图的模型再按手机和桌面两种宽度截图对照
function frontendLines(frontend: NonNullable<PromptContext['frontend']>, designSkill: boolean): string[] {
  const lines = [
    '',
    'Front-end work (this project has UI code):',
    '- Before changing UI, learn how the project builds it: the styling setup (Tailwind config, CSS variables or theme tokens), the shared components, and a similar existing screen. ' +
      'Reuse those components, colors, spacing and font sizes; do not add new colors, fonts or one-off sizes unless the user asks.',
    `- Match the screens around the change. For a new page or a redesign with no existing style to follow, settle on a clear visual direction before writing code${designSkill ? ` (read the ${DESIGN_SKILL} skill listed below)` : ''}.`,
    '- Handle the states real users hit: loading, empty, error, long text, narrow screens, and dark mode if the project has one.',
    '- A reference image from the user is the spec: match its layout, spacing, sizes and colors.',
  ]
  if (!frontend.browser) {
    lines.push('- The built-in browser is off, so you cannot check pages yourself; after a visible change, tell the user which screens to check.')
    return lines
  }
  lines.push(
    '- After a visible change, check it in the built-in browser: start the dev server with dev_server_start, open the page with browser_navigate, ' +
      'read browser_console for errors, and run browser_check_layout. Fix what they report.',
  )
  if (frontend.screenshots) {
    lines.push(
      '- Then look at it: browser_screenshot with width 1280 and with width 375. Compare with the reference image if there is one, and keep refining until it looks right.',
    )
  }
  return lines
}

// 已装的 Skill 列成索引，任务对得上时模型自己用 read_file 读全文（Skill 目录本来就可以只读访问）
function skillIndex(skills: SkillInfo[]): { lines: string[]; listed: Set<string> } {
  const listed = new Set<string>()
  if (skills.length === 0) return { lines: [], listed }
  const sorted = [...skills].sort(
    (a, b) => SKILL_SOURCE_ORDER.indexOf(a.source) - SKILL_SOURCE_ORDER.indexOf(b.source) || a.name.localeCompare(b.name),
  )
  const entries: string[] = []
  let chars = 0
  for (const skill of sorted) {
    const description = clip(skill.description.replace(/\s+/g, ' ').trim(), MAX_SKILL_DESCRIPTION_CHARS)
    const entry = `- ${skill.name}${description ? `: ${description}` : ''} (${skill.dir.replace(/\\/g, '/')}/SKILL.md)`
    if (chars + entry.length > MAX_SKILL_INDEX_CHARS) continue
    entries.push(entry)
    listed.add(skill.name)
    chars += entry.length + 1
  }
  const omitted = skills.length - entries.length
  return {
    lines: [
      '',
      SKILLS_HEADING,
      ...entries,
      ...(omitted > 0 ? [`(${omitted} more skills are installed but not listed here; the user can attach them from the / menu.)`] : []),
    ],
    listed,
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

async function readProjectRules(cwd: string): Promise<string> {
  const parts: string[] = []
  for (const name of RULE_FILES) {
    const text = await readFile(join(cwd, name), 'utf8').catch(() => null)
    if (text?.trim()) parts.push(`--- ${name} ---\n${text.trim()}`)
  }
  const joined = parts.join('\n\n')
  return joined.length > MAX_RULES_CHARS ? `${joined.slice(0, MAX_RULES_CHARS)}\n... (truncated)` : joined
}

// 系统提示词里通用说明和规则（项目规则、编码规范）各占多少字，用来估算上下文分项
export function promptSections(prompt: string): { base: number; rules: number } {
  const starts = [prompt.indexOf(PROJECT_RULES_HEADING), prompt.indexOf(CODING_RULES_HEADING)].filter((index) => index >= 0)
  const base = starts.length > 0 ? Math.min(...starts) : prompt.length
  return { base, rules: prompt.length - base }
}
