import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'

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
