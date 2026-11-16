import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cancelSession,
  checkpointDiff,
  diagnose,
  enhancePrompt,
  retryStep,
  recordVisualSnapshot,
  useTurnVersion,
  sessionBlocks,
  commandRiskOf,
  applyDiff,
  stopProcess,
  processOutput,
  configureSession,
  compactSession,
  type CoreClientHandlers,
  createExternalSession,
  createSession,
  type ExternalSessionConfig,
  deepScan,
  plan,
  deleteSession,
  detectProjectChecks,
  listSessions,
  listCommands,
  listSkills,
  loadSession,
  mcpPrompt,
  mcpStatus,
  previewCheckpoint,
  restoreCheckpoint,
  rewindSession,
  runProjectCheck,
  searchSessions,
  type SessionChecks,
  type SessionConfig,
  type SessionModel,
  sendPrompt,
  type TaskActionResult,
  updateSession,
  usageSummary,
} from '@diffra/core'
import { DEEP_SCAN_TITLES, designStyleById, MANUAL_COMPACTION_PROMPT, PERMISSION_OPTIONS, PROJECT_COMMANDS_META_KEY, type ProjectCommandsMeta, PROMPT_IMAGE_TYPES, VISUAL_SNAPSHOT_MAX_CHARS, VISUAL_SNAPSHOT_TYPES, ASK_ANSWERS_META_KEY } from '@diffra/core/types'
import { askAnswersSchema } from '@diffra/remote/messages'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import {
  encodeStartTaskError,
  IPC_CHANNELS,
  type LoadedSessionHandle,
  type PermissionRequestEvent,
  type TaskActionEvent,
  type ProjectState,
  type SessionDeleteResult,
  type SessionHandle,
  type TaskFolderState,
} from '../shared/ipc'
import { modelDisplayName, type ModelRef, NO_HOOKS } from '../shared/settings'
import { reasoningEffortsFor, withRememberedEffort } from '../shared/reasoning'
import { coreConnection } from './core-process'
import { currentBranch, listBranches, switchBranch } from './project-branch'
import { browserHost } from './browser'
import { designHost } from './design'
import { devServer, killTerminalsIn, pathInside, stopDevServer } from './terminal-ipc'
import { parse } from './ipc-input'
import { aroundTurn, emitSessionEvent } from './session-events'
import { mcpServersFor } from './mcp-servers'
import { enabledPlugins } from './plugins-ipc'
import { SESSION_RULES } from './rule-packs'
import type { SecretStore } from './secret-store'
import { providerEndpoint, workspaceRoot } from './settings-ipc'
import {
  modelRefSchema,
  permissionModeSchema,
  projectSettingsSchema,
  type SettingsStore,
} from './settings-store'

const sessionOptionsSchema = z.object({
  permissionMode: permissionModeSchema.optional(),
  model: modelRefSchema.optional(),
  // 设计任务，只在新建时有效
  design: z.boolean().optional(),
  // 设计任务的风格预设，只在新建设计任务时有效
  designStyle: z
    .string()
    .refine((id) => designStyleById(id) !== null, '没有这个风格预设')
    .optional(),
  // 无项目任务用它给文件夹起名，只在新建时有效
  title: z.string().max(200).optional(),
  // 外接智能体的 id，只在新建时有效；给了就不用 Diffra 的模型
  agent: z.string().min(1).max(100).optional(),
})
type SessionOptions = z.infer<typeof sessionOptionsSchema>

const skillNamesSchema = z.array(z.string().min(1).max(200)).max(20)
const promptImagesSchema = z
  .array(z.object({ mimeType: z.enum(PROMPT_IMAGE_TYPES), data: z.string().min(1).max(8_000_000).regex(/^[A-Za-z0-9+/]+=*$/) }))
  .max(6)
const promptOptionsSchema = z.object({
  skills: skillNamesSchema,
  goal: z.boolean(),
  images: promptImagesSchema,
  from: z.object({ sessionId: z.string().min(1), title: z.string() }).optional(),
  remote: z.object({ deviceId: z.string().regex(/^[0-9a-f]{32}$/), name: z.string().min(1).max(60) }).optional(),
})

const mcpTargetSchema = z.union([
  z.object({ sessionId: z.string().min(1) }),
  z.object({ projectPath: z.string().min(1).nullable() }),
  z.object({ noProject: z.literal(true) }),
])

const NO_CHECKS: SessionChecks = { afterEdit: null, beforeFinish: null }

// Windows 路径不分大小写；末尾分隔符不影响是不是同一个项目
const sameProjectPath = (a: string, b: string) =>
  a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

interface PendingPermission {
  sessionId: string
  // 命令确认带的：选「这个项目里始终允许」时要记进项目设置的命令键
  projectCommands?: ProjectCommandsMeta
  resolve(optionId: string | null, answers?: unknown[]): void
}

function projectCommandsOf(meta: unknown): ProjectCommandsMeta | undefined {
  const diffra = typeof meta === 'object' && meta !== null && 'diffra' in meta ? meta.diffra : null
  const value = typeof diffra === 'object' && diffra !== null ? (diffra as Record<string, unknown>)[PROJECT_COMMANDS_META_KEY] : null
  const parsed = z.object({ cwd: z.string().min(1), keys: z.array(z.string().min(1).max(200)).min(1).max(20) }).safeParse(value)
  return parsed.success ? parsed.data : undefined
}

const pendingPermissions = new Map<string, PendingPermission>()
// 等界面替智能体给别的任务发消息、新建任务
const pendingTaskActions = new Map<string, (result: TaskActionResult) => void>()

// 模型配置导致的失败带上原因，新建任务时转成界面能识别的错误码；加载任务、换模型时照常只显示 message。
// 不改 name：IPC 传过去的是「Error: message」，界面按这个前缀去掉
class ModelConfigError extends Error {
  constructor(
    readonly code: 'model-missing' | 'model-auth',
    message: string,
  ) {
    super(message)
  }
}

