import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { Puzzle } from 'lucide-react'
import type { PluginBlock } from '@diffra/core/types'
import { isRichBlockKind } from '@diffra/core/rich'
import { AnswerContext } from '../answer-links'
import { useReadOnly } from '../read-only'
import { useStatic } from '../static-context'
import { VisualFrame } from '../VisualCard'
import { BlockShell, BlockTitleContext } from './BlockShell'
import { CodeBlock } from './CodeBlock'
import type { FenceInfo } from './fence'
import { RichBlock } from './RichBlock'

// 插件注册的富块（第 682 步）：这个任务开着的插件声明了哪些 kind（Conversation 向 core 要来放进 context）。
// 套用内置富块的按它的数据格式和渲染器画；模板的放进和可视化一样的沙箱 iframe，数据在 window.diffraData。远程任务没有，按代码显示
export const PluginBlocksContext = createContext<ReadonlyMap<string, PluginBlock>>(new Map())

export function usePluginBlock(kind: string): PluginBlock | null {
  return useContext(PluginBlocksContext).get(kind) ?? null
}

// 每个任务向 core 要一次（插件是建任务时定下的）；远程任务 core 不认识，要不到就是没有
const loaded = new Map<string, Promise<ReadonlyMap<string, PluginBlock>>>()

export function useSessionPluginBlocks(sessionId: string, enabled: boolean): ReadonlyMap<string, PluginBlock> {
  const [blocks, setBlocks] = useState<ReadonlyMap<string, PluginBlock>>(new Map())
  useEffect(() => {
    if (!enabled) return
    let stale = false
    let request = loaded.get(sessionId)
    if (!request) {
      request = window.diffra.sessionBlocks(sessionId).then(
        ({ blocks: list }) => new Map(list.map((block) => [block.kind, block])),
        (error: unknown) => {
          console.error('[plugins] 读取插件的富块失败', error)
          loaded.delete(sessionId)
          return new Map<string, PluginBlock>()
        },
      )
      loaded.set(sessionId, request)
    }
    void request.then((map) => !stale && setBlocks(map))
    return () => {
      stale = true
    }
  }, [sessionId, enabled])
  return blocks
}

export function PluginBlockView({ block, info, closed }: { block: PluginBlock; info: FenceInfo; closed: boolean }) {
  if (block.renders !== 'template') {
    return isRichBlockKind(block.renders) ? (
      <BlockTitleContext.Provider value={block.title}>
        <RichBlock kind={block.renders} info={{ ...info, language: block.renders }} closed={closed} />
      </BlockTitleContext.Provider>
    ) : (
      <CodeBlock info={info} closed={closed} />
    )
  }
  return <TemplateBlock block={block} info={info} closed={closed} />
}

function TemplateBlock({ block, info, closed }: { block: PluginBlock; info: FenceInfo; closed: boolean }) {
  const readOnly = useReadOnly()
  const isStatic = useStatic()
  // 模板里的按钮能把文字填进这个任务的输入框（和可视化一样）
  const sessionId = useContext(AnswerContext)?.sessionId ?? ''
  const data = useMemo(() => {
    if (!closed) return null
    try {
      return { ok: true as const, json: JSON.stringify(JSON.parse(info.code)) }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  }, [closed, info.code])
  if (!data) return <CodeBlock info={info} closed={false} />
  if (!data.ok) return <CodeBlock info={info} note={`没能交给插件「${block.plugin}」画，按代码显示：数据不是合法的 JSON（${data.error}）`} />
  // 数据按 JSON 嵌进脚本，< 换成 \u003c，数据里的 </script> 跑不出去（和可视化的预设一样）
  const code = `<script>window.diffraData=${data.json.replace(/</g, '\\u003c')}</script>${block.template ?? ''}`
  return (
    <BlockShell testId="plugin-block" kind={block.kind} icon={<Puzzle className="size-3.5" />} title={block.title} meta={<span className="truncate">来自插件 {block.plugin}</span>} tone="card">
      {isStatic ? (
        // 导出的静态页不跑脚本
        <p className="px-3 py-2 text-sm text-muted-foreground">（插件画的内容，在 Diffra 里打开才能看）</p>
      ) : (
        // 模板里的链接不开（插件的模板不该带用户去别处）
        <VisualFrame title={block.title} code={code} sessionId={sessionId} onLink={() => undefined} className={readOnly ? 'pointer-events-none' : undefined} />
      )}
    </BlockShell>
  )
}
