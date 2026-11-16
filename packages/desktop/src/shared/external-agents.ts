import type { ExternalAgentDetection } from '@diffra/core/types'

// 外接智能体（v2）：通过 ACP 驱动的命令行智能体。账号登录由各 CLI 自己在终端里完成，Diffra 不经手、不保存它们的账号。
// 环境变量的值可能是密钥，和 MCP 一样加密存在密钥库，设置文件里只记名字
export interface ExternalAgentConfig {
  id: string
  // 预设（EXTERNAL_AGENT_PRESETS 的 id）；自己加的是 null
  presetId: string | null
  name: string
  command: string
  args: string[]
  envNames: string[]
}

// 保存时带上值；value 为 null 表示沿用已保存的值
export interface ExternalAgentInput {
  id?: string
  presetId: string | null
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string | null }>
}

export interface ExternalAgentPreset {
  id: string
  name: string
  // 按顺序找：本机装了 ACP 命令就用它，否则用最后一条（npx 临时下载官方适配器）
  launch: Array<{ command: string; args: string[] }>
  // 要先装好、在终端里登录过的命令行工具
  cli: string
  install: string
  login: string
  docs: string
  note: string
}

// 启动方式按各家官方文档核对过（2026-11-15）：Claude Code 和 Codex 走 agentclientprotocol 组织维护的适配器
// （@zed-industries/codex-acp 已标废弃，换成 @agentclientprotocol/codex-acp）；Gemini CLI 的 --experimental-acp 已改名 --acp
export const EXTERNAL_AGENT_PRESETS: ExternalAgentPreset[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    launch: [
      { command: 'claude-agent-acp', args: [] },
      { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
    ],
    cli: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: '在终端运行 claude，按提示登录',
    docs: 'https://github.com/agentclientprotocol/claude-agent-acp',
    note: '经 ACP 适配器驱动 Claude Code，用它自己的登录和模型。第一次用 npx 启动会先下载适配器。',
  },
  {
    id: 'codex',
    name: 'Codex',
    launch: [
      { command: 'codex-acp', args: [] },
      { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
    ],
    cli: 'codex',
    install: 'npm install -g @openai/codex',
    login: '在终端运行 codex login',
    docs: 'https://github.com/agentclientprotocol/codex-acp',
    note: '经 ACP 适配器驱动 Codex，用它自己的登录和模型。第一次用 npx 启动会先下载适配器。',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    launch: [{ command: 'gemini', args: ['--acp'] }],
    cli: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    login: '在终端运行 gemini，选择登录方式',
    docs: 'https://geminicli.com/docs/cli/acp-mode/',
    note: '旧版本只认 --experimental-acp，检测报版本不对时先升级。',
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    launch: [{ command: 'copilot', args: ['--acp'] }],
    cli: 'copilot',
    install: 'npm install -g @github/copilot',
    login: '在终端运行 copilot，用 /login 登录 GitHub',
    docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server',
    note: 'GitHub 标的是公开预览，ACP 的行为以后可能会变。',
  },
]

export function externalAgentPreset(id: string | null): ExternalAgentPreset | null {
  return EXTERNAL_AGENT_PRESETS.find((preset) => preset.id === id) ?? null
}

// 本机找没找到预设要的命令：cliPath 是登录用的命令行工具，launch 是建议的启动方式（找到的 ACP 命令，或者 npx）
export interface ExternalAgentDiscovery {
  presetId: string
  cliPath: string | null
  launch: { command: string; args: string[] }
  launchPath: string | null
}

// 检测结果按失败类型给的下一步
export function detectionAdvice(result: ExternalAgentDetection, preset: ExternalAgentPreset | null): string | null {
  if (result.ok) return null
  switch (result.kind) {
    case 'not-installed':
      return preset ? `先装好：${preset.install}，再回来重新检测` : '检查命令是否装好，或者填可执行文件的完整路径'
    case 'version':
      return preset ? `升级到支持 ACP 的版本：${preset.install}` : '升级到支持 ACP 的版本，或者检查启动参数'
    case 'auth':
      return preset ? preset.login : '先在终端里运行它并登录'
    case 'timeout':
      return '第一次用 npx 启动要下载，网络慢时可以先在终端里把适配器装好（npm install -g），再重新检测'
    default:
      return preset ? `在终端里运行一次 ${preset.cli}，看它自己报什么错` : '在终端里运行这条命令，看它自己报什么错'
  }
}

export const EXTERNAL_DETECTION_KIND_LABELS: Record<Exclude<ExternalAgentDetection, { ok: true }>['kind'], string> = {
  'not-installed': '没装',
  version: '版本不对',
  'start-failed': '启动失败',
  timeout: '没有应答',
  auth: '还没登录',
  exited: '进程退出',
  unsupported: '不支持',
}
