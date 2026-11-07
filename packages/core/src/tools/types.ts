// 工具执行失败时抛这个错，message 原样返回给模型，让它自己纠正
export class ToolError extends Error {}

export interface ToolContext {
  cwd: string
  rgPath: string
  bashPath: string | null
  signal: AbortSignal
  // 绝对路径 → 模型最近一次读到（或写入）时的内容哈希，用来拦截没读过或已过期的编辑
  readHashes: Map<string, string>
  // 由会话层决定：自动放行、问用户，或直接拒绝；拒绝时 reason 会告诉模型
  requestCommandPermission(command: string): Promise<{ allowed: true } | { allowed: false; reason: string }>
  // 用户为项目配置的检查命令，自动放行
  trustedCommands: string[]
  // 禁写目录（相对项目根目录）
  readOnlyPaths: string[]
  // 项目外可以只读访问的目录（Skill 目录），读文件、列文件、搜索、大纲能用绝对路径访问
  readRoots: string[]
}

export interface ToolOutput {
  // 给模型看的结果
  text: string
  // 给界面的标题，不填就用工具默认标题
  title?: string
  diff?: { path: string; oldText: string | null; newText: string }
  edited?: boolean
  // 命令的完整输出（已截断），界面上可展开查看
  terminalOutput?: string
}
