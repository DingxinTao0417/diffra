// core 与桌面端共用的纯类型和常量（桌面端界面也会引用，不能依赖 Node API）。
import type { McpServer, SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import type { ModelEndpoint, ModelErrorKind } from './models/types.js'

export * from './models/types.js'
export * from './design-styles.js'
export type {
  McpServer,
  PermissionOption,
  RequestPermissionRequest,
  SessionNotification,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk'

// 项目钩子：用户填的命令，在固定的时机跑。afterEdit 是智能体改完一个文件之后（环境变量 DIFFRA_FILE 是那个文件）；
// beforeCommand 是智能体执行命令之前（DIFFRA_COMMAND 是命令，退出码 2 表示拦下）；turnEnd 是一轮结束时（DIFFRA_STOP 是停下的原因，正常结束是 done）
export interface SessionHooks {
  afterEdit?: string | null
  beforeCommand?: string | null
  turnEnd?: string | null
}

export interface SessionChecks {
  // 旧的「快速检查」：第 431 步起不再每步跑，只在 beforeFinish 没填时当完成检查用；界面不再单独编辑它
  afterEdit: string | null
  // 结束门禁跑的检查（模型改过文件、停下时），比如 pnpm typecheck && pnpm test；改的过程中不跑
  beforeFinish: string | null
}

// 命令权限：ask 只读命令和检查命令以外都问；auto 只问有风险的命令；full 不再询问。
// 三档都一样的：危险命令直接拒绝，提到密钥文件、改禁写目录的命令要用户确认
export type PermissionMode = 'ask' | 'auto' | 'full'

export type RuleLevel = 'required' | 'recommended'

export interface Rule {
  id: string
  level: RuleLevel
  // 规则包里的小节标题，比如「异常」
  section: string | null
  text: string
}

// 编码规范的规则包：内置的在 packages/core/rules/packs，用户也可以导入自己写的 markdown
export interface RulePack {
  id: string
  name: string
  // 适用的语言，['*'] 表示不分语言
  languages: string[]
  source: string
  license: string
  rules: Rule[]
}

export interface SessionRules {
  // 已经按项目设置过滤好的规则包；core 再按项目里出现的语言挑选
  packs: RulePack[]
  // 完成前用评审模型按规则审查这一轮的改动
  review: boolean
}

// 模型所在的供应商，只用来记用量；没有时（比如测试）记成 null
export interface ModelProvider {
  id: string
  name: string
}

// 三层安全检查：静态检查完成前按规则匹配本轮新增的代码，轻量扫描完成前用评审模型审查本轮改动，
// 深度扫描在智能体提交或推送前问用户要不要先扫；没传 deepScan 时不问
export interface SessionSecurity {
  staticCheck: boolean
  lightScan: boolean
  deepScan?: boolean
  // v2 · M10，旧客户端不传：污点分析、新依赖的许可证、装了 Semgrep 时用它扫（都跟着静态检查在完成前跑，没写当开）
  taint?: boolean
  licenses?: boolean
  semgrep?: boolean
}

// 设置里改了检查开关，所有已经打开的会话下一次检查就按新值（SESSION_EXT_METHODS.securityConfigure）
export interface CheckSwitches extends SessionSecurity {
  // 完成前的规范审查，对应 SessionRules.review
  review: boolean
  // 按项目单独设的开关（v2 · M10）：项目目录 → 覆盖哪几项；没列的项目用上面的
  projects?: Record<string, Partial<SessionSecurity & { review: boolean }>>
}

// 单次任务的上限：上下文用到窗口的百分之多少时压缩；最多跑多少步，null 不限（靠卡死检测兜底）
export interface SessionLimits {
  compactAtPercent: number
  maxSteps: number | null
  // 目标模式最多自主推进几轮
  goalMaxRounds: number
}

export const TASK_PROGRESS_META_KEY = 'taskState'
export interface TaskProgressView {
  status: 'running' | 'waiting' | 'blocked' | 'cancelled' | 'completed'
  reason: string | null
  requirements: Array<{ id: string; title: string; receiptId: string | null }>
  // 有改动还没经过完成门禁（撤销之后、或带着未验证的改动停下）
  needsVerification?: boolean
}

// 检查命令、静态检查、轻量扫描、规范审查卡片结束时的 tool_call_update._meta.diffra.result。ACP 的 status 照旧：
// warned 只有提醒或附注；partial 只看了一部分（改动被截断、依赖审计没跑完）；error 工具或评审模型出错，这次不拦截
export type CheckResult = 'passed' | 'warned' | 'partial' | 'error' | 'failed'
// 完成卡（结束门禁的结论）的 _meta.diffra.verification；reused 是复用了这份工作区已经通过的验证
export type FinishVerification = 'verified' | 'reused' | 'unverified' | 'no-edits' | 'failed'
// 一轮结束时的 session_info_update._meta.diffra.turnOutcome，和 taskState 在同一条更新里，每轮只发一次。
// finish 是本轮所有通过的结束门禁合并后的值（unverified > verified > no-edits，reused 算 verified），没改文件、没过门禁时为 null；
// stop 是没过结束门禁就停下的原因，正常结束为 null。no-finish 只有旧记录里有（以前改了文件没调 finish）
export const TURN_OUTCOME_META_KEY = 'turnOutcome'
// check-exhausted 只有旧记录里有：快速检查不再每步跑，不会再因它停下。deep-scan 是用户在提交前选了先做深度扫描，客户端接着发起一轮深度扫描
// agent-error 是外接智能体（ExternalAgentSpec）的进程没起来、中途退出或没有应答，这一轮停在这里
export type TurnStop = 'paused' | 'cancelled' | 'no-finish' | 'gate-exhausted' | 'check-exhausted' | 'stuck' | 'model-error' | 'step-limit' | 'context-limit' | 'goal-exhausted' | 'deep-scan' | 'agent-error'
export interface TurnOutcome {
  finish: 'verified' | 'unverified' | 'no-edits' | null
  stop: TurnStop | null
  // stop 是 model-error 时模型接口出错的类型，界面按它说明原因、给出下一步
  errorKind?: ModelErrorKind
  // stop 是 agent-error 时外接智能体出错的类型和原因
  agentError?: { kind: ExternalAgentErrorKind; message: string }
}
// 模型一直没吐数据时的 session_info_update._meta.diffra.modelSilentSince：最后一次收到数据的时刻（ISO），
// 又收到数据、重发了这一步或这一步正常结束时发 null；被停止时不发，记录里留着「停下时模型已经多久没输出」。
// 子智能体的同一条更新里带 agent（AgentTag），界面按智能体分开记
export const MODEL_SILENCE_META_KEY = 'modelSilentSince'
// core 推给客户端的每条 session/update 的 _meta.diffra.seq：按会话递增（从 1 起），只在 core 内存里，存进记录的更新不带。
// 设备连接拿它和 _diffra/remote/snapshot 的 seq 比，去重、续传
export const UPDATE_SEQ_META_KEY = 'seq'

// 只有用户能回答的问题：第一个选项是默认答案，它的 text 原样是提示词里的一行；换成别的选项就把那一行换成那个选项的 text
export interface PromptQuestion {
  question: string
  options: Array<{ label: string; text: string }>
}

// 定位轮交回的结果，放在「定位结果」那张卡的 tool_call._meta.diffra.diagnosis 里。
// evidence 的 itemId 是对话里那一步的 id（子智能体的步骤带它的前缀），点一下滚过去；
// fallback 为 true 时是模型没交结果，按记录拼的通用版本
// 对话里的可视化：show_visual 那张卡的 tool_call._meta.diffra.visual，{ title, code }；code 是 HTML 片段或 SVG
export const VISUAL_META_KEY = 'visual'
export const VISUAL_MAX_CHARS = 1_000_000
// 可视化的快照（第 670 步）：界面画好后截成压缩图记回那张卡，放在追加的 tool_call_update._meta.diffra.visualSnapshot，
// 按 ACP 的图片内容 { type: 'image', mimeType, data } 存。远程设备不跑可视化的脚本，显示这张图；同步时保留（packages/remote 的 redact）
export const VISUAL_SNAPSHOT_META_KEY = 'visualSnapshot'
export const VISUAL_SNAPSHOT_TYPES = ['image/webp', 'image/png', 'image/jpeg'] as const
export const VISUAL_SNAPSHOT_MAX_CHARS = 200_000

// 改动卡片（diff 内容）的 _meta.diffra：oldText、newText 只是变化的那段（前后各留几行上下文），不是整份文件。
// 长任务里每次改动都带整份文件，会话记录涨到几十 MB，载入时超过 ACP 单条消息的上限。
// startLine 是这一段从第几行开始（1 起），oldLines、newLines 是两段各几行（空字符串分不清是 0 行还是 1 个空行）。
// base 是改之前的整份文件：一轮里第一次改这个文件、或者它在两次改动之间被别处改过时才带。
// 界面按顺序重放一轮的改动就能还原每次改动前后的全文，「本轮交付」照旧按第一次改之前和最后的全文算净改动。
// 旧记录没有这个字段，oldText、newText 是整份文件
export const EDIT_DIFF_META_KEY = 'edit'
export interface EditDiffMeta {
  startLine: number
  oldLines: number
  newLines: number
  base?: string
  // apply_patch 删掉了这个文件
  deleted?: boolean
}
// 任务之间互通（task_send、task_create）：消息是哪个任务发来的
export interface TaskSource {
  sessionId: string
  title: string
}
// 设备连接：这一轮是哪台远程设备发来的（docs/decisions.md「设备连接」）。name 是本机给它记的名称
export interface RemoteSource {
  deviceId: string
  name: string
}
export type TaskActionParams =
  | { sessionId: string; action: 'send'; target: string; message: string; from: TaskSource }
  | { sessionId: string; action: 'create'; project: string | null; title: string | null; design: boolean; message: string; from: TaskSource }
// queued：对方正在跑，消息排在它这一轮后面
export type TaskActionResult = { ok: true; sessionId: string; title: string; queued: boolean } | { ok: false; error: string }

export const DIAGNOSIS_META_KEY = 'diagnosis'

// 优化提示词交回的结果
export interface PromptEnhancement {
  prompt: string
  questions: PromptQuestion[]
}
// 首页（还没有任务）优化提示词的用量记在这个任务 id 下，用量页按它写名字
export const PROMPT_ENHANCE_USAGE_ID = 'prompt-enhance'
// 架构分析里的模型解读、目标架构提案：不属于任何任务，用量记在这个 id 下
export const ARCHITECTURE_USAGE_ID = 'architecture'
export interface Diagnosis {
  // 定位的是哪一轮、哪个子智能体（agent 是它的名字），「重新定位」照着再来一次
  target: { turnId: string; cardId: string | null; agent: string | null }
  cause: string
  evidence: Array<{ itemId: string; title: string; note: string }>
  done: string[]
  remaining: string[]
  prompt: string
  questions: PromptQuestion[]
  fallback: boolean
}

export const TERMINAL_DEFAULT_LINES = 80
export const TERMINAL_MAX_LINES = 200
export const TERMINAL_READ_PERMISSION_PREFIX = 'terminal-read:'
// 截图时可以指定的视口宽度范围（CSS 像素），从小屏手机到常见桌面
export const SCREENSHOT_MIN_WIDTH = 320
export const SCREENSHOT_MAX_WIDTH = 1920
export const EXTERNAL_ACCESS_SCOPE = 'exact-path'
// 提交或推送前问要不要先做深度扫描的确认卡：rawInput.scope 是它，界面按它出标题和说明
export const DEEP_SCAN_ASK_SCOPE = 'deep-scan-before-commit'

// 格式明确的密钥：安全检查按它打回写进代码的密钥，设备连接发出会话前按它脱敏。
// 不带 g 标志，test 没有状态，可以共用；要全局替换的按 source 另建
export const SECRET_FORMATS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'AWS 访问密钥', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub 令牌', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub 细粒度令牌', pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: '模型服务的 API Key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Stripe 密钥', pattern: /\b[rs]k_live_[0-9A-Za-z]{24,}\b/ },
  { name: 'Slack 令牌', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API Key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: '私钥', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
]

export const REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface SessionModel {
  reasoningEffort?: ReasoningEffort
  endpoint: ModelEndpoint
  modelId: string
  contextWindow: number | null
  provider: ModelProvider | null
  // 用户在模型设置里打开了「图片」：提问可以带图片
  supportsImages?: boolean
  // 模型设置里的「最大输出」；null 或没有时按协议的默认值
  maxOutputTokens?: number | null
}

// 提问里带的图片，base64
export const PROMPT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export interface PromptImage {
  mimeType: (typeof PROMPT_IMAGE_TYPES)[number]
  data: string
}

// session/new 的 _meta.diffra
export interface SessionConfig {
  model: SessionModel
  // 「评审」角色的模型；null 时审查用编码模型
  reviewModel: { endpoint: ModelEndpoint; modelId: string; provider: ModelProvider | null } | null
  // 「规划」角色的模型；null 时出计划用编码模型
  planModel: SessionModel | null
  // 「兜底」角色的模型：编码模型卡住或连续失败时，这一轮剩下的部分换它来做；null 时不换
  fallbackModel: SessionModel | null
  checks: SessionChecks
  // 禁写目录（相对项目根目录），比如用户的数据目录：agent 不能改，检查点也不碰
  readOnlyPaths: string[]
  rules: SessionRules
  permissionMode: PermissionMode
  security: SessionSecurity
  limits: SessionLimits
  // 开着的插件：它们的 Skill、命令和 MCP 服务器
  plugins: PluginRef[]
  // 客户端有内置浏览器：给模型浏览器工具，操作由客户端执行
  browser?: boolean
  // 电脑操控（v2）：用户在设置里开了（默认关），给模型 computer 工具，截屏和鼠标键盘由客户端执行
  computer?: boolean
  // 设计任务：建会话时定下，存进会话记录；客户端在每轮开始前把设计面板的工具配置给它
  design?: boolean
  // 设计任务的风格预设（DESIGN_STYLES 的 id）；null 是不用预设。建会话时定下，存进会话记录
  designStyle?: string | null
  // 无项目任务：cwd 是客户端替任务建的文件夹，不是用户的项目。建会话时定下，存进会话记录
  noProject?: boolean
  // 用户填了图库（Pexels / Unsplash）的 Key，设计任务里给找图工具（v2）
  stockPhotos?: boolean
  // 用户在这个项目里选过「始终允许」的命令键（见 permissions.commandKey），建会话时就算允许过
  allowedCommands?: string[]
  // 项目钩子（见 session/hooks.ts）
  hooks?: SessionHooks
  // 项目记忆存放的目录（见 session/memory.ts）；null 或不传是没开自动记忆
  memoryDir?: string | null
  // 检查点仓库的位置；null 表示不打检查点
  checkpointDir: string | null
}

// session/new 响应的 _meta.diffra
export interface SessionInfo {
  bashPath: string | null
  checkpoints: boolean
  // 按项目语言选中、写进提示词的规则包名称
  rulePacks: string[]
  // 这个会话实际生效的安全检查开关（建会话时的设置）
  security: SessionSecurity
  // 这个会话实际生效的检查命令（建会话时的设置）；旧版 core 没有这一项时为 null
  checks?: SessionChecks | null
}

export interface CheckpointChange {
  path: string
  change: 'added' | 'modified' | 'deleted'
}

const RESTORE_NOTICE_PATHS = 50

// 智能体自己列的步骤清单（第 441 步，工具 update_plan，以前叫 todo_write）：core 发一张标题是它的卡片，每次更新用同一个 id 整张替换，
// 内容一行一步（formatSteps），界面按行解析（parseSteps）。叫「步骤」不叫「待办」：侧栏的待办是用户自己记的事
export const STEPS_CARD_TITLE = '步骤'
export type StepStatus = 'pending' | 'in_progress' | 'completed'
export interface StepItem {
  content: string
  status: StepStatus
}
const STEP_MARKS: Record<StepStatus, string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]' }

