import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import type { CommandInfo, PluginRef, SkillSource } from './protocol.js'
import { parseFrontmatter } from './skills.js'

// 自定义命令是一个 markdown 文件：frontmatter 里的 description、argument-hint，正文是要发给模型的话，
// $ARGUMENTS 换成用户填的参数。和 Claude Code 的 commands、Codex 的 prompts 格式一样
const MAX_COMMAND_BYTES = 100_000
const MAX_COMMANDS = 300
// 子目录作为命名空间：review/deep.md 叫 review:deep，最多往下找这么多层
const MAX_DEPTH = 2

export interface CommandRoot {
  source: SkillSource
  dir: string
  // 插件的命令前面加上插件名
  prefix: string | null
}

// 按优先级排：同名的命令只认排在前面的
export function commandRoots(cwd: string, plugins: PluginRef[] = []): CommandRoot[] {
  const home = homedir()
  return [
    { source: 'project', dir: join(cwd, '.diffra', 'commands'), prefix: null },
    { source: 'user', dir: join(home, '.diffra', 'commands'), prefix: null },
    ...plugins.map((plugin) => ({ source: 'plugin' as const, dir: join(plugin.dir, 'commands'), prefix: plugin.name })),
    { source: 'claude', dir: join(home, '.claude', 'commands'), prefix: null },
    { source: 'codex', dir: join(home, '.codex', 'prompts'), prefix: null },
  ]
}

async function markdownFiles(dir: string, depth = 0): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path)
    else if (entry.isDirectory() && depth + 1 < MAX_DEPTH) files.push(...(await markdownFiles(path, depth + 1)))
  }
  return files
}

export async function loadCommands(roots: CommandRoot[]): Promise<CommandInfo[]> {
  const commands = new Map<string, CommandInfo>()
  for (const root of roots) {
    for (const file of await markdownFiles(root.dir)) {
      if (commands.size >= MAX_COMMANDS) break
      const info = await stat(file).catch(() => null)
      if (!info?.isFile() || info.size > MAX_COMMAND_BYTES) continue
      const local = relative(root.dir, file).replace(/\.md$/i, '').replace(/[\\/]/g, ':')
      const name = root.prefix ? `${root.prefix}:${local}` : local
      if (commands.has(name)) continue
      const { fields, body } = parseFrontmatter(await readFile(file, 'utf8'))
      commands.set(name, {
        name,
        description: fields.description?.trim() ?? '',
        argumentHint: fields['argument-hint']?.trim() ?? '',
        source: root.source,
        body: body.trim(),
      })
    }
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name))
}
