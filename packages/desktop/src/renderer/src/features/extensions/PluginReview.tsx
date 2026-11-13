import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { PluginPrepared } from '../../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { contentsSummary, HookList } from './parts'

// 取回的插件装之前给用户看：从哪来、里面有什么；带钩子的列出会自动运行的命令，勾了才允许（第 600 步）
export function PluginReview({ prepared, busy, onInstall, onCancel }: { prepared: PluginPrepared; busy: boolean; onInstall(allowHooks: boolean): void; onCancel(): void }) {
  const [allowHooks, setAllowHooks] = useState(false)
  const { info } = prepared
  return (
    <div className="space-y-4" data-testid="plugin-review">
      <div className="space-y-1">
        <p className="text-sm">
          从 <span className="font-mono text-xs break-all">{prepared.location}</span> 取回了「{info.name}」{info.version && <span className="text-muted-foreground"> v{info.version.replace(/^v/i, '')}</span>}。
        </p>
        <p className="text-xs text-muted-foreground">{contentsSummary(info)}</p>
        {info.mcpServers.length > 0 && <p className="text-xs text-muted-foreground">里面的 MCP 服务器会在本机运行命令。</p>}
        {info.unsupported.length > 0 && (
          <p className="flex items-start gap-1.5 text-xs">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>Diffra 暂不支持、会忽略：{info.unsupported.join('、')}</span>
          </p>
        )}
      </div>
      {info.hooks.length > 0 && (
        <>
          <div className="rounded-lg border bg-background">
            <div className="border-b px-3.5 py-2.5 text-sm font-bold">它会在这些时候自动运行命令</div>
            <div className="px-3.5 py-2.5">
              <HookList hooks={info.hooks} />
            </div>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={allowHooks} onCheckedChange={(value) => setAllowHooks(value === true)} />
            <span>
              允许这{info.hooks.length > 1 ? '些' : '个'}钩子在本机自动运行
              <span className="block text-xs text-muted-foreground">用 Git Bash 运行，每次最多 60 秒。不勾也能装，只是钩子不跑；以后可以在「已安装」里改。</span>
            </span>
          </label>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button disabled={busy} onClick={() => onInstall(allowHooks)}>
          {busy ? '正在安装…' : '安装'}
        </Button>
      </div>
    </div>
  )
}