export function formatSteps(steps: StepItem[]): string {
  return steps.map((step) => `${STEP_MARKS[step.status]} ${step.content.replace(/\s+/g, ' ').trim()}`).join('\n')
}

export function parseSteps(text: string): StepItem[] {
  return text.split('\n').flatMap((line) => {
    const status = (Object.keys(STEP_MARKS) as StepStatus[]).find((key) => line.startsWith(`${STEP_MARKS[key]} `))
    return status ? [{ status, content: line.slice(4) }] : []
  })
}

// 智能体中途问用户（第 442 步，工具 ask_user）：走确认请求，rawInput 是 { scope: ASK_USER_SCOPE, questions }，界面按它画成提问卡。
// 第 673 步起一次最多 4 个问题（界面分成选项卡），每个是选择（单选或多选，选项可以带项目里的预览图）、滑块或选项目里的文件。
// 只有一个单选问题时点选项直接答，optionId 是 ASK_USER_OPTION_PREFIX 加序号；其余填好后「提交」（ASK_USER_SUBMIT），
// 答案按问题的顺序放在回复的 _meta.diffra.askAnswers（ASK_ANSWERS_META_KEY），core 按问题逐个校验。用户不想答时是 ASK_USER_SKIP
export const ASK_USER_SCOPE = 'ask-user'
export const ASK_USER_OPTION_PREFIX = 'ask-user-option-'
export const ASK_USER_SUBMIT = 'ask-user-submit'
export const ASK_USER_SKIP = 'ask-user-skip'
export const ASK_ANSWERS_META_KEY = 'askAnswers'
export interface AskOption {
  label: string
  description?: string
  // core 读好的项目图片
  image?: PromptImage
  // 发给远程设备的提问里预览图不同步，只标出这一项有图
  imageOmitted?: boolean
}
export type AskQuestion =
  | { type: 'choice'; question: string; header?: string; multiSelect: boolean; options: AskOption[] }
  | { type: 'slider'; question: string; header?: string; min: number; max: number; step: number; unit?: string; default?: number }
  | { type: 'file'; question: string; header?: string; multiSelect: boolean }
