import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRulePack, RulePackError, type RulePack, type SessionRules } from '@diffra/core'
import type { RulePackEntry, RulePacksView } from '../shared/ipc'
import type { ProjectRuleSettings } from '../shared/settings'

// 内置规则包在构建时打进主进程的 bundle，安装包里不需要单独的文件
const BUILTIN_SOURCES = import.meta.glob<string>('../../../core/rules/packs/*.md', { query: '?raw', import: 'default', eager: true })
const BUILTIN_ORDER = ['universal', 'security']

export const BUILTIN_RULE_PACKS: RulePack[] = Object.values(BUILTIN_SOURCES)
  .map((source) => parseRulePack(source))
  .sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id))

function order(id: string): number {
  const index = BUILTIN_ORDER.indexOf(id)
  return index < 0 ? BUILTIN_ORDER.length : index
}

// 用户导入的规则包存在应用数据目录的 rules/ 下，一个包一个 <id>.md
export class RulePackStore {
  constructor(private readonly dir: string) {}

  async list(): Promise<RulePacksView> {
    const { packs, errors } = await this.readUserPacks()
    const entries: RulePackEntry[] = [
      ...BUILTIN_RULE_PACKS.map((pack) => ({ pack, builtin: true })),
      ...packs.map(({ pack }) => ({ pack, builtin: false })),
    ]
    return { packs: entries, errors }
  }

  async import(markdown: string): Promise<RulePack> {
    const pack = parseRulePack(markdown)
    const { packs } = await this.list()
    if (BUILTIN_RULE_PACKS.some((item) => item.id === pack.id)) {
      throw new RulePackError(`规则包 id「${pack.id}」和内置规则包重名，请换一个 id`)
    }
    // 规则编号在审查意见里用来定位规则，跨包也不能重复；同 id 的包视为更新，不和自己比
    const taken = new Set(packs.filter((entry) => entry.pack.id !== pack.id).flatMap((entry) => entry.pack.rules.map((rule) => rule.id)))
    const clashes = pack.rules.filter((rule) => taken.has(rule.id)).map((rule) => rule.id)
    if (clashes.length > 0) throw new RulePackError(`这些规则编号已经被其他规则包使用：${clashes.join('、')}`)
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, `${pack.id}.md`), markdown, 'utf8')
    return pack
  }

  async remove(id: string): Promise<void> {
    if (BUILTIN_RULE_PACKS.some((item) => item.id === id)) throw new Error('内置规则包不能删除，可以在项目里关闭')
    const target = (await this.readUserPacks()).packs.find(({ pack }) => pack.id === id)
    if (!target) throw new Error(`没有找到规则包 ${id}`)
    await rm(join(this.dir, target.file))
  }

  // 解析失败的文件不影响其他规则包，单独列出来给界面提示
  private async readUserPacks(): Promise<{ packs: Array<{ file: string; pack: RulePack }>; errors: RulePacksView['errors'] }> {
    const files = await readdir(this.dir).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })
    const packs: Array<{ file: string; pack: RulePack }> = []
    const errors: RulePacksView['errors'] = []
    for (const file of files.filter((name) => name.toLowerCase().endsWith('.md')).sort()) {
      try {
        packs.push({ file, pack: parseRulePack(await readFile(join(this.dir, file), 'utf8')) })
      } catch (error) {
        if (!(error instanceof RulePackError)) throw error
        errors.push({ file, message: error.message })
      }
    }
    return { packs, errors }
  }
}

// 按项目设置过滤：关掉的包和单条规则不要，没开推荐级就只留强制级
export function sessionRules(packs: RulePack[], settings: ProjectRuleSettings): SessionRules {
  const disabledPacks = new Set(settings.disabledPacks)
  const disabledRules = new Set(settings.disabledRules)
  return {
    packs: packs
      .filter((pack) => !disabledPacks.has(pack.id))
      .map((pack) => ({
        ...pack,
        rules: pack.rules.filter((rule) => !disabledRules.has(rule.id) && (settings.includeRecommended || rule.level === 'required')),
      }))
      .filter((pack) => pack.rules.length > 0),
    review: settings.review,
  }
}
