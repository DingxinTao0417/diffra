import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  cancelSession,
  checkpointDiff,
  configureSession,
  compactSession,
  type CoreClientHandlers,
  createSession,
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
  sendPrompt,
  updateSession,
  usageSummary,
} from '@diffra/core'
import { PROMPT_IMAGE_TYPES } from '@diffra/core/types'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import {
  encodeStartTaskError,
  IPC_CHANNELS,
  type LoadedSessionHandle,
  type PermissionRequestEvent,
  type ProjectState,
  type SessionHandle,
} from '../shared/ipc'
import { modelDisplayName, type ModelRef } from '../shared/settings'
import { reasoningEffortsFor } from '../shared/reasoning'
import { coreConnection } from './core-process'
import { browserHost } from './browser'
import { designHost } from './design'
import { devServer, stopDevServer } from './terminal-ipc'
import { parse } from './ipc-input'
import { mcpServersFor } from './mcp-servers'
import { enabledPlugins } from './plugins-ipc'
import { SESSION_RULES } from './rule-packs'
import type { SecretStore } from './secret-store'
import { providerEndpoint } from './settings-ipc'
import {
  modelRefSchema,
  permissionModeSchema,
  projectSettingsSchema,
  type SettingsStore,
} from './settings-store'

const execFileAsync = promisify(execFile)

const sessionOptionsSchema = z.object({
  permissionMode: permissionModeSchema.optional(),
  model: modelRefSchema.optional(),
  // 设计任务，只在新建时有效
  design: z.boolean().optional(),
})
type SessionOptions = z.infer<typeof sessionOptionsSchema>

const skillNamesSchema = z.array(z.string().min(1).max(200)).max(20)
const promptImagesSchema = z
  .array(z.object({ mimeType: z.enum(PROMPT_IMAGE_TYPES), data: z.string().min(1).max(8_000_000).regex(/^[A-Za-z0-9+/]+=*$/) }))
  .max(6)
const promptOptionsSchema = z.object({ skills: skillNamesSchema, goal: z.boolean(), images: promptImagesSchema })

const mcpTargetSchema = z.union([z.object({ sessionId: z.string().min(1) }), z.object({ projectPath: z.string().min(1).nullable() })])

const NO_CHECKS: SessionChecks = { afterEdit: null, beforeFinish: null }

interface PendingPermission {
  sessionId: string
  resolve(optionId: string | null): void
}

const pendingPermissions = new Map<string, PendingPermission>()

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
  },
  onPermissionRequest: (request) =>
    new Promise((resolve) => {
      const requestId = randomUUID()
      pendingPermissions.set(requestId, {
        sessionId: request.sessionId,
        resolve: (optionId) =>
          resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }),
      })
      const event: PermissionRequestEvent = {
        requestId,
        sessionId: request.sessionId,
        toolCall: request.toolCall,
        options: request.options,
      }
      // 没有窗口能回答时直接按取消处理，不让 core 一直等
      if (broadcast(IPC_CHANNELS.sessionPermission, event) === 0) settlePermission(requestId, null)
    }),
  onBrowserAction: (params) => browserHost.act(params),
  onDevServer: (params) => devServer(params),
  onDesignAction: (params) => designHost.act(params),
}

function settlePermission(requestId: string, optionId: string | null): void {
  const pending = pendingPermissions.get(requestId)
  if (!pending) return
  pendingPermissions.delete(requestId)
  pending.resolve(optionId)
}