export interface AskUserInput {
  questions: AskQuestion[]
}
// choice 是选项的序号；files 是项目里的相对路径
export type AskAnswer = { choice: number[] } | { value: number } | { files: string[] }

// 撤销提示：core 记进被撤销的那一轮，客户端撤销时本地追加同样的一条，重新打开任务时按记录重放
export function restoreNotice(changes: CheckpointChange[]): { title: string; description: string | null } {
  const lines = changes.slice(0, RESTORE_NOTICE_PATHS).map((change) => change.path)
  if (changes.length > RESTORE_NOTICE_PATHS) lines.push(`…等 ${changes.length} 个文件`)
  return { title: `已撤销 ${changes.length} 个文件的改动`, description: lines.join('\n') || null }
}

// usage_update 的 _meta.diffra：上下文里各部分的估算 token 数，合计等于模型返回的输入 token 数
export interface UsageBreakdown {
  system: number
  // 项目规则（AGENTS.md 等）和编码规范
  rules: number
  tools: number
  messages: number
}

// 最近一次模型调用返回的缓存用量，放在 usage_update 的 _meta.cache 里给界面；旧记录没有这一项。
// input 是那次调用的输入 token 数：压缩后上下文的估算值会变小，缓存命中率仍要按原来的输入算
export interface UsageCache {
  read: number | null
  write: number | null
  input: number
}

// 存下来的一轮：界面重建这一轮要用的会话更新，按收到的顺序
// 普通的一轮提问，或者用户发起的深度安全扫描
// diagnose：停下或子智能体失败后的「定位问题」，只读地查原因、给修复提示词，不改文件、不改变任务结论
// apply 是直接应用回答里的 diff（第 686 步）
export type TurnKind = 'prompt' | 'deep-scan' | 'plan' | 'goal' | 'compact' | 'diagnose' | 'apply'
export const MANUAL_COMPACTION_PROMPT = '/compact'
// 深度扫描那一轮记下的提问（也是对话里显示的那一行）
export const DEEP_SCAN_TITLES: Record<'task' | 'project', string> = {
  task: '深度安全扫描 · 本任务改动',
  project: '深度安全扫描 · 整个项目',
}

// Skill 从哪里来：项目的 .diffra/skills、自己的 ~/.diffra/skills、插件，兼容读取的 Claude Code、Codex 的目录，以及随 Diffra 带的
export type SkillSource = 'project' | 'user' | 'plugin' | 'claude' | 'codex' | 'builtin'

export interface SkillInfo {
  name: string
  description: string
  source: SkillSource
  dir: string
}

// hooks：用户允许这个插件的钩子时记下的钩子指纹（PluginInfo.hooksFingerprint）；没允许不传。
// 插件的钩子和允许时不一样了（更新、手改）就不跑，要用户重新允许
export interface PluginRef {
  name: string
  dir: string
  hooks?: string
}

// 插件钩子兼容 Claude Code hooks/hooks.json 的这几个时机（见 session/plugin-hooks.ts）
export const PLUGIN_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const
export type PluginHookEvent = (typeof PLUGIN_HOOK_EVENTS)[number]

// matcher：工具类时机按工具名匹配（Bash 是执行命令，Edit、Write 是改文件），SessionStart 按启动方式匹配，空是全部；timeout 是秒
export interface PluginHookInfo {
  event: PluginHookEvent
  matcher: string
  command: string
  timeout: number | null
}

