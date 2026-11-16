import type { McpServerConfig } from './settings'

// 「扩展」页的内置目录（第 594 步）：随版本更新，不从网上拉。地址、请求头写法、插件仓库都按各家官方文档核对过（2026-11-13）。
// 「贴 Token 一键装」和浏览器登录（OAuth，v2 起，Vercel 和 Railway 的远程版靠它）两种

// 本机要先装好的命令；只检测、给安装说明，不替用户装
export const PREREQUISITES = {
  npx: { command: 'npx', label: 'Node.js', guideUrl: 'https://nodejs.org/zh-cn/download' },
  uvx: { command: 'uvx', label: 'uv', guideUrl: 'https://docs.astral.sh/uv/getting-started/installation/' },
  docker: { command: 'docker', label: 'Docker', guideUrl: 'https://docs.docker.com/get-started/get-docker/' },
  railway: { command: 'railway', label: 'Railway CLI', guideUrl: 'https://docs.railway.com/guides/cli' },
} as const

export type Prerequisite = keyof typeof PREREQUISITES
export type PrerequisiteState = Record<Prerequisite, boolean>

// 要用户填的 Key：远程服务放进请求头 header，值按 template 拼（{key} 换成填的内容）；optional 的不填就不带这个请求头
export interface CatalogKey {
  label: string
  header: string
  template: string
  helpUrl: string
  hint: string
  optional: boolean
}

export type CatalogConnection =
  | { transport: 'http'; url: string }
  | { transport: 'stdio'; command: string; args: string[]; requires: Prerequisite }
  // 只支持浏览器登录（OAuth）：装的时候用系统浏览器登录，令牌加密存在本机
  | { transport: 'oauth'; url: string }

export type McpGroup = 'code' | 'data' | 'docs'

export const MCP_GROUP_LABELS: Record<McpGroup, string> = {
  code: '代码托管和项目管理',
  data: '数据库、部署和监控',
  docs: '文档、搜索和浏览器',
}

export interface CatalogMcp {
  // 装上后的服务器名，也是模型看到的工具名前缀
  id: string
  name: string
  publisher: string
  group: McpGroup
  description: string
  recommended: boolean
  connection: CatalogConnection
  key: CatalogKey | null
  // 装之前要知道的事，比如登录、和内置功能重叠
  note: string | null
}

export type PluginGroup = 'method' | 'vendor'

export const PLUGIN_GROUP_LABELS: Record<PluginGroup, string> = {
  method: '工作方法',
  vendor: '服务商的官方 Skill',
}

export interface CatalogPlugin {
  id: string
  // 插件清单里的名字：装上后按它认出来
  pluginName: string
  name: string
  publisher: string
  group: PluginGroup
  description: string
  // 里面有什么，列表上显示
  contents: string
  recommended: boolean
  repo: string
  // 插件在仓库里的子目录，null 是仓库根目录
  path: string | null
  note: string | null
  // 带着只支持浏览器登录的 MCP 服务器，这一版装上也连不上
  unavailable: string | null
}

const OFFICIAL_PLUGINS = 'https://github.com/anthropics/claude-plugins-official.git'