export function registerSessionIpc(settings: SettingsStore, secrets: SecretStore, userDataDir: string): void {
  const projectState = (path: string): ProjectState => {
    const project = settings.get().projects[path]
    return {
      path,
      checks: project?.checks ?? NO_CHECKS,
      readOnlyPaths: project?.readOnlyPaths ?? [],
    }
  }

  const saveProjectState = async (path: string, change: (current: ProjectState) => ProjectState) => {
    const { checks, readOnlyPaths } = change(projectState(path))
    await settings.update((current) => ({ ...current, projects: { ...current.projects, [path]: { checks, readOnlyPaths } } }))
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
        reasoningEffort: ref.reasoningEffort,
      },
    }
  }

  const resolveRole = async (role: 'coder' | 'reviewer' | 'planner' | 'fallback', label: string) => {
    const ref = settings.get().roles[role]
    return ref ? resolveModel(ref, `「${label}」角色的模型`) : null
  }

  const rememberProject = (path: string) => settings.update((current) => ({ ...current, lastProject: path }))

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
    const input = parse(projectSettingsSchema.pick({ checks: true, readOnlyPaths: true }), rawSettings)
    return saveProjectState(path, (current) => ({ ...current, ...input }))
  })

  // 新建和加载都按当前设置组装会话配置：模型、检查、规范改过的话，打开旧任务也用新的。
  // 输入框里选的模型和权限模式优先，没选就用「编码」角色和默认权限模式
  const sessionConfig = async (
    path: string,
    options: SessionOptions = {},
  ): Promise<{ config: SessionConfig; modelLabel: string; planLabel: string | null; fallbackLabel: string | null }> => {
    const coder = options.model ? await resolveModel(options.model, '所选模型') : await resolveRole('coder', '编码')
    if (!coder) throw new ModelConfigError('model-missing', '还没有给「编码」角色分配模型，请先到「设置 → 模型与角色」里选择')
    const project = projectState(path)
    // 审查一直开着；没分配评审角色时 core 用编码模型审查
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
        rules: SESSION_RULES,
        permissionMode: options.permissionMode ?? settings.get().defaultPermissionMode,
        security: { staticCheck: settings.get().security.staticCheck, lightScan: settings.get().security.lightScan },
        limits: {
          compactAtPercent: settings.get().execution.compactAtPercent,
          maxSteps: settings.get().execution.maxSteps,
          goalMaxRounds: settings.get().execution.goalMaxRounds,
        },
        plugins: enabledPlugins(settings),
        browser: true,
        design: options.design ?? false,
        checkpointDir: join(userDataDir, 'checkpoints', projectKey(path)),
      },
      modelLabel: coder.label,
      planLabel: planner?.label ?? null,
      fallbackLabel: fallback?.label ?? null,
    }
  }

  ipcMain.handle(IPC_CHANNELS.sessionCreate, async (_event, rawPath: unknown, rawOptions: unknown): Promise<SessionHandle> => {
    const path = parse(z.string().min(1), rawPath)
    const options = parse(sessionOptionsSchema, rawOptions ?? {})
    const dir = await stat(path).catch(() => null)
    if (!dir?.isDirectory()) throw new Error(encodeStartTaskError('project-missing', '项目文件夹不存在或已被移走，请重新选择项目'))
    const { config, modelLabel, planLabel, fallbackLabel } = await sessionConfig(path, options).catch((error: unknown) => {
      throw error instanceof ModelConfigError ? new Error(encodeStartTaskError(error.code, error.message)) : error
    })
    const { sessionId, info } = await createSession(await coreConnection(), path, config, await mcpServersFor(settings, secrets))
    await rememberProject(path)
    if (config.design) designHost.enable(sessionId)
    return { sessionId, info, modelLabel, modelRef: options.model ?? settings.get().roles.coder ?? undefined, planLabel, fallbackLabel, permissionMode: config.permissionMode, design: config.design ?? false }
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

  ipcMain.handle(IPC_CHANNELS.sessionRewind, async (_event, rawSessionId: unknown, rawTurnId: unknown) =>
    rewindSession(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawTurnId)),
  )

  ipcMain.handle(IPC_CHANNELS.checkpointDiff, async (_event, rawSessionId: unknown, rawTurnId: unknown) =>
    checkpointDiff(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawTurnId)),
  )

  // 当前分支名，分离头指针时是提交号；不是 git 仓库或没装 git 时为 null。
  // symbolic-ref 在还没有提交的新仓库里也能拿到分支名
  ipcMain.handle(IPC_CHANNELS.projectBranch, async (_event, rawPath: unknown) => {
    const path = parse(z.string().min(1), rawPath)
    const git = async (args: string[]) => {
      try {
        const { stdout } = await execFileAsync('git', args, { cwd: path, timeout: 5000, windowsHide: true })
        return stdout.trim() || null
      } catch {
        return null
      }
    }
    return (await git(['symbolic-ref', '--short', '-q', 'HEAD'])) ?? (await git(['rev-parse', '--short', 'HEAD']))
  })

  ipcMain.handle(IPC_CHANNELS.projectOpenFolder, async (_event, rawPath: unknown) => {
    const message = await shell.openPath(parse(z.string().min(1), rawPath))
    if (message) throw new Error(`打不开文件夹：${message}`)
  })

  // 会话记录占用的磁盘空间
  ipcMain.handle(IPC_CHANNELS.sessionsStorage, async () => {
    const dir = join(userDataDir, 'sessions')
    const names = await readdir(dir).catch(() => [] as string[])
    let bytes = 0
    for (const name of names) bytes += (await stat(join(dir, name)).catch(() => null))?.size ?? 0
    return { bytes, dir }
  })

  // 时间范围和时区由界面给，core 校验
  ipcMain.handle(IPC_CHANNELS.usageSummary, async (_event, rawQuery: unknown) =>
    usageSummary(await coreConnection(), parse(z.object({ from: z.string(), to: z.string(), timeZone: z.string() }), rawQuery)),
  )

  ipcMain.handle(IPC_CHANNELS.sessionLoad, async (_event, rawSessionId: unknown, rawPath: unknown): Promise<LoadedSessionHandle> => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const path = parse(z.string().min(1), rawPath)
    const { config, modelLabel, planLabel, fallbackLabel } = await sessionConfig(path)
    const loaded = await loadSession(await coreConnection(), sessionId, path, config, await mcpServersFor(settings, secrets))
    await rememberProject(path)
    if (loaded.design) designHost.enable(sessionId)
    return { sessionId, info: loaded.info, modelLabel, modelRef: settings.get().roles.coder ?? undefined, planLabel, fallbackLabel, permissionMode: config.permissionMode, title: loaded.title, turns: loaded.turns, taskState: loaded.taskState, design: loaded.design }
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
  })

  ipcMain.handle(IPC_CHANNELS.sessionDelete, async (_event, rawSessionId: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    await deleteSession(await coreConnection(), sessionId)
    browserHost.close(sessionId)
    await designHost.remove(sessionId)
    stopDevServer(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.sessionPrompt, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawText: unknown, rawOptions: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const turnId = parse(z.string().min(1), rawTurnId)
    const text = parse(z.string().trim().min(1, '任务内容不能为空'), rawText)
    await designHost.prepare(sessionId)
    const response = await sendPrompt(await coreConnection(), sessionId, turnId, text, parse(promptOptionsSchema, rawOptions))
    return response.stopReason
  })

  ipcMain.handle(IPC_CHANNELS.sessionDeepScan, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawScope: unknown) => {
    const response = await deepScan(
      await coreConnection(),
      parse(z.string().min(1), rawSessionId),
      parse(z.string().min(1), rawTurnId),
      parse(z.enum(['task', 'project']), rawScope),
    )
    return response.stopReason
  })

  ipcMain.handle(IPC_CHANNELS.sessionCompact, async (_event, rawSessionId: unknown, rawTurnId: unknown) => {
    const response = await compactSession(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawTurnId))
    return response.stopReason
  })

  ipcMain.handle(IPC_CHANNELS.sessionPlan, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawText: unknown, rawSkills: unknown) => {
    await designHost.prepare(parse(z.string().min(1), rawSessionId))
    const response = await plan(
      await coreConnection(),
      parse(z.string().min(1), rawSessionId),
      parse(z.string().min(1), rawTurnId),
      parse(z.string().trim().min(1, '任务内容不能为空'), rawText),
      parse(skillNamesSchema, rawSkills),
    )
    return response.stopReason
  })

  // 任务用建任务时的配置；没有任务时按设置里开着的服务器，在最近的项目（没有就用户目录）里启动
  const mcpTarget = async (raw: unknown) => {
    const target = parse(mcpTargetSchema, raw)
    if ('sessionId' in target) return target
    return {
      cwd: target.projectPath ?? settings.get().lastProject ?? app.getPath('home'),
      servers: await mcpServersFor(settings, secrets),
      plugins: enabledPlugins(settings),
    }
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

  ipcMain.handle(IPC_CHANNELS.skillsList, async (_event, rawPath: unknown) =>
    listSkills(await coreConnection(), parse(z.string().min(1), rawPath), enabledPlugins(settings)),
  )

  ipcMain.handle(IPC_CHANNELS.commandsList, async (_event, rawPath: unknown) =>
    listCommands(await coreConnection(), parse(z.string().min(1), rawPath), enabledPlugins(settings)),
  )

  ipcMain.handle(IPC_CHANNELS.sessionCancel, async (_event, rawSessionId: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    // 正在等用户确认的请求一并按取消答复
    for (const [requestId, pending] of pendingPermissions) {
      if (pending.sessionId === sessionId) settlePermission(requestId, null)
    }
    await cancelSession(await coreConnection(), sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.sessionPermissionRespond, (_event, rawRequestId: unknown, rawOptionId: unknown) => {
    settlePermission(parse(z.string().min(1), rawRequestId), parse(z.string().min(1).nullable(), rawOptionId))
  })

  ipcMain.handle(IPC_CHANNELS.checkpointPreview, async (_event, rawSessionId: unknown, rawTurnId: unknown) =>
    previewCheckpoint(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawTurnId)),
  )

  ipcMain.handle(IPC_CHANNELS.checkpointRestore, async (_event, rawSessionId: unknown, rawTurnId: unknown) =>
    restoreCheckpoint(await coreConnection(), parse(z.string().min(1), rawSessionId), parse(z.string().min(1), rawTurnId)),
  )
}

// 每个项目一个检查点仓库；Windows 路径不分大小写
function projectKey(path: string): string {
  const normalized = process.platform === 'win32' ? path.toLowerCase() : path
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}