// 插件里有什么；unsupported 是读到了但 Diffra 不支持的部分（output-styles、不支持的钩子时机等）
// 插件注册的富块（第 682 步）：插件的 blocks/blocks.json 声明，模型写 ```kind 的围栏。renders 是内置的富块（数据写法和它一样，
// 界面用它的渲染器画），或者 template（插件里的 HTML 模板，放进和可视化一样的沙箱 iframe，数据在 window.diffraData）。不在主界面跑插件代码
export interface PluginBlock {
  plugin: string
  // 小写、至少一个连字符（deploy-status），免得和代码语言、内置的富块重名
  kind: string
  title: string
  description: string
  renders: string
  // renders 是 template 时插件里那个 HTML 文件的内容
  template?: string
}

export interface PluginInfo {
  name: string
  version: string
  description: string
  commands: string[]
  skills: string[]
  mcpServers: string[]
  // 注册的富块（第 682 步）
  blocks: string[]
  // 子智能体类型，名字带插件名（插件名:类型名）
  agents: string[]
  hooks: PluginHookInfo[]
  // 钩子的指纹，允许钩子时记下；没有钩子时为 null
  hooksFingerprint: string | null
  // LSP 服务器（v2），名字带插件名（插件名-服务器名）
  lspServers: string[]
  unsupported: string[]
}

// 自定义命令：选了以后把正文（$ARGUMENTS 换成参数）放进输入框
export interface CommandInfo {
  name: string
  description: string
  argumentHint: string
  source: SkillSource
  body: string
}

// 页面上的一个位置：最近一次读页面给的 ref，或最近一张截图里的像素坐标（没截过图时就是页面的 CSS 像素）
export type BrowserPoint = { ref: string } | { x: number; y: number }

// 用户在设置里列的网站：主机名，也管它的子域名
export interface BrowserSites {
  allow: string[]
  block: string[]
}

export const BROWSER_MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift'] as const
export type BrowserModifier = (typeof BROWSER_MODIFIERS)[number]

export const BROWSER_WAIT_MAX_SECONDS = 30
export const BROWSER_KEY_REPEAT_MAX = 50
export const BROWSER_KEY_HOLD_MAX_MS = 10_000
export const BROWSER_UPLOAD_MAX_FILES = 10

// 智能体用哪个浏览器：Diffra 内置的，或用户自己的 Chrome、Edge（带着用户的登录状态）
export const BROWSER_BACKENDS = ['builtin', 'chrome', 'edge'] as const
export type BrowserBackend = (typeof BROWSER_BACKENDS)[number]

// 智能体操作浏览器（内置浏览器，或用户的 Chrome、Edge），core 通过 CLIENT_EXT_METHODS.browserAction 请求客户端执行
export type BrowserAction =
  | { action: 'navigate'; url: string }
  | { action: 'history'; direction: 'back' | 'forward' | 'reload' }
  // 一个任务可以开多个标签页；index 从 1 开始
  | { action: 'tabs'; op: 'list' | 'new' | 'select' | 'close'; url: string | null; index: number | null }
  | { action: 'snapshot' }
  // 按文字找元素：只列出名字或文字里含 query 的行，带 ref
  | { action: 'find'; query: string }
  // 页面上看得到的文字
  | { action: 'text' }
  | { action: 'click'; at: BrowserPoint; button: 'left' | 'right' | 'middle'; double: boolean; modifiers: BrowserModifier[] }
  | { action: 'hover'; at: BrowserPoint }
  | { action: 'drag'; from: BrowserPoint; to: BrowserPoint }
  // at 为 null 时在页面正中滚
  | { action: 'scroll'; at: BrowserPoint | null; deltaX: number; deltaY: number }
  // ref 为 null 时输入到当前有焦点的地方，不清空原内容
  | { action: 'type'; ref: string | null; text: string; submit: boolean }
  // key 可以是组合键（Control+A）；holdMs 按住多久再松开（游戏用）
  | { action: 'press'; key: string; repeat: number; holdMs: number }
  | { action: 'select'; ref: string; values: string[] }
  // paths 已经由 core 解析成绝对路径并征得同意
  | { action: 'upload'; ref: string; paths: string[] }
  // 等文字出现、消失，或者只是等几秒
  | { action: 'wait'; text: string | null; textGone: string | null; seconds: number }
  // 处理 alert、confirm、prompt
  | { action: 'dialog'; accept: boolean; promptText: string | null }
  | { action: 'console' }
  | { action: 'network'; filter: string | null; failedOnly: boolean }
  // 在页面里运行脚本，core 已经征得同意
  | { action: 'evaluate'; expression: string }
  // width：按这个视口宽度（CSS 像素）渲染后截图，截完恢复；null 是用户看到的样子。fullPage：整页长图
  | { action: 'screenshot'; width: number | null; fullPage: boolean }
  // 按手机和桌面两种宽度检查布局问题，结果是文字
  | { action: 'layout' }
  // 列出页面上的图片：完整尺寸的网址、像素尺寸和替代文字（找图放进设计稿用）
  | { action: 'images' }
  // 这个任务改用哪个浏览器（只改这个任务，不改设置里的默认）；换到用户的浏览器 core 已经征得同意
  | { action: 'switch'; browser: BrowserBackend }

export type BrowserActionParams = BrowserAction & { sessionId: string }

// text 给模型看；截图时带 image，另带一张给对话里看的小图 thumbnail（第 662 步）
export interface BrowserActionResult {
  text: string
  image: PromptImage | null
  thumbnail?: PromptImage | null
}
// MCP 工具带的界面（第 683 步，MCP Apps / MCP-UI 的写法）：工具结果里内嵌的 ui:// HTML 资源，或者工具定义 _meta 的 "ui/resourceUri"
// 指向的 ui:// 资源（调用后由 core 读出来）。放在 MCP 那一步的 tool_call_update._meta.diffra.mcpUi，界面放进和可视化一样的沙箱 iframe，
// 按 MCP Apps 的 postMessage JSON-RPC 把工具参数和结果交给它。远程设备不发（和可视化代码一样换成占位）
export const MCP_UI_META_KEY = 'mcpUi'
export const MCP_UI_MAX_CHARS = 500_000
export interface McpUiMeta {
  uri: string
  html: string
  server: string
  tool: string
  // 交给界面的工具参数和结果（结果里只有文字内容和 structuredContent）
  input: unknown
  result: { content: Array<{ type: 'text'; text: string }>; structuredContent?: unknown }
}

// 浏览器截图那一步的 _meta.diffra.browserShot：缩略图，按 ACP 的图片内容 { type: 'image', mimeType, data } 存，
// 同步给远程设备时和别的图片一样换成占位（packages/remote 的 redact）
export const BROWSER_SHOT_META_KEY = 'browserShot'

// 开发服务器在客户端的终端里跑，用户看得见、能停；一个任务最多一个
export type DevServerParams =
  | { sessionId: string; action: 'terminal-list' }
  | { sessionId: string; action: 'terminal-read'; terminalId: string; lines: number }
  | { sessionId: string; action: 'start'; command: string; cwd: string }
  | { sessionId: string; action: 'logs' }
  | { sessionId: string; action: 'stop' }

