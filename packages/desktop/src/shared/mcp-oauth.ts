// 浏览器登录（OAuth）的 MCP 服务器的登录状态，界面看到的样子；和 core 的 McpOAuthState 一样（界面不引 core 的 Node 代码）
export interface McpOAuthState {
  status: 'signed-out' | 'signed-in' | 'expired'
  expiresAt: string | null
  scope: string | null
}