function broadcast(channel: string, payload: unknown): number {
  const windows = BrowserWindow.getAllWindows()
  for (const window of windows) window.webContents.send(channel, payload)
  return windows.length
}

// core 推来的会话更新原样转给界面；权限请求等界面回复后再答复 core
export const coreClientHandlers: CoreClientHandlers = {
  onSessionUpdate: (notification) => {
    broadcast(IPC_CHANNELS.sessionUpdate, notification)
    emitSessionEvent({ type: 'update', notification })
  },
  onPermissionRequest: (request) =>
    new Promise((resolve) => {
      const requestId = randomUUID()
      pendingPermissions.set(requestId, {
        sessionId: request.sessionId,
        projectCommands: projectCommandsOf(request.toolCall._meta),
        // 提问的答案（第 673 步）放在回复的 _meta 里，core 逐个校验
        resolve: (optionId, answers) =>
          resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }, ...(optionId && answers ? { _meta: { diffra: { [ASK_ANSWERS_META_KEY]: answers } } } : {}) }),
      })
      const event: PermissionRequestEvent = {
        requestId,
        sessionId: request.sessionId,
        toolCall: request.toolCall,
        options: request.options,
      }
      // 没有窗口能回答时直接按取消处理，不让 core 一直等
      if (broadcast(IPC_CHANNELS.sessionPermission, event) === 0) settlePermission(requestId, null)
      else emitSessionEvent({ type: 'permission', ...event })
    }),
  onBrowserAction: (params) => browserHost.act(params),
  onDevServer: (params) => devServer(params),
  onDesignAction: (params) => designHost.act(params),
  onArchitectureEvent: (event) => {
    broadcast(IPC_CHANNELS.architectureEvent, event)
  },
  onProcesses: (event) => {
    broadcast(IPC_CHANNELS.sessionProcesses, event)
  },
  onTaskAction: (params) =>
    new Promise((resolve) => {
      const requestId = randomUUID()
      pendingTaskActions.set(requestId, resolve)
      const event: TaskActionEvent = { requestId, params }
      if (broadcast(IPC_CHANNELS.sessionTaskAction, event) === 0) {
        pendingTaskActions.delete(requestId)
        resolve({ ok: false, error: '应用窗口没有打开，发不了' })
      }
    }),
}

// 本机界面、远程设备谁先答算谁的；已经答过的返回 false。答完告诉界面收起确认卡片（可能是远程答的）
export function settlePermission(requestId: string, optionId: string | null, answers?: unknown[]): boolean {
  const pending = pendingPermissions.get(requestId)
  if (!pending) return false
  pendingPermissions.delete(requestId)
  pending.resolve(optionId, answers)
  broadcast(IPC_CHANNELS.sessionPermissionSettled, { requestId, sessionId: pending.sessionId })
  emitSessionEvent({ type: 'permission-settled', requestId, sessionId: pending.sessionId })
  return true
}