export interface DevServerResult {
  text: string
  // 输出里看到的本地地址
  url: string | null
}

// exec_command 到点还没结束、转到后台接着跑的命令（第 528 步）：内核在列表变化时推给客户端，界面列在「运行中」
export interface BackgroundProcess {
  id: number
  command: string
  cwd: string
  startedAt: number
  // 输出里看到的本地地址（开发服务器）
  url: string | null
}

export interface SessionProcesses {
  sessionId: string
  processes: BackgroundProcess[]
}

// 设计面板（OpenPencil 矢量编辑器）的工具，来自客户端的设计页：name 是 OpenPencil 的工具名，参数是 JSON Schema
export interface DesignToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  // 不改文档（读节点、导出图片等）
  readOnly: boolean
}

// 设计任务每轮开始前由客户端配置给会话（SESSION_EXT_METHODS.sessionConfigure）：之后的轮次带上设计工具和这段说明
export interface SessionDesign {
  tools: DesignToolSpec[]
  instructions: string
}

// 设计任务里找图（v2 · M11，见 session/design-photos.ts）
export interface StockPhotoParams {
  sessionId: string
  query: string
  orientation: 'landscape' | 'portrait' | 'square' | null
  count: number
}

export interface StockPhoto {
  provider: 'pexels' | 'unsplash'
  // 放进画布用的大图地址
  url: string
  // 缩略图，data: 地址（界面的 CSP 只许本地和 data 图片）
  thumb: string
  width: number
  height: number
  alt: string
  photographer: string
  photographerUrl: string
  // 图库上这张图的页面
  pageUrl: string
}

export interface StockPhotoResult {
  photos: StockPhoto[]
  // 某个图库失败的原因（另一个成功时照样返回结果）
  errors: string[]
}

// 找图卡片上的缩略图和署名，放在 tool_call_update 的 _meta.diffra 里
export const STOCK_PHOTOS_META_KEY = 'stockPhotos'

// 智能体调用设计工具，core 通过 CLIENT_EXT_METHODS.designAction 请求客户端在设计页里执行
export interface DesignActionParams {
  sessionId: string
  tool: string
  args: unknown
  // 哪个子智能体在调用（设计页按它加节点锁、画光标）；主智能体自己调时为 null
  agent?: AgentTag | null
}

// text 给模型看；导出图片的工具带 image
export interface DesignActionResult {
  text: string
  image: PromptImage | null
}

// 电脑操控（v2 · M5）：坐标是最近一张截图里的像素，客户端换算到屏幕上。wait 在 core 里等，不发给客户端
export type ComputerAction =
  | { action: 'screenshot' }
  | { action: 'cursor' }
  | { action: 'click'; x: number; y: number; button: 'left' | 'right'; count: 1 | 2 }
  | { action: 'move'; x: number; y: number }
  | { action: 'drag'; x: number; y: number; toX: number; toY: number }
  | { action: 'type'; text: string }
  | { action: 'key'; keys: string }
  | { action: 'scroll'; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { action: 'wait'; seconds: number }

export type ComputerActionParams = { sessionId: string } & Exclude<ComputerAction, { action: 'wait' }>

export interface ComputerActionResult {
  text: string
  image: PromptImage | null
  // 工具卡上的小图
  thumbnail?: PromptImage | null
}

export const COMPUTER_MAX_TEXT = 2000
export const COMPUTER_WAIT_MAX_SECONDS = 10
// 按键：一个键或用 + 连起来的组合，比如 Enter、Ctrl+C、Ctrl+Shift+T、F5
export const COMPUTER_KEY_PATTERN = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$|^[^\s+]$/

// core 请求客户端做的事
export const CLIENT_EXT_METHODS = {
  browserAction: '_diffra/browser/action',
  // 电脑操控（v2）：截屏、鼠标、键盘
  computerAction: '_diffra/computer/action',
  devServer: '_diffra/devserver',
  designAction: '_diffra/design/action',
  // 设计任务里找图（v2 · M11）：客户端用用户的 Pexels / Unsplash Key 搜，返回图片地址和缩略图
  stockPhotos: '_diffra/design/stock-photos',
  // 任务之间互通：智能体给别的任务发消息、新建任务，由客户端载入任务、起一轮
  taskAction: '_diffra/task/action',
} as const

export interface McpPromptInfo {
  name: string
  description: string
  arguments: Array<{ name: string; description: string; required: boolean }>
}

// MCP 服务器连上没有、有哪些工具和 prompt；设置页、任务监控和斜杠菜单用
export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  state: 'connected' | 'failed'
  error: string | null
  tools: Array<{ name: string; description: string }>
  prompts: McpPromptInfo[]
}

// 插件的语言服务器（v2 · M4）：idle 没在跑（还没用到或闲置停了），stopped 是用户停的，failed 是起不来或崩溃次数用完了
export type LspServerState = 'idle' | 'starting' | 'running' | 'restarting' | 'failed' | 'stopped'

export interface LspDiagnostic {
  // 从 0 开始，和 LSP 一样
  line: number
  character: number
  // 1 错误、2 警告、3 信息、4 提示
  severity: number
  message: string
  source: string | null
  code: string | null
}

export interface LspFileDiagnostics {
  // 相对项目目录，/ 分隔
  path: string
  errors: number
  warnings: number
  // 最多几条，错误和警告
  diagnostics: LspDiagnostic[]
}

export interface LspServerStatus {
  name: string
  plugin: string
  extensions: string[]
  state: LspServerState
  error: string | null
  restarts: number
  pid: number | null
  errors: number
  warnings: number
  files: LspFileDiagnostics[]
}

// 查哪些 MCP 服务器：某个任务用的，或者给定项目和配置（首页、设置页还没有任务）
export type McpTarget = { sessionId: string } | { cwd: string; servers: McpServer[]; plugins?: PluginRef[] }

// 列 Skill 和自定义命令：某个任务建立时开着的插件，或者给定项目和插件（首页还没有任务）
export type ListTarget = { sessionId: string } | { cwd: string; plugins?: PluginRef[] }

export interface StoredTurn {
  id: string
  kind: TurnKind
  prompt: string
  startedAt: string
  endedAt: string | null
  // 还没结束就被打断（比如应用退出）时为 null
  stopReason: StopReason | null
  updates: SessionUpdate[]
  // 用户在输入框里给这一轮选的 Skill
  skills: string[]
  // 这一轮提问带的图片
  images: PromptImage[]
  // 撤销到这一轮或更早的轮次之前时写入，多次撤销记最后一次。只说明之后撤销过，不代表这一轮的改动现在不在
  restoredAt?: string
  // 这一轮的提问是另一个任务（智能体用 task_send、task_create）发来的；用户自己发的没有
  from?: TaskSource
  // 这一轮的提问是配对的远程设备发来的；第 360 步加的，旧记录没有
  remote?: RemoteSource
  // 重新生成之前的那几次（第 676 步），按先后排
  versions?: TurnVersion[]
  // 这一轮是在计划卡片上点「按计划执行」发的（v2）：那一轮出计划的 id。计划卡片按这一轮的步骤卡片给每一步打勾；旧记录没有
  fromPlan?: string
}

