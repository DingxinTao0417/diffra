// 更新日志：打包时从提交信息生成（scripts/changelog.ts），客户端、官网、更新包里的说明都用这一份
export interface ChangelogRelease {
  version: string
  // 发版那天，YYYY-MM-DD
  date: string
  added: string[]
  fixed: string[]
}

// 只比 x.y.z，按数字比
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const [left, right] = [parts(a), parts(b)]
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const COMMIT = /^(feat|fix)(?:\([^)]*\))?!?:\s*(.+)$/
// 提交信息末尾记开发步骤的「（第 156–163、173–186 步）」「（改版第 1–7 步）」，用户不需要
const STEPS = /\s*[（(][^（）()]*第[^（）()]*步[）)]\s*$/

// 一个版本里的提交主题 → 新增、修复。只收 feat 和 fix；主题按「；」分条，fix 的和以「修」开头的算修复
export function releaseItems(subjects: string[]): { added: string[]; fixed: string[] } {
  const added: string[] = []
  const fixed: string[] = []
  for (const subject of subjects) {
    const match = COMMIT.exec(subject.trim())
    if (!match) continue
    const [, type, body = ''] = match
    for (const raw of body.replace(STEPS, '').split(/[；;]/)) {
      const item = raw.trim().replace(/[。.]$/, '')
      if (!item) continue
      const list = type === 'fix' || item.startsWith('修') ? fixed : added
      if (!list.includes(item)) list.push(item)
    }
  }
  return { added, fixed }
}

// 一个版本的说明写成纯文字：写进更新包的 latest.yml、GitHub Release；客户端再用 parseNotes 读回来
export function formatNotes(release: Pick<ChangelogRelease, 'added' | 'fixed'>): string {
  const section = (title: string, items: string[]) => (items.length > 0 ? [title, ...items.map((item) => `- ${item}`)] : [])
  return [...section('新增', release.added), ...section('修复', release.fixed)].join('\n')
}

export function parseNotes(text: string): { added: string[]; fixed: string[] } {
  const result = { added: [] as string[], fixed: [] as string[] }
  let list: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '新增') list = result.added
    else if (trimmed === '修复') list = result.fixed
    else if (list && trimmed.startsWith('- ')) list.push(trimmed.slice(2).trim())
  }
  return result
}
