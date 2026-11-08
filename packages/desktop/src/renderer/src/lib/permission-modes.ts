import type { PermissionMode } from '@diffra/core/types'

// summary 给输入框的权限菜单用，一行放得下；设置页显示完整的 description
export const PERMISSION_MODES: Array<{ mode: PermissionMode; label: string; summary: string; description: string }> = [
  { mode: 'ask', label: '每次询问', summary: '只读和检查命令自动执行，其余先问你', description: '只读命令和检查命令自动执行，其余命令执行前都问你。' },
  {
    mode: 'auto',
    label: '自动审批',
    summary: '常规命令自动执行，敏感操作仍会询问',
    description: '普通命令自动执行；涉及密钥文件、禁写目录、git 推送或重置、安装依赖、下载、递归删除时仍然问你。',
  },
  { mode: 'full', label: '完全访问', summary: '命令不再询问，危险操作照旧拦截', description: '命令不再询问。危险命令清单、受保护文件和禁写目录照旧拦截。' },
]

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find((item) => item.mode === mode)?.label ?? mode
}