// 重新生成之前的那一次（第 676 步）：重新生成时旧的这一轮留成只读的「上一次」，挂在新的这一轮上，界面能切换着看、并排对比；
// 没改过文件的那一次能「用这一次」换回来（SESSION_EXT_METHODS.useTurnVersion），模型接着那一次往下做。
// messages 是那一次模型的对话，只在 core 里用（换回来时放回上下文），发给界面前去掉（compactTurns），远程设备不发 versions
export interface TurnVersion {
  startedAt: string
  endedAt: string | null
  stopReason: StopReason | null
  updates: SessionUpdate[]
  // 那一次改没改过文件（有检查点时按检查点算，没有时看有没有改动卡片）
  edited: boolean
  messages?: unknown[]
}

// session/load 响应的 _meta.diffra
export interface LoadedSession {
  info: SessionInfo
  title: string
  turns: StoredTurn[]
  // core 当前的任务状态，比最后一轮里的快照新（撤销、应用退出都会改它）
  taskState?: TaskProgressView
  design: boolean
  noProject: boolean
  // 外接智能体的任务；Diffra 自己的智能体没有
  agent?: SessionAgentRef
}

// session/list 里每个会话 _meta.diffra 带的字段
export interface StoredSessionMeta {
  createdAt: string
  archived: boolean
  turnCount: number
  design: boolean
  noProject: boolean
  // core 里这个会话正在跑一轮
  running: boolean
  // 外接智能体的任务；Diffra 自己的智能体没有
  agent?: SessionAgentRef
}

// 外接智能体（v2）：通过 ACP 驱动的命令行智能体（Claude Code、Codex、Gemini CLI、Copilot CLI）。core 起它的进程，
// 当它的 ACP 客户端，把它的会话更新和确认请求转给界面；账号登录由各 CLI 自己完成，Diffra 不经手。
// 设置里的整份清单由客户端经 SESSION_EXT_METHODS.externalAgents 交给 core，环境变量的值可能是密钥，只在内存里
export interface ExternalAgentSpec {
  id: string
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
}

// 会话记录、列表和 session/load 里记的是哪个外接智能体（名字是建任务时的，设置里改名不影响旧任务的显示）
export interface SessionAgentRef {
  id: string
  name: string
}

// not-installed：找不到命令；version：起来了但不按 ACP 应答或协议版本不对（多半是版本太旧）；start-failed：启动后出错退出；
// timeout：在时限内没有应答；auth：要先在终端里登录这个 CLI；exited：这一轮中途进程退出了；unsupported：它不支持这次请求（比如图片）
export type ExternalAgentErrorKind = 'not-installed' | 'version' | 'start-failed' | 'timeout' | 'auth' | 'exited' | 'unsupported'

// 检测一个外接智能体：找到命令、起进程、做一次 ACP 握手就结束它
export type ExternalAgentDetection =
  | {
      ok: true
      // 实际找到的可执行文件
      path: string
      agentName: string | null
      agentVersion: string | null
      protocolVersion: number
      loadSession: boolean
      images: boolean
      authMethods: Array<{ id: string; name: string; description: string | null }>
    }
  | { ok: false; kind: ExternalAgentErrorKind; message: string; detail: string | null }

// 多候选方案（v2）：同一个需求（和计划）让几个候选各自在一个 git worktree 里做，比较后选一个合回项目。
// 「候选方案」卡片（标题 CANDIDATES_CARD_TITLE）的 _meta.diffra.candidates 是 CandidateRunView，每次状态变了整张替换
export const CANDIDATES_META_KEY = 'candidates'
export const CANDIDATES_CARD_TITLE = '候选方案'
export const MAX_CANDIDATES = 3
export interface CandidateSpec {
  name: string
  // 这个候选的思路，接在需求后面发给它
  approach: string
}
export type CandidateStatus = 'running' | 'done' | 'failed' | 'cancelled'
export interface CandidateView extends CandidateSpec {
  id: string
  status: CandidateStatus
  // 它在自己的 worktree 里过完成门禁的结论；没跑完、出错是 null
  verification: 'verified' | 'unverified' | 'no-edits' | 'failed' | null
  // 它最后说的话（截短）
  summary: string | null
  error: string | null
  stats: { files: number; added: number; removed: number } | null
  // 改了哪些文件（相对仓库根目录）
  paths: string[]
}
// ready：等用户选；applied、discarded 之后 worktree 都清掉了
export type CandidateRunStatus = 'running' | 'ready' | 'applied' | 'discarded' | 'cancelled' | 'failed'
export interface CandidateRunView {
  turnId: string
  status: CandidateRunStatus
  appliedId: string | null
  // 上一次应用前检查出的冲突文件；没有冲突、没检查过时没有
  conflicts?: string[]
  candidates: CandidateView[]
}

// 建外接智能体任务时 session/new 的 _meta.diffra：不要模型配置
export interface ExternalSessionConfig {
  external: { agentId: string }
  permissionMode: PermissionMode
  readOnlyPaths: string[]
  noProject?: boolean
  // 检查点仓库：这一轮改了哪些文件、撤销改动都靠它
  checkpointDir: string | null
}

// _diffra/remote/snapshot 的结果（设备连接用）：不载入会话、不连 MCP 地读一页轮次。
// turns 是全部轮次里从 start 开始的一段，改动卡片已压缩（同 session/load）；taskState 的有无和 session/load 一样
export interface RemoteSnapshot {
  sessionId: string
  cwd: string
  title: string
  archived: boolean
  design: boolean
  noProject: boolean
  running: boolean
  taskState?: TaskProgressView
  totalTurns: number
  start: number
  turns: StoredTurn[]
  // core 这次启动的标识（重启后 seq 从头算）和读这一页那一刻这个会话推到的 seq：之后推的更新不在这一页里，seq 都比它大
  epoch: string
  seq: number
}

// 客户端整理后的会话列表项
export interface StoredSessionSummary extends StoredSessionMeta {
  sessionId: string
  cwd: string
  title: string
  updatedAt: string
}

export interface SessionSearchResult {
  sessionId: string
  cwd: string
  title: string
  updatedAt: string
  // 命中位置附近的一小段文字
  snippet: string
}

// 从项目文件里识别出的一条检查命令
export interface DetectedCheck {
  kind: 'typecheck' | 'lint' | 'test'
  command: string
  // 为什么选它，确认时给用户看
  source: string
  // 来自 package.json 脚本时是脚本的内容：检查命令运行时不再确认，保存前要让用户看到实际会跑什么
  script: string | null
}

export interface CheckDetection {
  checks: DetectedCheck[]
  // 建议的快速检查（类型检查、lint）和完成检查（再加测试）
  afterEdit: string | null
  beforeFinish: string | null
  // 跳过了什么、为什么
  notes: string[]
}

export interface CheckRunResult {
  passed: boolean
  summary: string
}

// subagent：主智能体用 delegate 派出的子智能体（工人），用的是编码模型
export type ModelRole = 'coder' | 'reviewer' | 'planner' | 'subagent'