// 返回架构功能选模型的办法：和优化提示词一样先用「规划」角色，没配用「编码」
export function registerSessionIpc(settings: SettingsStore, secrets: SecretStore, userDataDir: string): { architectureModel: () => Promise<SessionModel> } {
  const projectState = (path: string): ProjectState => {
    const project = settings.get().projects[path]
    return {
      path,
      checks: project?.checks ?? NO_CHECKS,
      readOnlyPaths: project?.readOnlyPaths ?? [],
      allowedCommands: project?.allowedCommands ?? [],
      hooks: project?.hooks ?? NO_HOOKS,
    }
  }

  const saveProjectState = async (path: string, change: (current: ProjectState) => ProjectState) => {
    const { checks, readOnlyPaths, allowedCommands, hooks } = change(projectState(path))
    await settings.update((current) => ({ ...current, projects: { ...current.projects, [path]: { checks, readOnlyPaths, allowedCommands, hooks } } }))
    return projectState(path)
  }

  // 模型和它的接入点；配置不完整时报错说明去哪里改
  const resolveModel = async (ref: ModelRef, label: string) => {
    const provider = settings.get().providers.find((item) => item.id === ref.providerId)
    const model = provider?.models.find((item) => item.id === ref.modelId)
    if (!provider || !model) throw new ModelConfigError('model-missing', `${label}不存在，请到「设置 → 模型与角色」里重新选择`)
    if (model.enabled === false) throw new ModelConfigError('model-missing', `${label}已停用，请到「设置 → 模型与角色」里启用或重新选择`)
    if (ref.reasoningEffort && !reasoningEffortsFor(provider, model).includes(ref.reasoningEffort)) {
      throw new ModelConfigError('model-missing', `${label}不支持选中的思考强度，请重新选择，或到「设置 → 模型与角色」里勾选支持的档位`)
    }
    const target = await providerEndpoint(settings, secrets, provider.id)
    if (!target.ok) {
      throw new ModelConfigError(target.error.kind === 'auth' ? 'model-auth' : 'model-missing', `「${provider.name}」${target.error.message}`)
    }
    return {
      label: `${provider.name} / ${modelDisplayName(model)}`,
      model: {
        endpoint: target.endpoint,
        modelId: model.id,
        contextWindow: model.contextWindow,
        provider: { id: provider.id, name: provider.name },
        supportsImages: model.images,
        maxOutputTokens: model.maxOutputTokens ?? null,
        reasoningEffort: ref.reasoningEffort,
      },
    }
  }

  const resolveRole = async (role: 'coder' | 'reviewer' | 'planner' | 'fallback', label: string) => {
    const ref = settings.get().roles[role]
    return ref ? resolveModel(ref, `「${label}」角色的模型`) : null
  }

  // 编码角色的模型，思考程度用输入框里给它选过的（第 531 步）
  const coderRef = () => {
    const { roles, providers, reasoningChoices } = settings.get()
    return roles.coder ? withRememberedEffort(roles.coder, providers, reasoningChoices) : null
  }

  // 用户又选了这个文件夹，或在这里开了任务：它不再算已归档。项目下的旧会话仍按各自的归档状态保留
  const rememberProject = (path: string) =>
    settings.update((current) => ({
      ...current,
      lastProject: path,
      archivedProjects: current.archivedProjects.filter((item) => !sameProjectPath(item, path)),
    }))

  ipcMain.handle(IPC_CHANNELS.projectPick, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '选择项目文件夹', properties: ['openDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? undefined : result.filePaths[0]
    if (!path) return null
    await rememberProject(path)
    return projectState(path)
  })

  ipcMain.handle(IPC_CHANNELS.projectLast, async () => {
    const path = settings.get().lastProject
    if (!path) return null
    // 上次的目录可能已经被删掉或移走
    const info = await stat(path).catch(() => null)
    return info?.isDirectory() ? projectState(path) : null
  })

  ipcMain.handle(IPC_CHANNELS.projectGet, (_event, rawPath: unknown) => projectState(parse(z.string().min(1), rawPath)))

  ipcMain.handle(IPC_CHANNELS.projectDetectChecks, async (_event, rawPath: unknown) =>
    detectProjectChecks(await coreConnection(), parse(z.string().min(1), rawPath)),
  )

  // 只在用户点「试运行」时调用；命令就是界面上显示给用户的那条
  ipcMain.handle(IPC_CHANNELS.projectRunCheck, async (_event, rawPath: unknown, rawCommand: unknown) =>
    runProjectCheck(await coreConnection(), parse(z.string().min(1), rawPath), parse(z.string().trim().min(1).max(2000), rawCommand)),
  )

  ipcMain.handle(IPC_CHANNELS.projectSave, async (_event, rawPath: unknown, rawSettings: unknown) => {
    const path = parse(z.string().min(1), rawPath)
    // 始终允许的命令不传就保持原样（旧界面、脚本只传检查和禁写目录）
    const input = parse(projectSettingsSchema.pick({ checks: true, readOnlyPaths: true }).extend({ allowedCommands: projectSettingsSchema.shape.allowedCommands.optional(), hooks: projectSettingsSchema.shape.hooks.optional() }), rawSettings)
    return saveProjectState(path, (current) => ({ ...current, ...input }))
  })

  // 新建和加载都按当前设置组装会话配置：模型、检查、规范改过的话，打开旧任务也用新的。
  // 输入框里选的模型和权限模式优先，没选就用「编码」角色和默认权限模式
  const sessionConfig = async (
    path: string,
    options: SessionOptions = {},
  ): Promise<{ config: SessionConfig; modelLabel: string; planLabel: string | null; fallbackLabel: string | null }> => {
    const remembered = coderRef()
    const coder = options.model ? await resolveModel(options.model, '所选模型') : remembered ? await resolveModel(remembered, '「编码」角色的模型') : null
    if (!coder) throw new ModelConfigError('model-missing', '还没有给「编码」角色分配模型，请先到「设置 → 模型与角色」里选择')
    const project = projectState(path)
    // 规范审查按设置开关；没分配评审角色时 core 用编码模型审查
    const reviewer = await resolveRole('reviewer', '评审')
    const planner = await resolveRole('planner', '规划')
    const fallback = await resolveRole('fallback', '备用')
    return {
      config: {
        model: coder.model,
        reviewModel: reviewer ? { endpoint: reviewer.model.endpoint, modelId: reviewer.model.modelId, provider: reviewer.model.provider } : null,
        planModel: planner?.model ?? null,
        fallbackModel: fallback?.model ?? null,
        checks: project.checks,
        readOnlyPaths: project.readOnlyPaths,
        allowedCommands: project.allowedCommands,
        hooks: project.hooks,
        rules: { ...SESSION_RULES, review: settings.get().security.review },
        permissionMode: options.permissionMode ?? settings.get().defaultPermissionMode,
        security: { staticCheck: settings.get().security.staticCheck, lightScan: settings.get().security.lightScan, deepScan: settings.get().security.deepScan },
        limits: {
          compactAtPercent: settings.get().execution.compactAtPercent,
          maxSteps: settings.get().execution.maxSteps,
          goalMaxRounds: settings.get().execution.goalMaxRounds,
        },
        plugins: enabledPlugins(settings),
        browser: true,
        design: options.design ?? false,
        designStyle: options.design ? (options.designStyle ?? null) : null,
        checkpointDir: join(userDataDir, 'checkpoints', projectKey(path)),
        // 自动记忆开着时每个项目一个记忆目录；无项目任务的文件夹不是用户的项目，下面建会话时会去掉
        memoryDir: settings.get().execution.autoMemory ? join(userDataDir, 'memory', projectKey(path)) : null,
      },
      modelLabel: coder.label,
      planLabel: planner?.label ?? null,
      fallbackLabel: fallback?.label ?? null,
    }
  }

  const configForCreate = (path: string, options: SessionOptions) =>
    sessionConfig(path, options).catch((error: unknown) => {
      throw error instanceof ModelConfigError ? new Error(encodeStartTaskError(error.code, error.message)) : error
    })

  // 无项目任务：先组装会话配置，模型不对就在这里失败，不留空目录；再在默认保存位置下建文件夹
  const createInWorkspace = async (options: SessionOptions) => {
    const root = workspaceRoot(settings).path
    const base = workspaceFolderName(options.title ?? '')
    const prepared = await configForCreate(join(root, base), options)
    const cwd = await makeWorkspaceFolder(root, base)
    const project = projectState(cwd)
    const config: SessionConfig = {
      ...prepared.config,
      checks: project.checks,
      readOnlyPaths: project.readOnlyPaths,
      checkpointDir: join(userDataDir, 'checkpoints', projectKey(cwd)),
      memoryDir: null,
      noProject: true,
    }
    try {
      return { ...prepared, config, cwd, created: await createSession(await coreConnection(), cwd, config, await mcpServersFor(settings, secrets)) }
    } catch (error) {
      // rmdir 只删空目录；建会话失败时智能体还没动过它
      await rmdir(cwd).catch(() => undefined)
      throw error
    }
  }

  const createInProject = async (path: string, options: SessionOptions) => {
    const dir = await stat(path).catch(() => null)
    if (!dir?.isDirectory()) throw new Error(encodeStartTaskError('project-missing', '项目文件夹不存在或已被移走，请重新选择项目'))
    const prepared = await configForCreate(path, options)
    const created = await createSession(await coreConnection(), path, prepared.config, await mcpServersFor(settings, secrets))
    await rememberProject(path)
    return { ...prepared, cwd: path, created }
  }

  // 外接智能体的任务：不要 Diffra 的模型配置，检查点照常打（看改动、撤销改动用）；进程等第一条消息时才起
  const externalConfig = (agentId: string, cwd: string, permissionMode: SessionConfig['permissionMode'], noProject: boolean): ExternalSessionConfig => ({
    external: { agentId },
    permissionMode,
    readOnlyPaths: projectState(cwd).readOnlyPaths,
    noProject,
    checkpointDir: join(userDataDir, 'checkpoints', projectKey(cwd)),
  })

  const createExternalTask = async (path: string | null, options: SessionOptions & { agent: string }): Promise<SessionHandle> => {
    if (options.design) throw new Error('外接智能体不能做设计任务，设计任务请用 Diffra 自己的模型')
    const agent = settings.get().externalAgents.find((item) => item.id === options.agent)
    if (!agent) throw new Error(encodeStartTaskError('model-missing', '这个外接智能体已经不在设置里了，请到「设置 → 外接智能体」里重新添加'))
    const permissionMode = options.permissionMode ?? settings.get().defaultPermissionMode
    let cwd: string
    if (path === null) {
      const root = workspaceRoot(settings).path
      cwd = await makeWorkspaceFolder(root, workspaceFolderName(options.title ?? ''))
    } else {
      const dir = await stat(path).catch(() => null)
      if (!dir?.isDirectory()) throw new Error(encodeStartTaskError('project-missing', '项目文件夹不存在或已被移走，请重新选择项目'))
      cwd = path
    }
    let created: Awaited<ReturnType<typeof createExternalSession>>
    try {
      created = await createExternalSession(await coreConnection(), cwd, externalConfig(agent.id, cwd, permissionMode, path === null))
    } catch (error) {
      if (path === null) await rmdir(cwd).catch(() => undefined)
      throw error
    }
    if (path !== null) await rememberProject(path)
    return {
      sessionId: created.sessionId,
      info: created.info,
      modelLabel: agent.name,
      planLabel: null,
      fallbackLabel: null,
      permissionMode,
      design: false,
      cwd,
      noProject: path === null,
      agent: { id: agent.id, name: agent.name },
    }
  }

  ipcMain.handle(IPC_CHANNELS.sessionCreate, async (_event, rawPath: unknown, rawOptions: unknown): Promise<SessionHandle> => {
    const path = parse(z.string().min(1).nullable(), rawPath)
    const options = parse(sessionOptionsSchema, rawOptions ?? {})
    if (options.agent) return createExternalTask(path, { ...options, agent: options.agent })
    // 无项目任务不记 lastProject：它的文件夹不是用户的项目，下次启动和 MCP 设置页的检测目录都还用上一个项目
    const { config, modelLabel, planLabel, fallbackLabel, cwd, created } = path === null ? await createInWorkspace(options) : await createInProject(path, options)
    const { sessionId, info } = created
    if (config.design) designHost.enable(sessionId)
    return {
      sessionId,
      info,
      modelLabel,
      modelRef: options.model ?? coderRef() ?? undefined,
      planLabel,
      fallbackLabel,
      permissionMode: config.permissionMode,
      design: config.design ?? false,
      cwd,
      noProject: path === null,
    }
  })

  // 会话中途换模型或权限模式；权限模式顺带记成新任务的默认值
  ipcMain.handle(IPC_CHANNELS.sessionConfigure, async (_event, rawSessionId: unknown, rawOptions: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const options = parse(sessionOptionsSchema, rawOptions)
    const model = options.model ? await resolveModel(options.model, '所选模型') : null
    await configureSession(await coreConnection(), sessionId, { permissionMode: options.permissionMode, model: model?.model })
    if (options.permissionMode) {
      const mode = options.permissionMode
      await settings.update((current) => ({ ...current, defaultPermissionMode: mode }))
    }
    return { modelLabel: model?.label ?? null }
  })

  ipcMain.handle(IPC_CHANNELS.sessionRewind, async (_event, rawSessionId: unknown, rawTurnId: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const result = await rewindSession(await coreConnection(), sessionId, parse(z.string().min(1), rawTurnId))
    emitSessionEvent({ type: 'reset', sessionId })
    return result
  })

  ipcMain.handle(IPC_CHANNELS.sessionRetryStep, async (_event, rawSessionId: unknown, rawAgent: unknown) =>
    retryStep(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawAgent)),
  )
  ipcMain.handle(IPC_CHANNELS.sessionApplyDiff, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawPrompt: unknown, rawDiff: unknown) =>
    (
      await applyDiff(await coreConnection(), {
        sessionId: parse(z.string().min(1), rawSessionId),
        turnId: parse(z.string().min(1), rawTurnId),
        prompt: parse(z.string().min(1).max(2000), rawPrompt),
        diff: parse(z.string().min(1).max(500_000), rawDiff),
      })
    ).stopReason,
  )
  ipcMain.handle(IPC_CHANNELS.commandRisk, async (_event, rawCommand: unknown) => commandRiskOf(await coreConnection(), parse(z.string().min(1).max(20_000), rawCommand)))
  ipcMain.handle(IPC_CHANNELS.sessionBlocks, async (_event, rawSessionId: unknown) => sessionBlocks(await coreConnection(), parse(z.string().min(1), rawSessionId)))
  ipcMain.handle(IPC_CHANNELS.sessionUseVersion, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawIndex: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const result = await useTurnVersion(await coreConnection(), sessionId, parse(z.string().min(1), rawTurnId), parse(z.number().int().nonnegative(), rawIndex))
    emitSessionEvent({ type: 'reset', sessionId })
    return result
  })
  ipcMain.handle(IPC_CHANNELS.sessionVisualSnapshot, async (_event, rawSessionId: unknown, rawToolCallId: unknown, rawImage: unknown) =>
    recordVisualSnapshot(await coreConnection(), {
      sessionId: parse(z.string().min(1), rawSessionId),
      toolCallId: parse(z.string().min(1), rawToolCallId),
      image: parse(z.object({ mimeType: z.enum(VISUAL_SNAPSHOT_TYPES), data: z.base64().max(VISUAL_SNAPSHOT_MAX_CHARS) }), rawImage),
    }),
  )
  ipcMain.handle(IPC_CHANNELS.sessionProcessStop, async (_event, rawSessionId: unknown, rawId: unknown) =>
    stopProcess(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.number().int(), rawId)),
  )
  ipcMain.handle(IPC_CHANNELS.sessionProcessOutput, async (_event, rawSessionId: unknown, rawId: unknown) =>
    processOutput(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.number().int(), rawId)),
  )

  ipcMain.handle(IPC_CHANNELS.checkpointDiff, async (_event, rawSessionId: unknown, rawTurnId: unknown) =>
    checkpointDiff(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawTurnId)),
  )

  ipcMain.handle(IPC_CHANNELS.projectBranch, async (_event, rawPath: unknown) => currentBranch(parse(z.string().min(1), rawPath)))
  ipcMain.handle(IPC_CHANNELS.projectBranches, async (_event, rawPath: unknown) => listBranches(parse(z.string().min(1), rawPath)))
  ipcMain.handle(IPC_CHANNELS.projectSwitchBranch, async (_event, rawPath: unknown, rawBranch: unknown) => switchBranch(parse(z.string().min(1), rawPath), parse(z.string().min(1).max(200), rawBranch)))

  ipcMain.handle(IPC_CHANNELS.projectOpenFolder, async (_event, rawPath: unknown) => {
    const message = await shell.openPath(parse(z.string().min(1), rawPath))
    if (message) throw new Error(`打不开文件夹：${message}`)
  })

  // 无项目任务的文件夹，以及还有没有别的任务（含已归档）用着它或它下面的目录：用户可能把它选成项目，在里面建了项目任务。
  // 项目任务为 null；记录不在索引里时为 unknown，不知道文件夹是谁的，不动它
  const workspaceFolderOf = async (sessionId: string) => {
    const sessions = await listSessions(await coreConnection())
    const entry = sessions.find((item) => item.sessionId === sessionId)
    if (!entry) return 'unknown' as const
    if (!entry.noProject) return null
    return { cwd: entry.cwd, shared: sessions.some((item) => item.sessionId !== sessionId && pathInside(entry.cwd, item.cwd)) }
  }

  ipcMain.handle(IPC_CHANNELS.sessionFolderState, async (_event, rawSessionId: unknown): Promise<TaskFolderState> => {
    const folder = await workspaceFolderOf(parse(z.string().min(1), rawSessionId))
    if (folder === 'unknown') return 'unknown'
    if (!folder) return 'missing'
    return folder.shared ? 'shared' : folderState(folder.cwd)
  })

  // 会话记录占用的磁盘空间：会话头在 sessions 下，每轮的记录在 sessions/<会话 id>/ 里（第 437 步）
  ipcMain.handle(IPC_CHANNELS.sessionsStorage, async () => {
    const dir = join(userDataDir, 'sessions')
    const sizeOf = async (path: string): Promise<number> => {
      const info = await stat(path).catch(() => null)
      if (!info) return 0
      if (!info.isDirectory()) return info.size
      let total = 0
      for (const name of await readdir(path).catch(() => [] as string[])) total += await sizeOf(join(path, name))
      return total
    }
    return { bytes: await sizeOf(dir), dir }
  })

  // 时间范围和时区由界面给，core 校验
  ipcMain.handle(IPC_CHANNELS.usageSummary, async (_event, rawQuery: unknown) =>
    usageSummary(await coreConnection(), parse(z.object({ from: z.string(), to: z.string(), timeZone: z.string() }), rawQuery)),
  )

  ipcMain.handle(IPC_CHANNELS.sessionLoad, async (_event, rawSessionId: unknown, rawPath: unknown): Promise<LoadedSessionHandle> => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const path = parse(z.string().min(1), rawPath)
    // 外接智能体的任务不要 Diffra 的模型配置：没配模型也能打开。先从列表里认出来
    const entry = (await listSessions(await coreConnection(), path)).find((item) => item.sessionId === sessionId)
    if (entry?.agent) {
      const permissionMode = settings.get().defaultPermissionMode
      const loaded = await loadSession(await coreConnection(), sessionId, path, externalConfig(entry.agent.id, path, permissionMode, entry.noProject))
      if (!loaded.noProject) await rememberProject(path)
      const current = settings.get().externalAgents.find((item) => item.id === entry.agent?.id)
      return {
        sessionId,
        info: loaded.info,
        modelLabel: current?.name ?? entry.agent.name,
        planLabel: null,
        fallbackLabel: null,
        permissionMode,
        title: loaded.title,
        turns: loaded.turns,
        taskState: loaded.taskState,
        design: false,
        cwd: path,
        noProject: loaded.noProject,
        agent: loaded.agent ?? entry.agent,
      }
    }
    const { config, modelLabel, planLabel, fallbackLabel } = await sessionConfig(path)
    const loaded = await loadSession(await coreConnection(), sessionId, path, config, await mcpServersFor(settings, secrets))
    if (!loaded.noProject) await rememberProject(path)
    if (loaded.design) designHost.enable(sessionId)
    return {
      sessionId,
      info: loaded.info,
      modelLabel,
      modelRef: coderRef() ?? undefined,
      planLabel,
      fallbackLabel,
      permissionMode: config.permissionMode,
      title: loaded.title,
      turns: loaded.turns,
      taskState: loaded.taskState,
      design: loaded.design,
      cwd: path,
      noProject: loaded.noProject,
    }
  })

  ipcMain.handle(IPC_CHANNELS.sessionsList, async (_event, rawPath: unknown) =>
    listSessions(await coreConnection(), parse(z.string().min(1).nullable(), rawPath) ?? undefined),
  )

  ipcMain.handle(IPC_CHANNELS.sessionsSearch, async (_event, rawQuery: unknown) =>
    searchSessions(await coreConnection(), parse(z.string().max(200), rawQuery)),
  )

  ipcMain.handle(IPC_CHANNELS.sessionMetaUpdate, async (_event, rawSessionId: unknown, rawChange: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const change = parse(
      z.object({
        title: z.string().trim().min(1, '任务名称不能为空').max(100, '任务名称太长').optional(),
        archived: z.boolean().optional(),
      }),
      rawChange,
    )
    await updateSession(await coreConnection(), sessionId, change)
    emitSessionEvent({ type: 'changed', sessionId })
  })

  // 无项目任务的文件夹：空的直接删，否则用户勾了才移到回收站，连同它独占的检查点仓库；别的任务还用着就不动。
  // 路径按 core 记下的 cwd，不用界面传来的。先让 core 删会话：任务还在跑会被拒绝，这时什么都没动；
  // core 等 MCP 服务器退出才返回，再停开发服务器、结束在文件夹里的终端，Windows 上被占用的文件夹删不掉也移不走。
  // 文件夹没删掉时记录照样删了，保留文件夹是安全的，告诉界面它留在哪。
  // core 删完记录后的清理各自兜住错误：记录已经没了，再让界面报删除失败只会让用户重试一个不存在的任务
  const removeSession = async (sessionId: string, trashFolder: boolean): Promise<SessionDeleteResult> => {
    const folder = await workspaceFolderOf(sessionId)
    await deleteSession(await coreConnection(), sessionId)
    const cleanup = async (label: string, step: () => unknown) => {
      try {
        await step()
      } catch (error) {
        console.error(`[sessions] 删除任务后${label}失败`, error)
      }
    }
    await cleanup('关闭浏览器', () => browserHost.close(sessionId))
    await cleanup('移除设计稿', () => designHost.remove(sessionId))
    await cleanup('停止开发服务器', () => stopDevServer(sessionId))
    if (!folder || folder === 'unknown') return { keptFolder: null }
    if (folder.shared) return { keptFolder: { path: folder.cwd, reason: 'shared' } }
    const state = await folderState(folder.cwd)
    if (state === 'nonEmpty' && !trashFolder) return { keptFolder: null }
    if (state !== 'missing') {
      await cleanup('结束文件夹里的终端', () => killTerminalsIn(folder.cwd))
      try {
        // 只移到回收站，不永久删除；rmdir 只删空目录
        await removeFolder(folder.cwd, () => (state === 'empty' ? rmdir(folder.cwd) : shell.trashItem(folder.cwd)))
      } catch (error) {
        console.error('[sessions] 任务文件夹删除失败', error)
        return { keptFolder: { path: folder.cwd, reason: 'failed' } }
      }
    }
    await cleanup('删除检查点仓库', () => rm(join(userDataDir, 'checkpoints', projectKey(folder.cwd)), { recursive: true, force: true }))
    return { keptFolder: null }
  }

  // 同一个任务的并发删除共用一次：两次同时清理同一个文件夹会互相报错，后一次也可能读到删了一半的记录
  const deleting = new Map<string, Promise<SessionDeleteResult>>()
  ipcMain.handle(IPC_CHANNELS.sessionDelete, (_event, rawSessionId: unknown, rawOptions: unknown): Promise<SessionDeleteResult> => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const { trashFolder } = parse(z.object({ trashFolder: z.boolean() }), rawOptions ?? { trashFolder: false })
    const running = deleting.get(sessionId)
    if (running) return running
    const task = removeSession(sessionId, trashFolder).finally(() => {
      deleting.delete(sessionId)
      emitSessionEvent({ type: 'changed', sessionId })
    })
    deleting.set(sessionId, task)
    return task
  })

  // 项目归档：项目下的会话一起归档；取消归档时一起恢复。只改记录，不动项目文件夹
  const projectSessions = async (path: string) => {
    const sessions = await listSessions(await coreConnection(), path)
    return sessions.filter((session) => !session.noProject && sameProjectPath(session.cwd, path))
  }
  ipcMain.handle(IPC_CHANNELS.projectArchive, async (_event, rawPath: unknown, rawArchived: unknown) => {
    const path = parse(z.string().min(1), rawPath)
    const archived = parse(z.boolean(), rawArchived)
    const sessions = await projectSessions(path)
    if (archived && sessions.some((session) => session.running)) throw new Error('项目里还有任务正在运行，等它结束后再归档')
    for (const session of sessions) await updateSession(await coreConnection(), session.sessionId, { archived })
    await settings.update((current) => ({
      ...current,
      archivedProjects: archived
        ? current.archivedProjects.some((item) => sameProjectPath(item, path))
          ? current.archivedProjects
          : [...current.archivedProjects, path]
        : current.archivedProjects.filter((item) => !sameProjectPath(item, path)),
    }))
    for (const session of sessions) emitSessionEvent({ type: 'changed', sessionId: session.sessionId })
  })

  // 永久删除项目记录和项目下的会话记录。和单个任务一样走 removeSession，项目任务不会动项目文件夹
  ipcMain.handle(IPC_CHANNELS.projectDelete, async (_event, rawPath: unknown): Promise<{ sessionIds: string[] }> => {
    const path = parse(z.string().min(1), rawPath)
    const sessions = await projectSessions(path)
    if (sessions.some((session) => session.running)) throw new Error('项目里还有任务正在运行，等它结束后再删除')
    const sessionIds: string[] = []
    for (const session of sessions) {
      await removeSession(session.sessionId, false)
      sessionIds.push(session.sessionId)
      emitSessionEvent({ type: 'changed', sessionId: session.sessionId })
    }
    await settings.update((current) => {
      const projects = Object.fromEntries(Object.entries(current.projects).filter(([key]) => !sameProjectPath(key, path)))
      return {
        ...current,
        projects,
        lastProject: current.lastProject !== null && sameProjectPath(current.lastProject, path) ? null : current.lastProject,
        archivedProjects: current.archivedProjects.filter((item) => !sameProjectPath(item, path)),
      }
    })
    return { sessionIds }
  })

  ipcMain.handle(IPC_CHANNELS.sessionPrompt, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawText: unknown, rawOptions: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const turnId = parse(z.string().min(1), rawTurnId)
    const text = parse(z.string().trim().min(1, '任务内容不能为空'), rawText)
    const options = parse(promptOptionsSchema, rawOptions)
    await designHost.prepare(sessionId)
    const response = await aroundTurn(sessionId, turnId, options.goal ? 'goal' : 'prompt', text, async () => sendPrompt(await coreConnection(), sessionId, turnId, text, options), {
      ...(options.from ? { from: options.from } : {}),
      ...(options.remote ? { remote: options.remote } : {}),
      ...(options.images.length > 0 ? { imageCount: options.images.length } : {}),
    })
    return response.stopReason
  })

  ipcMain.handle(IPC_CHANNELS.sessionDeepScan, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawScope: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const turnId = parse(z.string().min(1), rawTurnId)
    const scope = parse(z.enum(['task', 'project']), rawScope)
    const response = await aroundTurn(sessionId, turnId, 'deep-scan', DEEP_SCAN_TITLES[scope], async () => deepScan(await coreConnection(), sessionId, turnId, scope))
    return response.stopReason
  })

  ipcMain.handle(IPC_CHANNELS.sessionCompact, async (_event, rawSessionId: unknown, rawTurnId: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const turnId = parse(z.string().min(1), rawTurnId)
    const response = await aroundTurn(sessionId, turnId, 'compact', MANUAL_COMPACTION_PROMPT, async () => compactSession(await coreConnection(), sessionId, turnId))
    return response.stopReason
  })

  ipcMain.handle(IPC_CHANNELS.sessionPlan, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawText: unknown, rawSkills: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const turnId = parse(z.string().min(1), rawTurnId)
    const text = parse(z.string().trim().min(1, '任务内容不能为空'), rawText)
    const skills = parse(skillNamesSchema, rawSkills)
    await designHost.prepare(sessionId)
    const response = await aroundTurn(sessionId, turnId, 'plan', text, async () => plan(await coreConnection(), sessionId, turnId, text, skills))
    return response.stopReason
  })

  ipcMain.handle(IPC_CHANNELS.promptEnhance, async (_event, rawRequest: unknown) => {
    const request = parse(
      z.object({
        text: z.string().trim().min(1, '输入框是空的').max(20_000),
        project: z.string().min(1).nullable(),
        sessionId: z.string().min(1).nullable(),
        model: modelRefSchema.optional(),
        mentions: z.array(z.string()).max(50),
        design: z.boolean(),
      }),
      rawRequest,
    )
    const resolved = (await resolveRole('planner', '规划')) ?? (request.model ? await resolveModel(request.model, '所选模型') : await resolveRole('coder', '编码'))
    if (!resolved) throw new ModelConfigError('model-missing', '还没有给「编码」角色分配模型，请先到「设置 → 模型与角色」里选择')
    return enhancePrompt(await coreConnection(), {
      model: resolved.model,
      text: request.text,
      cwd: request.project,
      sessionId: request.sessionId,
      mentions: request.mentions,
      design: request.design,
    })
  })

  ipcMain.handle(IPC_CHANNELS.sessionDiagnose, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawText: unknown, rawTarget: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const turnId = parse(z.string().min(1), rawTurnId)
    const text = parse(z.string().trim().min(1), rawText)
    const target = parse(z.object({ turnId: z.string().min(1), cardId: z.string().min(1).nullable() }), rawTarget)
    const response = await aroundTurn(sessionId, turnId, 'diagnose', text, async () => diagnose(await coreConnection(), sessionId, turnId, text, target))
    return response.stopReason
  })

  // 任务用建任务时的配置；没有任务时按设置里开着的插件和服务器，在最近的项目（没有就用户目录）里启动。
  // 无项目首页用数据目录下一个专门的空目录：新任务建在默认保存位置下的空文件夹里，列不出任何项目 Skill，
  // 这里不能用上一个项目或默认保存位置本身；在默认保存位置起 stdio MCP 还会占住它，没法改名或移动
  const listTarget = async (raw: unknown) => {
    const target = parse(mcpTargetSchema, raw)
    if ('sessionId' in target) return target
    if ('noProject' in target) {
      const cwd = join(userDataDir, 'no-project')
      await mkdir(cwd, { recursive: true })
      return { cwd, plugins: enabledPlugins(settings) }
    }
    return { cwd: target.projectPath ?? settings.get().lastProject ?? app.getPath('home'), plugins: enabledPlugins(settings) }
  }

  const mcpTarget = async (raw: unknown) => {
    const target = await listTarget(raw)
    if ('sessionId' in target) return target
    return { ...target, servers: await mcpServersFor(settings, secrets) }
  }

  ipcMain.handle(IPC_CHANNELS.mcpStatus, async (_event, rawTarget: unknown, rawRetry: unknown) =>
    mcpStatus(await coreConnection(), await mcpTarget(rawTarget), parse(z.boolean(), rawRetry)),
  )

  ipcMain.handle(IPC_CHANNELS.mcpPrompt, async (_event, rawTarget: unknown, rawServer: unknown, rawPrompt: unknown, rawArgs: unknown) =>
    mcpPrompt(
      await coreConnection(),
      await mcpTarget(rawTarget),
      parse(z.string().min(1), rawServer),
      parse(z.string().min(1), rawPrompt),
      parse(z.record(z.string(), z.string().max(10_000)), rawArgs),
    ),
  )

  ipcMain.handle(IPC_CHANNELS.skillsList, async (_event, rawTarget: unknown) => listSkills(await coreConnection(), await listTarget(rawTarget)))

  ipcMain.handle(IPC_CHANNELS.commandsList, async (_event, rawTarget: unknown) => listCommands(await coreConnection(), await listTarget(rawTarget)))

  ipcMain.handle(IPC_CHANNELS.sessionCancel, async (_event, rawSessionId: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    // 正在等用户确认的请求一并按取消答复
    for (const [requestId, pending] of pendingPermissions) {
      if (pending.sessionId === sessionId) settlePermission(requestId, null)
    }
    await cancelSession(await coreConnection(), sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.sessionTaskActionRespond, (_event, rawRequestId: unknown, rawResult: unknown) => {
    const resolve = pendingTaskActions.get(parse(z.string().min(1), rawRequestId))
    if (!resolve) return
    pendingTaskActions.delete(parse(z.string().min(1), rawRequestId))
    resolve(
      parse(
        z.union([
          z.object({ ok: z.literal(true), sessionId: z.string().min(1), title: z.string(), queued: z.boolean() }),
          z.object({ ok: z.literal(false), error: z.string() }),
        ]),
        rawResult,
      ),
    )
  })

  ipcMain.handle(IPC_CHANNELS.sessionPermissionRespond, async (_event, rawRequestId: unknown, rawOptionId: unknown, rawAnswers: unknown) => {
    const requestId = parse(z.string().min(1), rawRequestId)
    const optionId = parse(z.string().min(1).nullable(), rawOptionId)
    const answers = parse(askAnswersSchema.optional(), rawAnswers)
    // 「这个项目里始终允许同类命令」（第 445 步）：把这条命令的命令键记进项目设置，以后这个项目的任务不再问。
    // 只有本机界面能选这一项；存不上只记日志，这一次照样放行
    const remembered = optionId === PERMISSION_OPTIONS.allowProject ? pendingPermissions.get(requestId)?.projectCommands : undefined
    if (remembered) {
      await saveProjectState(remembered.cwd, (current) => ({ ...current, allowedCommands: [...new Set([...current.allowedCommands, ...remembered.keys])] })).catch((error: unknown) =>
        console.error('[sessions] 保存项目里始终允许的命令失败', error),
      )
    }
    settlePermission(requestId, optionId, answers)
  })

  ipcMain.handle(IPC_CHANNELS.checkpointPreview, async (_event, rawSessionId: unknown, rawTurnId: unknown) =>
    previewCheckpoint(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawTurnId)),
  )

  ipcMain.handle(IPC_CHANNELS.checkpointRestore, async (_event, rawSessionId: unknown, rawTurnId: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const changes = await restoreCheckpoint(await coreConnection(), sessionId, parse(z.string().min(1), rawTurnId))
    emitSessionEvent({ type: 'reset', sessionId })
    return changes
  })

  return {
    architectureModel: async () => {
      const resolved = (await resolveRole('planner', '规划')) ?? (await resolveRole('coder', '编码'))
      if (!resolved) throw new ModelConfigError('model-missing', '还没有给「规划」或「编码」角色分配模型，请先到「设置 → 模型与角色」里选择')
      return resolved.model
    },
  }
}

