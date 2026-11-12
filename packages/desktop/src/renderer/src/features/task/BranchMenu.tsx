import { useState } from 'react'
import { ChevronDown, GitBranch } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { errorMessage } from '@/lib/errors'
import { showToast } from '@/state/store'

// 任务页底栏的分支：点开列出本地分支，选一个切过去。项目里有任务在跑、工作区有未提交的改动时切不了，原因照实提示（main/project-branch.ts）
export function BranchMenu({ branch, load, onSwitch }: { branch: string; load(): Promise<{ branches: string[] }>; onSwitch(branch: string): Promise<void> }) {
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
        <button type="button" aria-label={`分支 ${branch}，切换分支`} disabled={switching} className="flex items-center gap-1 hover:text-foreground disabled:opacity-60" data-testid="branch-menu">
          <GitBranch className="size-3" />
          {switching ? '正在切换…' : branch}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        {branches === null ? (
          <DropdownMenuItem disabled>读取中…</DropdownMenuItem>
        ) : branches.length === 0 ? (
          <DropdownMenuItem disabled>没有本地分支</DropdownMenuItem>
        ) : (
          <DropdownMenuRadioGroup value={branch} onValueChange={choose}>
            {branches.map((name) => (
              <DropdownMenuRadioItem key={name} value={name}>
                {name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
