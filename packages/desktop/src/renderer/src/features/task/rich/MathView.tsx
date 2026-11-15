import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { copyText, ShellAction } from './BlockShell'
import { CodeBlock } from './CodeBlock'

type Katex = typeof import('katex').default

// KaTeX 和它的样式、字体都按需加载：回答里第一次出现公式时才取
let katexModule: Promise<Katex> | null = null

function loadKatex(): Promise<Katex> {
  katexModule ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([module]) => module.default)
  return katexModule
}

function useKatex(): Katex | null {
  const [katex, setKatex] = useState<Katex | null>(null)
  useEffect(() => {
    let stale = false
    loadKatex().then(
      (module) => !stale && setKatex(() => module),
      (error: unknown) => console.error('[markdown] 加载公式渲染失败', error),
    )
    return () => {
      stale = true
    }
  }, [])
  return katex
}

const MAX_TEX_CHARS = 8000

// trust 关着：\href、\htmlClass 这类能插链接和属性的命令都不生效，输出只有 KaTeX 自己的排版标签
function render(katex: Katex, tex: string, displayMode: boolean): { html: string } | { error: string } {
  if (tex.length > MAX_TEX_CHARS) return { error: `公式太长（超过 ${MAX_TEX_CHARS} 字）` }
  try {
    return { html: katex.renderToString(tex, { displayMode, throwOnError: true, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxSize: 20, maxExpand: 500 }) }
  } catch (error) {
    return { error: error instanceof Error ? error.message.replace(/^KaTeX parse error: /, '') : String(error) }
  }
}

// 单个 $ 包起来的不一定是公式：$PATH 和 $HOME 这样的会被当成一段。里面有中文（不在 \text{} 里）或者紧挨着 $ 的是空格，就照原文显示
export function looksLikeMath(tex: string): boolean {
  if (/^\s|\s$/.test(tex)) return false
  return !/[㐀-鿿＀-￯]/.test(tex.replace(/\\(?:text|mathrm|textbf|operatorname)\{[^}]*\}/g, ''))
}

export function InlineMath({ tex }: { tex: string }) {
  const katex = useKatex()
  if (!looksLikeMath(tex)) return <>{`$${tex}$`}</>
  const result = katex ? render(katex, tex, false) : null
  if (!result || 'error' in result) {
    return (
      <code className="math-source" title={result && 'error' in result ? `公式有误：${result.error}` : undefined} data-testid="math-inline-source">
        {tex}
      </code>
    )
  }
  return <span className="math-inline" data-testid="math-inline" dangerouslySetInnerHTML={{ __html: result.html }} />
}

export function MathBlock({ tex }: { tex: string }) {
  const katex = useKatex()
  const result = katex ? render(katex, tex, true) : null
  if (result && 'error' in result) {
    return <CodeBlock info={{ language: 'latex', file: null, startLine: null, highlight: new Set(), code: tex }} note={`公式有误，按原文显示：${result.error}`} />
  }
  // 块级公式不套卡片外壳，居中显示；悬停或键盘聚焦时右上角能复制 LaTeX
  return (
    <div className="group/math relative" data-testid="math-block">
      {result ? (
        <div className="math-display overflow-x-auto overflow-y-hidden py-1" dangerouslySetInnerHTML={{ __html: result.html }} />
      ) : (
        <pre className="py-1 text-center font-mono text-xs text-muted-foreground">{tex}</pre>
      )}
      <span className="absolute top-0 right-0 opacity-0 transition-opacity group-hover/math:opacity-100 focus-within:opacity-100">
        <ShellAction label="复制 LaTeX" onClick={() => copyText(tex, '已复制 LaTeX')}>
          <Copy />
        </ShellAction>
      </span>
    </div>
  )
}