const WORKSPACE_TITLE_CHARS = 20

// 无项目任务的文件夹名：「本地日期 标题前 20 字」，去掉 Windows 不允许的字符和末尾的点、空格。
// 以日期开头，不会撞上 CON、NUL 这类保留名
function workspaceFolderName(title: string): string {
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const cleaned = Array.from(title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ''))
    .slice(0, WORKSPACE_TITLE_CHARS)
    .join('')
    .trim()
    .replace(/[. ]+$/, '')
  return `${date} ${cleaned || '新任务'}`
}

// 子文件夹不带 recursive：重名时 mkdir 原子地报 EEXIST，换下一个序号，不先查后建
async function makeWorkspaceFolder(root: string, base: string): Promise<string> {
  const unavailable = (error: unknown) =>
    new Error(encodeStartTaskError('workspace-missing', `默认保存位置不可用（${root}）：${error instanceof Error ? error.message : String(error)}`))
  await mkdir(root, { recursive: true }).catch((error: unknown) => {
    throw unavailable(error)
  })
  for (let index = 1; ; index++) {
    const path = join(root, index === 1 ? base : `${base} (${index})`)
    try {
      await mkdir(path)
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable(error)
    }
  }
}

// 读不了（权限等）按不空算：宁可多问一句，也不当成空文件夹删掉
async function folderState(cwd: string): Promise<'empty' | 'nonEmpty' | 'missing'> {
  try {
    return (await readdir(cwd)).length === 0 ? 'empty' : 'nonEmpty'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'nonEmpty'
  }
}

