import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillInfo, SkillSource } from './protocol.js'

// 一个 Skill 是一个目录，里面的 SKILL.md 开头是 YAML frontmatter（name、description），后面是给模型的说明。
// 和 Claude Code、Codex 的格式一样，所以那边装好的 Skill 直接能用
const SKILL_FILE = 'SKILL.md'
const MAX_SKILL_BYTES = 200_000
const MAX_SKILLS = 300

export interface SkillRoot {
  source: SkillSource
  dir: string
}

// 按优先级排：同名的 Skill 只认排在前面的。内置的排最后，用户自己装了同名的就用用户的
export function skillRoots(cwd: string, extra: SkillRoot[] = []): SkillRoot[] {
  const home = homedir()
  return [
    { source: 'project', dir: join(cwd, '.diffra', 'skills') },
    { source: 'user', dir: join(home, '.diffra', 'skills') },
    ...extra,
    { source: 'claude', dir: join(home, '.claude', 'skills') },
    { source: 'codex', dir: join(home, '.codex', 'skills') },
    { source: 'builtin', dir: builtinSkillsDir() },
  ]
}

// 桌面端把 core 打进 out/main/core.js，内置 Skill 随安装包放在 resources/skills，由主进程通过 DIFFRA_SKILLS_DIR 传进来；
// 直接跑 core 的源码或构建产物时就是 core 包里的 skills 目录
function builtinSkillsDir(): string {
  return process.env.DIFFRA_SKILLS_DIR || fileURLToPath(new URL('../skills', import.meta.url))
}

export interface Skill extends SkillInfo {
  body: string
}

// 只认这里用到的两种写法：key: value（可加引号），以及 key: | 或 key: > 加缩进的多行文字
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { fields: {}, body: normalized }
  const fields: Record<string, string> = {}
  const lines = (match[1] ?? '').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!field) continue
    const key = field[1] ?? ''
    const value = (field[2] ?? '').trim()
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = []
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1] ?? '') || (lines[index + 1] ?? '') === '')) {
        block.push((lines[++index] ?? '').trim())
      }
      fields[key] = value.startsWith('>') ? block.filter(Boolean).join(' ') : block.join('\n').trim()
    } else {
      fields[key] = value.replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return { fields, body: normalized.slice(match[0].length) }
}

async function readSkill(root: SkillRoot, name: string): Promise<Skill | null> {
  const dir = join(root.dir, name)
  const file = join(dir, SKILL_FILE)
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size > MAX_SKILL_BYTES) return null
  const { fields, body } = parseFrontmatter(await readFile(file, 'utf8'))
  return {
    name: fields.name?.trim() || name,
    description: fields.description?.trim() ?? '',
    source: root.source,
    dir,
    body: body.trim(),
  }
}

export async function loadSkills(roots: SkillRoot[]): Promise<Skill[]> {
  const skills = new Map<string, Skill>()
  for (const root of roots) {
    const entries = await readdir(root.dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || skills.size >= MAX_SKILLS) continue
      const skill = await readSkill(root, entry.name)
      if (skill && !skills.has(skill.name)) skills.set(skill.name, skill)
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// 用户在输入框里选了 Skill：把说明放在这一轮的提问前面，模型照着做；Skill 目录里的附带文件它可以只读地去读
export function withSkills(text: string, skills: Skill[]): string {
  if (skills.length === 0) return text
  const blocks = skills.map((skill) => `<skill name="${skill.name}" dir="${skill.dir.replace(/\\/g, '/')}">\n${skill.body}\n</skill>`)
  return [
    '[Diffra] The user attached these skills to this request. Follow their instructions. Files they mention are in the skill directory; you can read them with read_file using absolute paths.',
    ...blocks,
    '',
    'User request:',
    text,
  ].join('\n')
}
