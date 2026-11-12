import { createContext, useContext } from 'react'
import type { CheckpointChange, CommandInfo, SkillInfo } from '@diffra/core/types'
import type { ProviderView } from '../../../../shared/settings'

// 远程任务页借用本机任务页（TaskPage）时提供：文件改动向对方要；没有它的就是本机任务。
// 本机才有的部件（MCP 状态、改项目设置、深度扫描、终端、浏览器、设计）见到它就不显示或换成远程的做法（docs/decisions.md「设备连接」）
export interface RemoteTaskSource {
  diff(turnId: string): Promise<string>
  // 以下开放了「可查看和操作」才有。providers：对方的模型服务（切换模型用，没取到是 undefined）
  providers?: ProviderView[]
  loadProviders?: () => void
  listSkills?: () => Promise<SkillInfo[]>
  listCommands?: () => Promise<CommandInfo[]>
  compact?: () => Promise<void>
  previewRestore?: (turnId: string) => Promise<CheckpointChange[]>
  restore?: (turnId: string) => Promise<void>
  regenerate?: (turnId: string) => Promise<void>
  listBranches?: () => Promise<{ current: string | null; branches: string[] }>
  switchBranch?: (branch: string) => Promise<void>
}

export const RemoteTaskContext = createContext<RemoteTaskSource | null>(null)

export function useRemoteTask(): RemoteTaskSource | null {
  return useContext(RemoteTaskContext)
}
