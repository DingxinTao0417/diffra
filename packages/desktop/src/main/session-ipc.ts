import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  cancelSession,
  checkpointDiff,
  configureSession,
  type CoreClientHandlers,
  createSession,
  deepScan,
  deleteSession,
  detectProjectChecks,
  listSessions,
  loadSession,
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
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import {
  IPC_CHANNELS,
  type LoadedSessionHandle,
  type PermissionRequestEvent,
  type ProjectState,
  type SessionHandle,
} from '../shared/ipc'
import type { ModelRef, ProjectRuleSettings } from '../shared/settings'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import { type RulePackStore, sessionRules } from './rule-packs'
import type { SecretStore } from './secret-store'
import { providerEndpoint } from './settings-ipc'
import {
  modelRefSchema,
  permissionModeSchema,
  projectRuleSettingsSchema,
  projectSettingsSchema,
  type SettingsStore,
} from './settings-store'

const execFileAsync = promisify(execFile)

const sessionOptionsSchema = z.object({
  permissionMode: permissionModeSchema.optional(),
  model: modelRefSchema.optional(),
})
type SessionOptions = z.infer<typeof sessionOptionsSchema>

const NO_CHECKS: SessionChecks = { afterEdit: null, beforeFinish: null }
const DEFAULT_RULE_SETTINGS: ProjectRuleSettings = { disabledPacks: [], disabledRules: [], includeRecommended: false, review: false }

interface PendingPermission {
  sessionId: string
  resolve(optionId: string | null): void
}

const pendingPermissions = new Map<string, PendingPermission>()

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
}

function settlePermission(requestId: string, optionId: string | null): void {
  const pending = pendingPermissions.get(requestId)
  if (!pending) return
  pendingPermissions.delete(requestId)
  pending.resolve(optionId)
}

export function registerSessionIpc(settings: SettingsStore, secrets: SecretStore, userDataDir: string, rulePacks: RulePackStore): void {
  const projectState = (path: string): ProjectState => {
    const project = settings.get().projects[path]
    return {
      path,
      checks: project?.checks ?? NO_CHECKS,
      readOnlyPaths: project?.readOnlyPaths ?? [],
      rules: project?.rules ?? DEFAULT_RULE_SETTINGS,
    }
  }

  const saveProjectState = async (path: string, change: (current: ProjectState) => ProjectState) => {
    const { checks, readOnlyPaths, rules } = change(projectState(path))
    await settings.update((current) => ({ ...current, projects: { ...current.projects, [path]: { checks, readOnlyPaths, rules } } }))
    return projectState(path)
  }

  // 模型和它的接入点；配置不完整时报错说明去哪里改
  const resolveModel = async (ref: ModelRef, label: string) => {
    const provider = settings.get().providers.find((item) => item.id === ref.providerId)
    const model = provider?.models.find((item) => item.id === ref.modelId)
    if (!provider || !model) throw new Error(`${label}指向的模型不存在，请到「模型」页重新选择`)
    const target = await providerEndpoint(settings, secrets, provider.id)
    if (!target.ok) throw new Error(`「${provider.name}」${target.error.message}`)
    return {
      label: `${provider.name} / ${model.id}`,
      model: {
        endpoint: target.endpoint,
        modelId: model.id,
        contextWindow: model.contextWindow,
        provider: { id: provider.id, name: provider.name },
      },
    }
  }

  const resolveRole = async (role: 'coder' | 'reviewer', label: string) => {
    const ref = settings.get().roles[role]
    return ref ? resolveModel(ref, `「${label}」角色`) : null
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

  ipcMain.handle(IPC_CHANNELS.projectSaveRules, async (_event, rawPath: unknown, rawRules: unknown) => {
    const path = parse(z.string().min(1), rawPath)
    const rules = parse(projectRuleSettingsSchema, rawRules)
    return saveProjectState(path, (current) => ({ ...current, rules }))
  })

  // 新建和加载都按当前设置组装会话配置：模型、检查、规范改过的话，打开旧任务也用新的。
  // 输入框里选的模型和权限模式优先，没选就用「编码」角色和默认权限模式
  const sessionConfig = async (path: string, options: SessionOptions = {}): Promise<{ config: SessionConfig; modelLabel: string }> => {
    const coder = options.model ? await resolveModel(options.model, '所选模型') : await resolveRole('coder', '编码')
    if (!coder) throw new Error('还没有给「编码」角色分配模型，请先到「模型」页设置')
    const project = projectState(path)
    const rules = sessionRules((await rulePacks.list()).packs.map((entry) => entry.pack), project.rules)
    // 只有开了审查才用到评审模型；没分配评审角色时 core 用编码模型审查
    const reviewer = rules.review ? await resolveRole('reviewer', '评审') : null
    return {
      config: {
        model: coder.model,
        reviewModel: reviewer ? { endpoint: reviewer.model.endpoint, modelId: reviewer.model.modelId, provider: reviewer.model.provider } : null,
        checks: project.checks,
        readOnlyPaths: project.readOnlyPaths,
        rules,
        permissionMode: options.permissionMode ?? settings.get().defaultPermissionMode,
        security: { staticCheck: settings.get().security.staticCheck, lightScan: settings.get().security.lightScan },
        checkpointDir: join(userDataDir, 'checkpoints', projectKey(path)),
      },
      modelLabel: coder.label,
    }
  }

  ipcMain.handle(IPC_CHANNELS.sessionCreate, async (_event, rawPath: unknown, rawOptions: unknown): Promise<SessionHandle> => {
    const path = parse(z.string().min(1), rawPath)
    const options = parse(sessionOptionsSchema, rawOptions ?? {})
    const { config, modelLabel } = await sessionConfig(path, options)
    const { sessionId, info } = await createSession(await coreConnection(), path, config)
    await rememberProject(path)
    return { sessionId, info, modelLabel, permissionMode: config.permissionMode }
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
    const { config, modelLabel } = await sessionConfig(path)
    const loaded = await loadSession(await coreConnection(), sessionId, path, config)
    await rememberProject(path)
    return { sessionId, info: loaded.info, modelLabel, permissionMode: config.permissionMode, title: loaded.title, turns: loaded.turns }
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
    await deleteSession(await coreConnection(), parse(z.string().min(1), rawSessionId))
  })

  ipcMain.handle(IPC_CHANNELS.sessionPrompt, async (_event, rawSessionId: unknown, rawTurnId: unknown, rawText: unknown) => {
    const sessionId = parse(z.string().min(1), rawSessionId)
    const turnId = parse(z.string().min(1), rawTurnId)
    const text = parse(z.string().trim().min(1, '任务内容不能为空'), rawText)
    const response = await sendPrompt(await coreConnection(), sessionId, turnId, text)
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