// 子智能体：主智能体用 delegate 派出的工人。它的卡片（那次 delegate 调用）在 _meta.diffra.agent 里带 AgentCardMeta；
// 工人自己的工具调用在 _meta.diffra 里带 parentToolCallId（所属卡片）和 agent（AgentTag），界面据此收进卡片、标出是谁改的文件。
// 权限请求的 toolCall 也带 _meta.diffra.agent，界面写明是哪个智能体在请求
export const AGENT_META_KEY = 'agent'
export const PARENT_TOOL_CALL_META_KEY = 'parentToolCallId'

export interface AgentTag {
  id: string
  name: string
  // 界面和设计画布上的标识色，#RRGGBB
  color: string
}

export interface AgentCardMeta extends AgentTag {
  task: string
  // 认领的文件和目录（相对项目）；中途追加认领时整份重发
  files: string[]
  // 设计任务里负责的节点
  nodes: string[]
  // 第 659 步起：开始、结束的时刻（毫秒时间戳），用掉的 token（输入加输出），实际改了的文件。旧记录没有
  startedAt?: number
  endedAt?: number
  tokens?: number
  edited?: string[]
}

// 用量记录的一行：一次模型调用。时间是调用结束时的 UTC 时刻；供应商没返回的数记成 null
export interface UsageRecord {
  v: 1
  at: string
  sessionId: string
  cwd: string
  providerId: string | null
  providerName: string | null
  modelId: string
  role: ModelRole
  // 输入总数，包含缓存命中的部分
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
  // 输出总数，包含推理的部分
  output: number | null
  reasoning: number | null
}

export interface UsageTotals {
  calls: number
  // 供应商没返回用量的调用次数
  unknownCalls: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  // v2 · M11：按用户填的单价算的费用（6 位小数的字符串，币种由界面定）；没填单价时没有这两项
  cost?: string
  // 没有单价的调用次数
  unpricedCalls?: number
}

// 一个模型的单价：每百万 token 多少钱（小数字符串）；缓存读、写缓存没填时按输入价（v2 · M11）
export interface UsagePrice {
  providerId: string | null
  modelId: string
  input: string
  cachedInput?: string | null
  cacheWrite?: string | null
  output: string
}

// 统计范围 [from, to)，按 timeZone 的日界分天
export interface UsageQuery {
  from: string
  to: string
  timeZone: string
  // v2 · M11：给了单价就算费用；给了无项目任务的根目录，按项目统计时下面的任务合成一行
  prices?: UsagePrice[]
  workspaceRoot?: string | null
}

export interface UsageSummary {
  totals: UsageTotals
  // 范围内的每一天（没有调用的天也在，数都是 0），日期是 timeZone 下的 YYYY-MM-DD
  days: Array<UsageTotals & { date: string }>
  models: Array<UsageTotals & { providerId: string | null; providerName: string | null; modelId: string }>
  // noProject：无项目任务合成的一行（cwd 是它们的根目录，tasks 是任务数）
  projects: Array<UsageTotals & { cwd: string; noProject?: boolean; tasks?: number }>
  // 用量最多的几个任务
  tasks: Array<UsageTotals & { sessionId: string; cwd: string }>
  // 读到的格式不对的行（比如进程崩溃留下的半行）
  skippedLines: number
}

// ACP 单条消息的上限（两端都按它读）。SDK 默认 32 MiB，载入长任务时整份轮次记录走一条消息，
// 2026-11 一个 41 轮的任务记录有 35 MB，打不开（MessageTooLargeError）。编辑卡片已不存整份文件，这里留足余量
export const ACP_MAX_MESSAGE_BYTES = 256 * 1024 * 1024

export const SESSION_EXT_METHODS = {
  compact: '_diffra/session/compact',
  checkpointPreview: '_diffra/checkpoint/preview',
  checkpointRestore: '_diffra/checkpoint/restore',
  // 重命名、归档
  sessionUpdate: '_diffra/session/update',
  sessionSearch: '_diffra/session/search',
  // 会话中途切换模型、权限模式
  sessionConfigure: '_diffra/session/configure',
  // 设置里的检查开关（三层安全检查、规范审查）：所有已经打开的会话立即按新值
  securityConfigure: '_diffra/security/configure',
  // 更多安全检查（v2 · M10）：Semgrep、CodeQL 装了没有和动态测试能认出的接口；跑一样（依赖许可证、外部扫描器、动态测试）；取消
  securityTools: '_diffra/security/tools',
  securityRun: '_diffra/security/run',
  securityCancel: '_diffra/security/cancel',
  // 重新生成：撤掉某一轮及之后的文件改动和对话
  sessionRewind: '_diffra/session/rewind',
  checkpointDiff: '_diffra/checkpoint/diff',
  usageSummary: '_diffra/usage/summary',
  // v2 · M11：把范围内的记录导出成 CSV；列出各月的记录文件；删掉某个月之前的记录
  usageExport: '_diffra/usage/export',
  usageFiles: '_diffra/usage/files',
  usageCleanup: '_diffra/usage/cleanup',
  projectDetectChecks: '_diffra/project/detect-checks',
  projectRunCheck: '_diffra/project/run-check',
  deepScan: '_diffra/security/deep-scan',
  // 先出计划：规划模型只读地看代码，交一份计划，不改文件
  plan: '_diffra/session/plan',
  // 模型很久没有输出时，用户让卡住的那一步重发请求（主智能体或某个子智能体），这一轮不停
  retryStep: '_diffra/session/retry-step',
  // 界面截好的可视化快照记回会话（第 670 步）
  visualSnapshot: '_diffra/visual/snapshot',
  // 重新生成之前的那一次换回来（第 676 步）
  useTurnVersion: '_diffra/session/use-version',
  // 这个任务开着的插件注册的富块（第 682 步）
  sessionBlocks: '_diffra/session/blocks',
  // 回答里的命令打进终端之前看风险（第 687 步），和确认卡用同一套规则
  commandRisk: '_diffra/command/risk',
  // 直接应用回答里的 diff（第 686 步），记成一轮 apply
  applyDiff: '_diffra/session/apply-diff',
  // 定位问题：停下的一轮或失败的子智能体，用当前模型只读地查原因，交回原因、证据和修复提示词
  diagnose: '_diffra/session/diagnose',
  // 界面「运行中」：停止一条后台命令、看它最近的输出（第 528 步）
  processStop: '_diffra/session/process-stop',
  processOutput: '_diffra/session/process-output',
  // 浏览器的站点名单（设置里管理）：允许的直接打开，禁止的不打开也不问；所有会话共用
  browserSites: '_diffra/browser/sites',
  // 优化输入框里的提示词：一次调用交回改写稿和只有用户能回答的问题，不进任何对话
  promptEnhance: '_diffra/prompt/enhance',
  // 列出这个任务或项目能用的 Skill
  skillsList: '_diffra/skills/list',
  // MCP 服务器状态；retry 为 true 时连不上的马上重连
  mcpStatus: '_diffra/mcp/status',
  // 插件的语言服务器（v2）：这个任务用到的服务器的状态和诊断；启动、停止、重启
  lspStatus: '_diffra/lsp/status',
  lspControl: '_diffra/lsp/control',
  // 把一个 MCP prompt 展开成文字
  mcpPrompt: '_diffra/mcp/prompt',
  // 列出这个任务或项目能用的自定义命令
  commandsList: '_diffra/commands/list',
  // 读一个插件文件夹里有什么
  pluginInspect: '_diffra/plugins/inspect',
  // 架构分析：项目列表、后台分析（进度走 CLIENT_EXT_NOTIFICATIONS.architectureEvent）、读取结果、模型解读、目标架构
  architectureList: '_diffra/architecture/list',
  architectureAdd: '_diffra/architecture/add',
  architectureRemove: '_diffra/architecture/remove',
  architectureAnalyze: '_diffra/architecture/analyze',
  architectureCancel: '_diffra/architecture/cancel',
  architectureRunning: '_diffra/architecture/running',
  architectureBundle: '_diffra/architecture/bundle',
  architectureStale: '_diffra/architecture/stale',
  // 打开着项目时监听文件变化（v2 · M9）：{ projectId, watch, auto }，过期和出错走 architectureEvent
  architectureWatch: '_diffra/architecture/watch',
  // 架构定义放进仓库（v2 · M9）：导出到 .diffra/、看仓库里那份的状态、用仓库里的
  architectureExport: '_diffra/architecture/export',
  architectureShared: '_diffra/architecture/shared',
  architectureImport: '_diffra/architecture/import',
  // 运行时追踪（v2 · M9）：跑一条命令记下执行到的函数（后台，进度走 architectureEvent）；默认命令
  architectureTrace: '_diffra/architecture/trace',
  architectureTraceCommand: '_diffra/architecture/trace-command',
  architectureInterpret: '_diffra/architecture/interpret',
  architectureInterpretModule: '_diffra/architecture/interpret-module',
  // 让模型读一条流程经过的代码，画它的流程图
  architectureFlowChart: '_diffra/architecture/flow-chart',
  architectureProposeTarget: '_diffra/architecture/propose-target',
  architectureSaveTarget: '_diffra/architecture/save-target',
  architectureSaveLayout: '_diffra/architecture/save-layout',
  // 保存手改过的架构图
  architectureSaveDiagram: '_diffra/architecture/save-diagram',
  // 读分析结果里的一个代码文件，给界面看 import 所在的行
  architectureSource: '_diffra/architecture/source',
  // 设备连接：读一个会话的一页轮次，见 RemoteSnapshot
  remoteSnapshot: '_diffra/remote/snapshot',
  // 外接智能体：设置里的整份清单（ExternalAgentSpec[]），启动时和设置改了时发
  externalAgents: '_diffra/external/agents',
  // 外接智能体：检测一条启动命令能不能用（ExternalAgentDetection）
  externalDetect: '_diffra/external/detect',
  // 多候选方案：生成（记成一轮 plan）、看某个候选的改动、应用一个（记成一轮 apply）、全部放弃
  candidates: '_diffra/session/candidates',
  candidateDiff: '_diffra/session/candidate-diff',
  candidateApply: '_diffra/session/candidate-apply',
  candidateDiscard: '_diffra/session/candidate-discard',
} as const