const REMOVE_RETRY_MS = 200
const REMOVE_RETRY_TOTAL_MS = 3000
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
// shell.trashItem 在 Windows 上只给文字说明，没有 code；文件夹被占用时是这两种
const TRASH_BUSY_MESSAGES = ['Failed to perform delete operation', 'File operation aborted']

function folderBusy(error: unknown): boolean {
  if (BUSY_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return true
  return error instanceof Error && TRASH_BUSY_MESSAGES.some((text) => error.message.includes(text))
}

// 读不了（权限等）按还在算
async function folderExists(cwd: string): Promise<boolean> {
  try {
    await stat(cwd)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

// 刚结束的终端、MCP 服务器，以及杀毒和索引服务，可能还短暂占着文件夹：被占用时隔一会儿再试，最多约 3 秒；
// 中途文件夹已经不在了就算删掉了
async function removeFolder(cwd: string, remove: () => Promise<void>): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      await remove()
      return
    } catch (error) {
      if (!(await folderExists(cwd))) return
      if (!folderBusy(error) || Date.now() - started >= REMOVE_RETRY_TOTAL_MS) throw error
      await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS))
    }
  }
}

// 每个项目一个检查点仓库；Windows 路径不分大小写
function projectKey(path: string): string {
  const normalized = process.platform === 'win32' ? path.toLowerCase() : path
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}