export const CATALOG_MCP: CatalogMcp[] = [
  {
    id: 'github',
    name: 'GitHub',
    publisher: '官方',
    group: 'code',
    description: '读写仓库、Issue、PR 和 Actions',
    recommended: true,
    connection: { transport: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    key: {
      label: 'GitHub Token',
      header: 'Authorization',
      template: 'Bearer {key}',
      helpUrl: 'https://github.com/settings/personal-access-tokens/new',
      hint: '要给它操作的仓库的读写权限。',
      optional: false,
    },
    note: null,
  },
  {
    id: 'linear',
    name: 'Linear',
    publisher: '官方',
    group: 'code',
    description: '查和改 Issue、项目、评论',
    recommended: true,
    connection: { transport: 'http', url: 'https://mcp.linear.app/mcp' },
    key: {
      label: 'API Key',
      header: 'Authorization',
      template: 'Bearer {key}',
      helpUrl: 'https://linear.app/settings/account/security',
      hint: '在「Personal API keys」里创建；只想让它看不让它改，就只给 Read 权限。',
      optional: false,
    },
    note: null,
  },
  {
    id: 'supabase',
    name: 'Supabase',
    publisher: '官方',
    group: 'data',
    description: '查表、跑 SQL、看日志、管项目',
    recommended: true,
    connection: { transport: 'http', url: 'https://mcp.supabase.com/mcp' },
    key: {
      label: 'Access Token',
      header: 'Authorization',
      template: 'Bearer {key}',
      helpUrl: 'https://supabase.com/dashboard/account/tokens',
      hint: '这个 Token 能管你账号下的所有项目，智能体改数据库前会先问你。',
      optional: false,
    },
    note: null,
  },
  {
    id: 'neon',
    name: 'Neon',
    publisher: '官方',
    group: 'data',
    description: '管理 Postgres 数据库和分支、跑 SQL',
    recommended: false,
    connection: { transport: 'http', url: 'https://mcp.neon.tech/mcp' },
    key: {
      label: 'API Key',
      header: 'Authorization',
      template: 'Bearer {key}',
      helpUrl: 'https://console.neon.tech/app/settings?modal=create_api_key',
      hint: '用组织的 Key 可以只让它碰这个组织的项目。',
      optional: false,
    },
    note: null,
  },
  {
    id: 'railway',
    name: 'Railway',
    publisher: '官方',
    group: 'data',
    description: '部署服务、看日志、管环境变量',
    recommended: true,
    connection: { transport: 'stdio', command: 'railway', args: ['mcp'], requires: 'railway' },
    key: null,
    note: '用 Railway CLI 的登录状态，先在终端里运行 railway login。',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    publisher: '官方',
    group: 'data',
    description: '查报错、看调用栈、处理 Issue',
    recommended: true,
    connection: { transport: 'http', url: 'https://mcp.sentry.dev/mcp' },
    key: {
      label: 'Auth Token',
      header: 'Authorization',
      template: 'Sentry-Bearer {key}',
      helpUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
      hint: '创建个人 Token 时勾上 org:read、project:read、project:write、team:read、event:write。',
      optional: false,
    },
    note: null,
  },
  {
    id: 'vercel',
    name: 'Vercel',
    publisher: '官方',
    group: 'data',
    description: '看部署和构建日志、查项目',
    recommended: true,
    connection: { transport: 'oauth', url: 'https://mcp.vercel.com' },
    key: null,
    note: '用浏览器登录 Vercel 账号。登录状态加密保存在本机，可以随时退出登录。',
  },
  {
    id: 'railway-remote',
    name: 'Railway（远程版）',
    publisher: '官方',
    group: 'data',
    description: '不用装 CLI：部署服务、看日志、管环境变量',
    recommended: false,
    connection: { transport: 'oauth', url: 'https://mcp.railway.com' },
    key: null,
    note: '用浏览器登录 Railway 账号（Railway 标的是公开测试）。登录状态加密保存在本机，可以随时退出登录。',
  },
  {
    id: 'context7',
    name: 'Context7',
    publisher: 'Upstash',
    group: 'docs',
    description: '查各个库最新版本的文档和示例',
    recommended: true,
    connection: { transport: 'http', url: 'https://mcp.context7.com/mcp' },
    key: {
      label: 'API Key',
      header: 'Authorization',
      template: 'Bearer {key}',
      helpUrl: 'https://context7.com/dashboard?tab=settings',
      hint: '不填也能用，填了限额更高。',
      optional: true,
    },
    note: null,
  },
  {
    id: 'tavily',
    name: 'Tavily',
    publisher: '官方',
    group: 'docs',
    description: '联网搜索、抓取网页内容',
    recommended: true,
    connection: { transport: 'http', url: 'https://mcp.tavily.com/mcp/' },
    key: {
      label: 'API Key',
      header: 'Authorization',
      template: 'Bearer {key}',
      helpUrl: 'https://app.tavily.com',
      hint: '以 tvly- 开头。',
      optional: false,
    },
    note: null,
  },
  {
    id: 'exa',
    name: 'Exa',
    publisher: '官方',
    group: 'docs',
    description: '搜代码示例和技术资料',
    recommended: false,
    connection: { transport: 'http', url: 'https://mcp.exa.ai/mcp' },
    key: {
      label: 'API Key',
      header: 'Authorization',
      template: 'Bearer {key}',
      helpUrl: 'https://dashboard.exa.ai/api-keys',
      hint: '不填也能用，但有限额。',
      optional: true,
    },
    note: null,
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    publisher: '官方',
    group: 'docs',
    description: '把网页抓成干净的文字',
    recommended: false,
    connection: { transport: 'http', url: 'https://mcp.firecrawl.dev/v2/mcp' },
    key: {
      label: 'API Key',
      header: 'Authorization',
      template: 'Bearer {key}',
      helpUrl: 'https://www.firecrawl.dev/app/api-keys',
      hint: '不填只能抓单页和搜索，整站爬取要 Key。',
      optional: true,
    },
    note: null,
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    publisher: 'Google',
    group: 'docs',
    description: '调试 Chrome 里的页面',
    recommended: false,
    connection: { transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], requires: 'npx' },
    key: null,
    note: '和 Diffra 内置浏览器有重叠，需要 Chrome 的调试能力时再装。',
  },
  {
    id: 'playwright',
    name: 'Playwright',
    publisher: 'Microsoft',
    group: 'docs',
    description: '用浏览器自动化跑页面流程',
    recommended: false,
    connection: { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], requires: 'npx' },
    key: null,
    note: '和 Diffra 内置浏览器有重叠，需要脚本化测页面时再装。',
  },
]

