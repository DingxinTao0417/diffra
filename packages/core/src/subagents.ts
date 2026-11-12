import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from './skills.js'

// 自定义子智能体类型（第 448 步，参照 qwen-code 的 .qwen/agents）：一个类型一个 Markdown 文件，
// 开头是 YAML frontmatter（name、description，可选 mode: read-only），正文是给这类工人的说明。
// 主智能体派工人时可以指定类型：工人的提示词后面接上这段说明，read-only 的只给读和搜索的工具。
// 放在项目的 .diffra/agents 或用户目录的 ~/.diffra/agents，同名的认项目里的
export interface AgentType {
  name: string
  description: string
  readOnly: boolean
  instructions: string
}

const MAX_AGENT_TYPES = 20
const MAX_AGENT_FILE_BYTES = 50_000
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

export async function loadAgentTypes(cwd: string): Promise<AgentType[]> {
  const types: AgentType[] = []
  for (const dir of [join(cwd, '.diffra', 'agents'), join(homedir(), '.diffra', 'agents')]) {
    const names = await readdir(dir).catch(() => [] as string[])
    for (const file of names.filter((name) => name.endsWith('.md')).sort()) {
      if (types.length >= MAX_AGENT_TYPES) return types
      try {
        const text = await readFile(join(dir, file), 'utf8')
        if (text.length > MAX_AGENT_FILE_BYTES) continue
        const { fields, body } = parseFrontmatter(text)
        const name = fields.name ?? file.slice(0, -'.md'.length)
        const description = fields.description?.replace(/\s+/g, ' ').trim() ?? ''
        // 没有说明的类型主智能体不知道什么时候用，名字不规整的没法放进工具参数：都跳过
        if (!NAME.test(name) || !description || !body.trim() || types.some((type) => type.name === name)) continue
        types.push({ name, description: description.slice(0, 300), readOnly: fields.mode === 'read-only', instructions: body.trim() })
      } catch (error) {
        console.error(`[agents] 读不了子智能体类型 ${file}`, error)
      }
    }
  }
  return types
}
