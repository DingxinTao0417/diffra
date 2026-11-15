import { useEffect, useRef, useState } from 'react'
import { Plug } from 'lucide-react'
import type { McpUiMeta } from '@diffra/core/types'
import { useReadOnly } from './read-only'
import { useAskAbout } from './SelectionAsk'
import { useStatic } from './static-context'
import { LinkConfirm, VisualFrame } from './VisualCard'

// MCP 工具带的界面（第 683 步）：放进和可视化一样的沙箱 iframe（能跑脚本、没有同源权限），按 MCP Apps 的 postMessage JSON-RPC 和它说话：
// 回 ui/initialize（宿主信息、深浅色），它说 initialized 以后把工具参数和结果发过去。它能做的只有：打开链接（先问）、把一句话填进输入框（不发）。
// 让宿主替它调工具、读资源这些一律不答应——界面里的代码不该绕过权限确认去动 MCP 服务器
const PROTOCOL = '2025-06-18'

let appVersion: Promise<string> | null = null
const versionOf = () => (appVersion ??= window.diffra.getAppVersion().catch(() => ''))

export function McpAppCard({ ui, sessionId }: { ui: McpUiMeta; sessionId: string }) {
  const isStatic = useStatic()
  const readOnly = useReadOnly()
  const [link, setLink] = useState<string | null>(null)
  return (
    <figure className="flex flex-col gap-1.5 rounded-xl border px-3 py-2.5" data-testid="mcp-app" aria-label={`${ui.server} · ${ui.tool}`}>
      <figcaption className="flex items-center gap-2 text-sm">
        <Plug className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-bold">{ui.tool}</span>
        <span className="shrink-0 text-xs text-muted-foreground">来自 MCP 服务器 {ui.server}</span>
      </figcaption>
      {link && <LinkConfirm link={link} sessionId={sessionId} onDone={() => setLink(null)} />}
      {isStatic ? <p className="text-sm text-muted-foreground">（MCP 工具的界面，在 Diffra 里打开才能看）</p> : <McpAppFrame ui={ui} sessionId={sessionId} readOnly={readOnly} onLink={setLink} />}
    </figure>
  )
}

function McpAppFrame({ ui, sessionId, readOnly, onLink }: { ui: McpUiMeta; sessionId: string; readOnly: boolean; onLink(url: string): void }) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const ask = useAskAbout()
  const latest = useRef({ ui, onLink, ask, readOnly })
  latest.current = { ui, onLink, ask, readOnly }

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow
      if (!target || event.source !== target) return
      const message = event.data as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> } | null
      if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return
      const { ui: current, onLink: open, ask: fill, readOnly: viewOnly } = latest.current
      const hasId = typeof message.id === 'number' || typeof message.id === 'string'
      const reply = (result: unknown) => hasId && target.postMessage({ jsonrpc: '2.0', id: message.id, result }, '*')
      const refuse = (text: string) => hasId && target.postMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: text } }, '*')
      const notify = (method: string, params: unknown) => target.postMessage({ jsonrpc: '2.0', method, params }, '*')
      switch (message.method) {
        case 'ui/initialize':
          void versionOf().then((version) =>
            reply({
              protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : PROTOCOL,
              hostInfo: { name: 'Diffra', version },
              hostCapabilities: viewOnly ? {} : { openLinks: {}, message: {} },
              hostContext: { theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', displayMode: 'inline' },
            }),
          )
          return
        case 'ui/notifications/initialized':
          notify('ui/notifications/tool-input', { arguments: current.input })
          notify('ui/notifications/tool-result', current.result)
          return
        case 'ui/open-link': {
          const url = message.params?.url
          if (!viewOnly && typeof url === 'string' && /^https?:\/\//i.test(url)) open(url)
          reply({})
          return
        }
        case 'ui/message': {
          const content = Array.isArray(message.params?.content) ? (message.params.content as Array<{ type?: unknown; text?: unknown }>) : []
          const text = content.flatMap((item) => (item.type === 'text' && typeof item.text === 'string' ? [item.text] : [])).join('\n')
          if (fill && text.trim()) fill(`MCP 工具「${current.tool}」的界面里说：`, text.slice(0, 4000))
          reply({})
          return
        }
        // 大小由容器页的运行时量，这里不用管
        case 'ui/notifications/size-changed':
          return
        default:
          refuse(`Diffra 不支持界面调用 ${message.method}`)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <VisualFrame
      title={`${ui.server} · ${ui.tool}`}
      code={ui.html}
      sessionId={sessionId}
      onLink={onLink}
      frameRef={(element) => {
        frame.current = element
      }}
    />
  )
}