export const CATALOG_PLUGINS: CatalogPlugin[] = [
  {
    id: 'superpowers',
    pluginName: 'superpowers',
    name: 'Superpowers',
    publisher: '社区',
    group: 'method',
    description: '头脑风暴、测试先行、系统化调试',
    contents: 'Skill · 1 个钩子',
    recommended: true,
    repo: 'https://github.com/obra/superpowers.git',
    path: null,
    note: null,
    unavailable: null,
  },
  {
    id: 'feature-dev',
    pluginName: 'feature-dev',
    name: 'Feature Dev',
    publisher: 'Anthropic',
    group: 'method',
    description: '读代码、出方案、再实现',
    contents: '命令 · 3 个子智能体',
    recommended: true,
    repo: OFFICIAL_PLUGINS,
    path: 'plugins/feature-dev',
    note: null,
    unavailable: null,
  },
  {
    id: 'pr-review-toolkit',
    pluginName: 'pr-review-toolkit',
    name: 'PR Review Toolkit',
    publisher: 'Anthropic',
    group: 'method',
    description: '分几个角度审查改动',
    contents: '命令 · 6 个子智能体',
    recommended: true,
    repo: OFFICIAL_PLUGINS,
    path: 'plugins/pr-review-toolkit',
    note: null,
    unavailable: null,
  },
  {
    id: 'frontend-design',
    pluginName: 'frontend-design',
    name: 'Frontend Design',
    publisher: 'Anthropic',
    group: 'method',
    description: '做出有设计感的前端界面',
    contents: 'Skill',
    recommended: true,
    repo: OFFICIAL_PLUGINS,
    path: 'plugins/frontend-design',
    note: null,
    unavailable: null,
  },
  {
    id: 'commit-commands',
    pluginName: 'commit-commands',
    name: 'Commit Commands',
    publisher: 'Anthropic',
    group: 'method',
    description: '提交、推送、开 PR',
    contents: '3 个命令',
    recommended: true,
    repo: OFFICIAL_PLUGINS,
    path: 'plugins/commit-commands',
    note: null,
    unavailable: null,
  },
  {
    id: 'skill-creator',
    pluginName: 'skill-creator',
    name: 'Skill Creator',
    publisher: 'Anthropic',
    group: 'method',
    description: '写新的 Skill 并测效果',
    contents: 'Skill',
    recommended: true,
    repo: OFFICIAL_PLUGINS,
    path: 'plugins/skill-creator',
    note: '评测部分要本机装 Python。',
    unavailable: null,
  },
  {
    id: 'supabase-skills',
    pluginName: 'supabase',
    name: 'Supabase',
    publisher: '官方',
    group: 'vendor',
    description: '数据库、认证、存储的用法',
    contents: '2 个 Skill',
    recommended: false,
    repo: 'https://github.com/supabase-community/supabase-plugin.git',
    path: null,
    note: null,
    unavailable: null,
  },
  {
    id: 'tavily-skills',
    pluginName: 'tavily',
    name: 'Tavily',
    publisher: '官方',
    group: 'vendor',
    description: '用 tvly 命令行搜索和调研',
    contents: '8 个 Skill',
    recommended: false,
    repo: 'https://github.com/tavily-ai/skills.git',
    path: null,
    note: '要本机装 tvly 命令行。',
    unavailable: null,
  },
  {
    id: 'railway-skills',
    pluginName: 'railway',
    name: 'Railway',
    publisher: '官方',
    group: 'vendor',
    description: '部署项目和数据库的做法',
    contents: 'Skill · 1 个钩子 · MCP',
    recommended: false,
    repo: 'https://github.com/railwayapp/railway-skills.git',
    path: 'plugins/railway',
    note: null,
    unavailable: '里面的 MCP 服务器只支持浏览器登录',
  },
  {
    id: 'vercel-skills',
    pluginName: 'vercel',
    name: 'Vercel',
    publisher: '官方',
    group: 'vendor',
    description: '部署、环境变量和构建排错',
    contents: 'Skill · 钩子 · MCP',
    recommended: false,
    repo: 'https://github.com/vercel/vercel-plugin.git',
    path: null,
    note: null,
    unavailable: '里面的 MCP 服务器只支持浏览器登录',
  },
]

export function catalogMcp(id: string): CatalogMcp | undefined {
  return CATALOG_MCP.find((entry) => entry.id === id)
}

export function catalogPlugin(id: string): CatalogPlugin | undefined {
  return CATALOG_PLUGINS.find((entry) => entry.id === id)
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase()

// 目录里的服务装上了没有：按目录给的服务器名，或者同样的地址、同样的命令认（自己手动加的也算）
export function installedServer(entry: CatalogMcp, servers: McpServerConfig[]): McpServerConfig | undefined {
  const { connection } = entry
  return servers.find(
    (server) =>
      server.name.toLowerCase() === entry.id ||
      (connection.transport === 'http' && server.transport === 'http' && sameUrl(server.url, connection.url)) ||
      (connection.transport === 'stdio' && server.transport === 'stdio' && server.command === connection.command && server.args.join(' ') === connection.args.join(' ')),
  )
}

// 装上的服务器对应目录里的哪一项（已安装页显示前置条件用）
export function catalogEntryOf(server: McpServerConfig): CatalogMcp | undefined {
  return CATALOG_MCP.find((entry) => installedServer(entry, [server]) !== undefined)
}
