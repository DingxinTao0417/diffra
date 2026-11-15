import { useEffect, useId, useState } from 'react'
import { Code, Copy, Download, Image as ImageIcon, Workflow } from 'lucide-react'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'
import { BlockShell, BlockSkeleton, copyText, ShellAction } from './BlockShell'
import { CodeBlock } from './CodeBlock'
import { cssVar, downloadBlob, safeFileName, svgToPng } from './download'
import type { FenceInfo } from './fence'
import { useThemeKey } from './theme'

type Mermaid = typeof import('mermaid').default

const MAX_MERMAID_CHARS = 20_000

let mermaidModule: Promise<Mermaid> | null = null
// initialize 是全局的，几张图同时画会互相盖掉配置：一张一张来
let queue: Promise<unknown> = Promise.resolve()

// 颜色按应用当前的深浅色和配色取（mermaid 要拿真实颜色值做颜色运算，传 CSS 变量不行）；主题一变就重画
function themeVariables() {
  const dark = document.documentElement.classList.contains('dark')
  return {
    darkMode: dark,
    background: cssVar('--card'),
    fontFamily: cssVar('--font-sans'),
    fontSize: '13px',
    primaryColor: cssVar('--muted'),
    primaryTextColor: cssVar('--foreground'),
    primaryBorderColor: cssVar('--input'),
    secondaryColor: cssVar('--secondary'),
    secondaryTextColor: cssVar('--foreground'),
    secondaryBorderColor: cssVar('--input'),
    tertiaryColor: cssVar('--card'),
    tertiaryTextColor: cssVar('--foreground'),
    tertiaryBorderColor: cssVar('--border'),
    lineColor: cssVar('--muted-foreground'),
    textColor: cssVar('--foreground'),
    mainBkg: cssVar('--muted'),
    nodeBorder: cssVar('--input'),
    clusterBkg: cssVar('--background'),
    clusterBorder: cssVar('--border'),
    titleColor: cssVar('--foreground'),
    edgeLabelBackground: cssVar('--card'),
    noteBkgColor: cssVar('--warning-soft'),
    noteTextColor: cssVar('--foreground'),
    noteBorderColor: cssVar('--warning'),
    actorBkg: cssVar('--muted'),
    actorBorder: cssVar('--input'),
    actorTextColor: cssVar('--foreground'),
    signalColor: cssVar('--foreground'),
    signalTextColor: cssVar('--foreground'),
    labelBoxBkgColor: cssVar('--muted'),
    labelTextColor: cssVar('--foreground'),
    errorBkgColor: cssVar('--destructive-soft'),
    errorTextColor: cssVar('--destructive'),
    git0: cssVar('--chart-1'),
    git1: cssVar('--chart-2'),
    git2: cssVar('--chart-3'),
    git3: cssVar('--chart-4'),
    pie1: cssVar('--chart-1'),
    pie2: cssVar('--chart-2'),
    pie3: cssVar('--chart-3'),
    pie4: cssVar('--chart-4'),
  }
}

// securityLevel strict：点击事件和链接都不生效，标签里的 HTML 被清掉；标签画成 SVG 文字（不用 foreignObject），能导出 PNG
async function renderMermaid(id: string, code: string): Promise<string> {
  mermaidModule ??= import('mermaid').then((module) => module.default)
  const mermaid = await mermaidModule
  const task = queue.then(async () => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: themeVariables(), htmlLabels: false, fontFamily: cssVar('--font-sans') })
    try {
      await mermaid.parse(code)
      const { svg } = await mermaid.render(id, code)
      return svg
    } finally {
      // 出错时 mermaid 可能把临时节点留在 body 里
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  })
  queue = task.catch(() => undefined)
  return task
}

