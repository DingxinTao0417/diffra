// 回答 Markdown 的两处预处理：callout（> [!NOTE] 的写法）标到引用块上，交给 Callout 组件画；\( \) \[ \] 写的公式换成 $ 写法。
// 只操作语法树和纯文本，不放开原始 HTML

export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'risk' | 'done' | 'background' | 'details'

const CALLOUT_KINDS: Record<string, CalloutKind> = {
  note: 'note',
  info: 'note',
  提示: 'note',
  说明: 'note',
  tip: 'tip',
  hint: 'tip',
  技巧: 'tip',
  建议: 'tip',
  important: 'important',
  重要: 'important',
  warning: 'warning',
  warn: 'warning',
  attention: 'warning',
  警告: 'warning',
  注意: 'warning',
  caution: 'risk',
  danger: 'risk',
  risk: 'risk',
  error: 'risk',
  风险: 'risk',
  危险: 'risk',
  success: 'done',
  check: 'done',
  done: 'done',
  成功: 'done',
  完成: 'done',
  background: 'background',
  context: 'background',
  abstract: 'background',
  summary: 'background',
  背景: 'background',
  摘要: 'background',
  details: 'details',
  detail: 'details',
  more: 'details',
  详情: 'details',
  展开: 'details',
}

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>
}

const CALLOUT_MARKER = /^\[!([^\]\s]+)\]([+-])?[ \t]*([^\n]*)(?:\n|$)/

export function remarkCallouts() {
  return (tree: MdNode) => walk(tree)
}

function walk(node: MdNode) {
  for (const child of node.children ?? []) {
    if (child.type === 'blockquote') markCallout(child)
    walk(child)
  }
}

function markCallout(quote: MdNode) {
  const paragraph = quote.children?.[0]
  const first = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined
  if (!paragraph?.children || first?.type !== 'text' || first.value === undefined) return
  const match = CALLOUT_MARKER.exec(first.value)
  const kind = match ? CALLOUT_KINDS[match[1]!.toLowerCase()] : undefined
  if (!match || !kind) return
  first.value = first.value.slice(match[0].length)
  if (first.value === '') paragraph.children.shift()
  // 标记后面紧跟的换行（软换行）留在正文开头，去掉
  const next = paragraph.children[0]
  if (next?.type === 'break') paragraph.children.shift()
  if (paragraph.children.length === 0) quote.children!.shift()
  quote.data = {
    ...quote.data,
    hProperties: { ...quote.data?.hProperties, dataCallout: kind, dataCalloutTitle: match[3]?.trim() || undefined, dataCalloutFold: match[2] || undefined },
  }
}

// \[ … \] → $$ … $$，\( … \) → $ … $。围栏代码和行内代码里的不动
export function normalizeMath(text: string): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text
  const parts: string[] = []
  let fence: string | null = null
  let prose: string[] = []
  const flush = () => {
    if (prose.length > 0) parts.push(replaceDelimiters(prose.join('\n')))
    prose = []
  }
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      parts.push(line)
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null
      continue
    }
    if (marker) {
      flush()
      fence = marker
      parts.push(line)
      continue
    }
    prose.push(line)
  }
  flush()
  return parts.join('\n')
}

function replaceDelimiters(prose: string): string {
  // 行内代码先换成占位，替换完再放回去
  const codes: string[] = []
  const masked = prose.replace(/(`+)[\s\S]*?\1/g, (code) => `\u0000${codes.push(code) - 1}\u0000`)
  const replaced = masked
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `$$${body}$$`)
    .replace(/\\\(([^\n]+?)\\\)/g, (_, body: string) => `$${body.trim()}$`)
  return replaced.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codes[Number(index)]!)
}
