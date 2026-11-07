import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findRipgrep } from '../src/environment.js'
import { loadSkills, parseFrontmatter, skillRoots, withSkills } from '../src/skills.js'
import { editFileTool, readFileTool } from '../src/tools/files.js'
import type { ToolContext } from '../src/tools/types.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffra-skills-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeSkill(dir: string, name: string, content: string) {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), content)
}

describe('Skill', () => {
  test('frontmatter：普通值、引号、| 多行、> 折行', () => {
    const { fields, body } = parseFrontmatter(
      ['---', 'name: "humanizer"', 'description: |', '  第一行', '  第二行', 'summary: >', '  折成', '  一行', '---', '', '# 正文'].join('\r\n'),
    )
    expect(fields).toEqual({ name: 'humanizer', description: '第一行\n第二行', summary: '折成 一行' })
    expect(body.trim()).toBe('# 正文')
  })

  test('按优先级读：同名的只认排在前面的；没写 name 用目录名；不是目录、没有 SKILL.md 的跳过', async () => {
    const project = join(root, 'project')
    const claude = join(root, 'claude')
    writeSkill(project, 'review', '---\nname: review\ndescription: 项目里的审查\n---\n项目版')
    writeSkill(claude, 'review', '---\nname: review\ndescription: Claude 的审查\n---\nClaude 版')
    writeSkill(claude, 'notes', '没有 frontmatter 的正文')
    mkdirSync(join(claude, 'empty'))
    writeFileSync(join(claude, 'loose.md'), 'x')

    const skills = await loadSkills([
      { source: 'project', dir: project },
      { source: 'claude', dir: claude },
      { source: 'codex', dir: join(root, 'missing') },
    ])
    expect(skills.map(({ name, description, source, body }) => ({ name, description, source, body }))).toEqual([
      { name: 'notes', description: '', source: 'claude', body: '没有 frontmatter 的正文' },
      { name: 'review', description: '项目里的审查', source: 'project', body: '项目版' },
    ])
  })

  test('随 Diffra 带的 frontend-design 排在最后，用户自己装了同名的就用用户的', async () => {
    const builtin = skillRoots(root).at(-1)!
    expect(builtin.source).toBe('builtin')
    const design = (await loadSkills([builtin])).find((skill) => skill.name === 'frontend-design')
    expect(design?.description).toContain('distinctive, intentional visual design')
    expect(design?.body).toContain('# Frontend Design')

    const project = join(root, '.diffra', 'skills')
    writeSkill(project, 'frontend-design', '---\nname: frontend-design\ndescription: 项目自己的设计说明\n---\n项目版')
    const skills = await loadSkills([{ source: 'project', dir: project }, builtin])
    expect(skills.find((skill) => skill.name === 'frontend-design')?.source).toBe('project')
  })

  test('选了 Skill 的提问：说明放在前面，带着目录，后面是原话', () => {
    const text = withSkills('改一下文案', [{ name: 'humanizer', description: '', source: 'codex', dir: 'C:\\Users\\me\\.codex\\skills\\humanizer', body: '去掉 AI 腔' }])
    expect(text).toContain('<skill name="humanizer" dir="C:/Users/me/.codex/skills/humanizer">\n去掉 AI 腔\n</skill>')
    expect(text.endsWith('User request:\n改一下文案')).toBe(true)
    expect(withSkills('原话', [])).toBe('原话')
  })

  test('Skill 目录可以用绝对路径只读访问，不能改；其他项目外的路径照样不行', async () => {
    const project = join(root, 'project')
    const skills = join(root, 'skills')
    mkdirSync(project)
    writeSkill(skills, 'demo', '---\nname: demo\n---\n说明')
    writeFileSync(join(skills, 'demo', 'template.txt'), '模板内容\n')
    writeFileSync(join(root, 'secret.txt'), 'no\n')
    const context: ToolContext = {
      cwd: project,
      rgPath: await findRipgrep(),
      bashPath: null,
      signal: new AbortController().signal,
      readHashes: new Map(),
      trustedCommands: [],
      readOnlyPaths: [],
      readRoots: [skills],
      requestCommandPermission: async () => ({ allowed: true }),
    }
    const read = await readFileTool(context, { path: join(skills, 'demo', 'template.txt') })
    expect(read.text).toContain('模板内容')
    await expect(readFileTool(context, { path: join(root, 'secret.txt') })).rejects.toThrow('outside the project')
    await expect(editFileTool(context, { path: join(skills, 'demo', 'template.txt'), old_string: '模板', new_string: '改' })).rejects.toThrow(
      'outside the project',
    )
  })
})