// 回答里的 ```mermaid：流程图、时序图、状态图、类图、ER 图、甘特图……画成 SVG。语法错了按代码显示并说明原因
export function MermaidBlock({ info }: { info: FenceInfo }) {
  const id = `mermaid-${useId().replace(/[^\w-]/g, '')}`
  const theme = useThemeKey()
  const [result, setResult] = useState<{ code: string; svg: string } | { code: string; error: string } | null>(null)
  const [showCode, setShowCode] = useState(false)
  const tooLarge = info.code.length > MAX_MERMAID_CHARS
  useEffect(() => {
    if (tooLarge) return
    let stale = false
    renderMermaid(id, info.code).then(
      (svg) => !stale && setResult({ code: info.code, svg }),
      (error: unknown) => !stale && setResult({ code: info.code, error: errorMessage(error).split('\n').slice(0, 3).join(' ') }),
    )
    return () => {
      stale = true
    }
  }, [id, info.code, theme, tooLarge])
  if (tooLarge) return <CodeBlock info={info} note={`流程图太大（超过 ${MAX_MERMAID_CHARS} 字），按代码显示`} />
  const current = result?.code === info.code ? result : null
  if (current && 'error' in current) return <CodeBlock info={info} note={`流程图语法有误，按代码显示：${current.error}`} />
  if (!current) return <BlockSkeleton label="正在画图…" />
  const title = diagramTitle(info.code)
  const saveSvg = () => downloadBlob(new Blob([current.svg], { type: 'image/svg+xml' }), `${safeFileName(title)}.svg`)
  const savePng = () =>
    svgToPng(current.svg, cssVar('--card')).then(
      (blob) => downloadBlob(blob, `${safeFileName(title)}.png`),
      (error: unknown) => showToast(`保存图片失败：${errorMessage(error)}`),
    )
  const diagram = (large: boolean) => <div className="mermaid-view flex justify-center overflow-auto p-3" style={large ? { minHeight: '60vh' } : undefined} dangerouslySetInnerHTML={{ __html: current.svg }} />
  return (
    <BlockShell
      testId="mermaid-block"
      kind="mermaid"
      tone="card"
      icon={<Workflow className="size-3.5 shrink-0" />}
      title={title}
      actions={
        <>
          <ShellAction label={showCode ? '看图' : '看代码'} pressed={showCode} onClick={() => setShowCode(!showCode)}>
            <Code />
          </ShellAction>
          <ShellAction label="复制代码" onClick={() => copyText(info.code, '已复制流程图代码')}>
            <Copy />
          </ShellAction>
          <ShellAction label="另存为 SVG" onClick={saveSvg}>
            <Download />
          </ShellAction>
          <ShellAction label="另存为 PNG" onClick={() => void savePng()}>
            <ImageIcon />
          </ShellAction>
        </>
      }
      expand={() => diagram(true)}
    >
      {showCode ? <pre className="code-body max-h-96 overflow-auto bg-muted">{info.code}</pre> : diagram(false)}
    </BlockShell>
  )
}

const DIAGRAM_NAMES: Array<[RegExp, string]> = [
  [/^(flowchart|graph)\b/, '流程图'],
  [/^sequenceDiagram\b/, '时序图'],
  [/^stateDiagram/, '状态图'],
  [/^classDiagram/, '类图'],
  [/^erDiagram\b/, 'ER 图'],
  [/^gantt\b/, '甘特图'],
  [/^pie\b/, '饼图'],
  [/^journey\b/, '用户旅程'],
  [/^gitGraph\b/, 'Git 分支图'],
  [/^mindmap\b/, '思维导图'],
  [/^timeline\b/, '时间线'],
  [/^(quadrantChart|xychart|sankey|block|architecture|kanban|packet|requirementDiagram|C4)/, '图'],
]

// 标题：图里写了 title 就用它，否则按图的种类叫
function diagramTitle(code: string): string {
  const lines = code.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('%%'))
  const explicit = lines.map((line) => /^title\s+(.+)$/.exec(line)?.[1]).find(Boolean)
  if (explicit) return explicit
  const head = lines[0] ?? ''
  return DIAGRAM_NAMES.find(([pattern]) => pattern.test(head))?.[1] ?? '图'
}
