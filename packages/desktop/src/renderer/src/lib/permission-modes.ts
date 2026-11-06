import type { PermissionMode } from '@diffra/core/types'

export const PERMISSION_MODES: Array<{ mode: PermissionMode; label: string; description: string }> = [
  { mode: 'ask', label: '每次询问', description: '只读命令和检查命令自动执行，其余命令执行前都问你。' },
  {
    mode: 'auto',
    label: '自动审批',
    description: '普通命令自动执行；涉及密钥文件、禁写目录、git 推送或重置、安装依赖、下载、递归删除时仍然问你。',
  },
  { mode: 'full', label: '完全访问', description: '命令不再询问。危险命令清单、受保护文件和禁写目录照旧拦截。' },
]

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find((item) => item.mode === mode)?.label ?? mode
}