// core 主动推给客户端的通知
export const CLIENT_EXT_NOTIFICATIONS = {
  architectureEvent: '_diffra/architecture/event',
  // 会话的后台命令列表变了，带上现在的整份列表
  processes: '_diffra/session/processes',
} as const

// 只能由本机的人确认的权限请求，toolCall._meta.diffra 里带上它（设备连接不转给远程设备）：
// 跨出项目授权的那几类——项目外的文件、读本机终端、给别的任务发消息或新建任务（可能在没开放的项目里）、改用用户自己的浏览器（用着用户的登录状态）
export const LOCAL_ONLY_META_KEY = 'localOnly'
export const LOCAL_ONLY_META = { diffra: { [LOCAL_ONLY_META_KEY]: true } }

// 设备连接发出的快照里，只发了开头的工具输出：文字块 _meta 里这个键记着全文多长（@diffra/remote 的 previewTurn），连接端展开时再要全文
export const TOOL_PREVIEW_META_KEY = 'diffraRemotePreview'

export const PERMISSION_OPTIONS = {
  allowOnce: 'allow_once',
  allowAlways: 'allow_always',
  // 这个项目里始终允许同类命令（第 445 步）：客户端把确认请求 _meta.diffra 里的命令键存进项目设置，以后建会话时传回来
  allowProject: 'allow_project',
  reject: 'reject',
} as const
// 命令确认请求的 _meta.diffra.commandRisk（第 659 步）：这条命令可能造成什么后果，确认卡上标出风险等级和原因。
// high 是删目录、丢弃改动、强制推送这类难恢复的；medium 是联网、改依赖、推送、删文件这类要留意的；low 没有原因
export const COMMAND_RISK_META_KEY = 'commandRisk'
export interface CommandRisk {
  level: 'high' | 'medium' | 'low'
  reasons: string[]
}
// 命令跑完那次更新的 _meta.diffra.commandDurationMs（第 659 步）：这次调用等了多久（后台命令是这次查看的等待时长）
export const COMMAND_DURATION_META_KEY = 'commandDurationMs'
// 上下文压缩卡的 _meta.diffra.compaction（第 659 步）：压缩前后估算的上下文 token 和窗口大小，界面画成一条对比条
export const COMPACTION_META_KEY = 'compaction'
export interface CompactionStats {
  before: number
  after: number | null
  window: number | null
}
// 命令确认请求的 _meta.diffra.projectCommands：选「这个项目里始终允许」时要存的命令键（如 pnpm test、git commit）和项目目录
export const PROJECT_COMMANDS_META_KEY = 'projectCommands'
export interface ProjectCommandsMeta {
  cwd: string
  keys: string[]
}

// ---------- 更多安全检查（v2 · M10，见 security/tools.ts） ----------

export const SECURITY_TOOLS = ['licenses', 'semgrep', 'codeql', 'dynamic'] as const
export type SecurityTool = (typeof SECURITY_TOOLS)[number]

export interface ToolFinding {
  tool: SecurityTool
  ruleId: string
  severity: 'high' | 'medium' | 'low'
  // 相对项目根的文件路径；动态测试是接口路径；许可证是声明它的清单
  path: string
  line: number | null
  message: string
}

export type LicenseKind = 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown'

export interface DependencyLicense {
  name: string
  version: string | null
  ecosystem: 'npm' | 'python' | 'go'
  license: string | null
  kind: LicenseKind
  // 项目里哪个清单声明的
  declaredIn: string
}

export interface LicenseReport {
  // 项目自己的许可证（package.json 的 license、LICENSE 文件）；没写是 null
  project: string | null
  dependencies: DependencyLicense[]
  // 没装好、读不到的说明
  notes: string[]
}

export interface SecurityToolReport {
  tool: SecurityTool
  startedAt: string
  durationMs: number
  findings: ToolFinding[]
  notes: string[]
  // 许可证扫描的完整清单
  licenses?: LicenseReport
}

export interface SecurityToolsInfo {
  semgrep: string | null
  codeql: string | null
  // 动态测试从代码里认出的接口路径
  routes: string[]
}

// 评测结果的统计（v2 · M11）：纯计算，评测命令行和桌面端共用
export * from './stats.js'
// 用量的单价和费用（v2 · M11）：纯整数计算，评测命令行也用
export { formatCost, PRICE_PATTERN, PriceBook, priceMicros } from './usage/pricing.js'
