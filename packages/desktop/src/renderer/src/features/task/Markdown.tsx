import { type ComponentProps, memo, useRef } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'

// 代码块：顶栏放语言名和复制按钮。语言来自 remark 给 code 加的 language-xxx 类名
function CodeBlock({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const preRef = useRef<HTMLPreElement>(null)
  const code = node?.children[0]
  const classes = code?.type === 'element' ? code.properties.className : undefined
  const languageClass = Array.isArray(classes) ? classes.find((name): name is string => typeof name === 'string' && name.startsWith('language-')) : undefined
  const language = languageClass?.slice('language-'.length)
  const copy = () => {
    navigator.clipboard.writeText(preRef.current?.textContent ?? '').then(
      () => showToast('已复制代码'),
      (error: unknown) => console.error('复制失败', error),
    )
  }
  return (
    <div className="overflow-hidden rounded-lg border bg-muted" data-testid="code-block">
      <div className="flex h-7 items-center justify-between gap-2 border-b pr-1 pl-3.5 text-xs text-muted-foreground">
        <span className="truncate">{language}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="复制代码" onClick={copy}>
              <Copy />
            </Button>
          </TooltipTrigger>
          <TooltipContent>复制代码</TooltipContent>
        </Tooltip>
      </div>
      <pre ref={preRef} {...props}>
        {children}
      </pre>
    </div>
  )
}

// 链接交给系统浏览器打开；主进程只放行 http(s)
const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        if (href) window.diffra.openExternal(href).catch((error: unknown) => showToast(errorMessage(error)))
      }}
    >
      {children}
    </a>
  ),
  pre: CodeBlock,
}

// 模型的回复按 Markdown 显示；不渲染原始 HTML
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
