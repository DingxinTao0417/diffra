import { useState } from 'react'
import { cn } from 'cn'
import { ChevronDown, GitBranch } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'

// 任务页底栏和首页的分支：点开列出本地分支，选一个切过去。项目里有任务在跑、工作区有未提交的改动时切不了，原因照实提示（main/project-branch.ts）
export function BranchMenu({ branch, load, onSwitch, className }: { branch: string; load(): Promise<{ branches: string[] }>; onSwitch(branch: string): Promise<void>; className?: string }) {
  const [branches, setBranches] = useState<string[] | null>(null)
  const [switching, setSwitching] = useState(false)
  const choose = (next: string) => {
    if (next === branch) return
    setSwitching(true)
    onSwitch(next)
      .catch((error: unknown) => showToast(errorMessage(error)))
      .finally(() => setSwitching(false))
  }
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) return
        setBranches(null)
        load().then(
          (result) => setBranches(result.branches),
          (error: unknown) => {
            setBranches([])
            showToast(`读分支失败：${errorMessage(error)}`)
          },
        )
      }}
    >
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`分支 ${branch}，切换分支`} disabled={switching} className={cn('flex min-w-0 items-center gap-1 hover:text-foreground disabled:opacity-60', className)} data-testid="branch-menu">
          <GitBranch className="size-3 shrink-0" />
          <span className="max-w-40 truncate">{switching ? '正在切换…' : branch}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      {/* 分支名常常很长：给够宽度，不换行，放不下的省略、悬停看全名 */}
      <DropdownMenuContent align="start" className="max-h-72 w-max max-w-96 min-w-48 overflow-y-auto">
        {branches === null ? (
          <DropdownMenuItem disabled>读取中…</DropdownMenuItem>
        ) : branches.length === 0 ? (
          <DropdownMenuItem disabled>没有本地分支</DropdownMenuItem>
        ) : (
          <DropdownMenuRadioGroup value={branch} onValueChange={choose}>
            {branches.map((name) => (
              <DropdownMenuRadioItem key={name} value={name} title={name}>
                <span className="truncate">{name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
