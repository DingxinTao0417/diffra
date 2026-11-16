import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { configureSecurity, type ModelEndpoint, type ModelError, requestListModels, requestTestModel } from '@diffra/core'
import { REASONING_EFFORTS } from '@diffra/core/types'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { MAX_MODEL_ID_LENGTH, MCP_TRANSPORTS, type McpServerConfig, type ModelRef, reasoningChoiceKey, ROLES, type Settings, type SettingsView } from '../shared/settings'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import { mcpSecretKey, mcpSecretKeys } from './mcp-servers'
import { oauthFor, oauthStates } from './mcp-oauth'
import { browserHost } from './browser'
import type { SecretStore } from './secret-store'
import {
  appearanceSchema,
  layoutSchema,
  browserSettingsSchema,
  executionSchema,
  MCP_NAME_PATTERN,
  modelRefSchema,
  permissionModeSchema,
  providerFieldsSchema,
  securitySchema,
  type SettingsStore,
} from './settings-store'

const providerInputSchema = providerFieldsSchema.extend({
  id: z.string().min(1).optional(),
  apiKey: z.string().trim().optional(),
})

const namedValue = (pattern: RegExp, label: string) =>
  z.object({ name: z.string().trim().regex(pattern, `${label}名称不合法`), value: z.string().nullable() })

const mcpInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().trim().regex(MCP_NAME_PATTERN, '名称只能用字母、数字、- 和 _，最多 32 个字符'),
    enabled: z.boolean(),
    transport: z.enum(MCP_TRANSPORTS),
    command: z.string().trim(),
    args: z.array(z.string().trim().min(1)).max(100),
    url: z.string().trim(),
    env: z.array(namedValue(/^[A-Za-z_][A-Za-z0-9_]*$/, '环境变量')).max(50),
    headers: z.array(namedValue(/^[A-Za-z0-9-]+$/, '请求头')).max(50),
    // 浏览器登录（OAuth）的远程服务器，v2 加的
    auth: z.literal('oauth').optional(),
  })
  .superRefine((input, context) => {
    if (input.transport === 'stdio' && !input.command) context.addIssue({ code: 'custom', message: '请填写启动命令' })
    if (input.transport === 'http' && !/^https?:\/\/\S+$/.test(input.url)) context.addIssue({ code: 'custom', message: '地址要以 http:// 或 https:// 开头' })
    const names = (input.transport === 'stdio' ? input.env : input.headers).map((item) => item.name.toLowerCase())
    if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: '有重名的环境变量或请求头' })
  })

export async function providerEndpoint(
  settings: SettingsStore,
  secrets: SecretStore,
  providerId: string,
): Promise<{ ok: true; endpoint: ModelEndpoint } | { ok: false; error: ModelError }> {
  const provider = settings.get().providers.find((item) => item.id === providerId)
  if (!provider) return { ok: false, error: { kind: 'not-found', message: '供应商不存在' } }
  const apiKey = await secrets.get(providerId)
  if (!apiKey) return { ok: false, error: { kind: 'auth', message: '还没有填写密钥' } }
  return { ok: true, endpoint: { protocol: provider.protocol, baseUrl: provider.baseUrl, apiKey } }
}

let warnedWorkspace: string | null = null

// 无项目任务的保存位置。默认值：打包版放「文档\Diffra」；开发版和 e2e 放数据目录下，不往真实的「文档」里写
export function workspaceRoot(settings: SettingsStore): { path: string; isDefault: boolean } {
  const chosen = settings.get().defaultWorkspace
  if (chosen && isAbsolute(chosen)) return { path: chosen, isDefault: false }
  // 手改设置文件写成相对路径时会按主进程的当前目录解析（打包版常是安装目录），回落到默认值
  if (chosen && warnedWorkspace !== chosen) {
    warnedWorkspace = chosen
    console.warn(`[settings] 默认保存位置不是绝对路径，改用默认值：${chosen}`)
  }
  return { path: app.isPackaged ? join(app.getPath('documents'), 'Diffra') : join(app.getPath('userData'), 'workspace'), isDefault: true }
}

// 只留还在的模型的选择，删掉的模型不会在设置文件里越积越多；不认识的模型不记
function rememberReasoning(current: Settings, choice: { providerId: string; modelId: string; effort: Settings['reasoningChoices'][string] }): Settings['reasoningChoices'] {
  const keys = new Set(current.providers.flatMap((provider) => provider.models.map((model) => reasoningChoiceKey({ providerId: provider.id, modelId: model.id }))))
  const kept = Object.fromEntries(Object.entries(current.reasoningChoices).filter(([key]) => keys.has(key)))
  const key = reasoningChoiceKey(choice)
  return keys.has(key) ? { ...kept, [key]: choice.effort } : kept
}

export async function settingsView(settings: SettingsStore, secrets: SecretStore): Promise<SettingsView> {
  const { providers, roles, appearance, layout, browser, defaultPermissionMode, security, execution, mcpServers, reasoningChoices, archivedProjects, externalAgents, computerUse } = settings.get()
  return {
    providers: await Promise.all(
      providers.map(async (provider) => ({ ...provider, keyHint: await secrets.hint(provider.id) })),
    ),
    roles,
    appearance,
    layout,
    browser,
    defaultPermissionMode,
    security,
    execution,
    mcpServers,
    reasoningChoices,
    archivedProjects,
    defaultWorkspace: workspaceRoot(settings),
    externalAgents,
    mcpOAuth: await oauthStates(settings, secrets),
    computerUse: computerUse ?? { enabled: false, acknowledged: false },
    loadError: settings.loadError ?? secrets.loadError,
  }
}

// 保存一个 MCP 服务器（手动添加、编辑和扩展目录一键装共用）。只保存当前类型用到的那组名字和值，另一组连同密钥一起删掉
export async function saveMcpServer(settings: SettingsStore, secrets: SecretStore, raw: unknown): Promise<void> {
  const input = parse(mcpInputSchema, raw)
  const servers = settings.get().mcpServers
  const previous = input.id ? servers.find((server) => server.id === input.id) : undefined
  if (input.id && !previous) throw new Error('MCP 服务器不存在')
  if (servers.some((server) => server.id !== input.id && server.name.toLowerCase() === input.name.toLowerCase())) {
    throw new Error(`已经有名为「${input.name}」的 MCP 服务器`)
  }
  const id = previous?.id ?? randomUUID()
  const kind = input.transport === 'stdio' ? 'env' : 'header'
  const values = input.transport === 'stdio' ? input.env : input.headers
  const savedNames = previous ? (kind === 'env' ? previous.envNames : previous.headerNames) : []
  const missing = values.find((item) => item.value === null && !savedNames.includes(item.name))
  if (missing) throw new Error(`「${missing.name}」还没有填值`)
  // 先存密钥：加密失败时整个保存都不生效
  for (const item of values) if (item.value !== null) await secrets.set(mcpSecretKey(id, kind, item.name), item.value)
  const server: McpServerConfig = {
    id,
    name: input.name,
    enabled: input.enabled,
    transport: input.transport,
    command: input.transport === 'stdio' ? input.command : '',
    args: input.transport === 'stdio' ? input.args : [],
    envNames: kind === 'env' ? values.map((item) => item.name) : [],
    url: input.transport === 'http' ? input.url : '',
    headerNames: kind === 'header' ? values.map((item) => item.name) : [],
    ...(input.transport === 'http' && input.auth === 'oauth' ? { auth: 'oauth' as const } : {}),
  }
  await settings.update((current) => ({
    ...current,
    mcpServers: previous ? current.mcpServers.map((item) => (item.id === id ? server : item)) : [...current.mcpServers, server],
  }))
  const kept = new Set(mcpSecretKeys(server))
  for (const key of previous ? mcpSecretKeys(previous) : []) if (!kept.has(key)) await secrets.delete(key)
}

export function registerSettingsIpc(settings: SettingsStore, secrets: SecretStore): void {
  const view = () => settingsView(settings, secrets)

  const endpointFor = (providerId: string) => providerEndpoint(settings, secrets, providerId)

  ipcMain.handle(IPC_CHANNELS.settingsGet, () => view())

  ipcMain.handle(IPC_CHANNELS.preferencesSave, async (_event, raw: unknown) => {
    const change = parse(
      z.object({
        appearance: appearanceSchema.optional(),
        layout: layoutSchema.optional(),
        browser: browserSettingsSchema.optional(),
        defaultPermissionMode: permissionModeSchema.optional(),
        security: securitySchema.optional(),
        execution: executionSchema.optional(),
        computerUse: z.object({ enabled: z.boolean(), acknowledged: z.boolean() }).optional(),
        reasoningChoice: z.object({ providerId: z.string().min(1), modelId: z.string().min(1), effort: z.enum(REASONING_EFFORTS) }).optional(),
      }),
      raw,
    )
    const { reasoningChoice, ...preferences } = change
    await settings.update((current) => ({ ...current, ...preferences, ...(reasoningChoice ? { reasoningChoices: rememberReasoning(current, reasoningChoice) } : {}) }))
    if (change.browser) browserHost.pushSites()
    // 检查开关对已经打开的任务立即生效；推送失败时设置照样存下，之后新建、载入的任务按设置
    if (change.security) {
      const switches = change.security
      await configureSecurity(await coreConnection(), switches).catch((error: unknown) => console.error('[settings] 同步检查开关到 core 失败', error))
    }
    return view()
  })

  ipcMain.handle(IPC_CHANNELS.workspacePick, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = { title: '选择默认保存位置', defaultPath: workspaceRoot(settings).path, properties: ['openDirectory' as const, 'createDirectory' as const] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? undefined : result.filePaths[0]
    if (!path) return null
    await settings.update((current) => ({ ...current, defaultWorkspace: path }))
    return view()
  })

  ipcMain.handle(IPC_CHANNELS.workspaceReset, async () => {
    await settings.update((current) => ({ ...current, defaultWorkspace: null }))
    return view()
  })

  // 默认位置在建第一个无项目任务时才创建，这里先建好再打开
  ipcMain.handle(IPC_CHANNELS.workspaceOpen, async () => {
    const { path } = workspaceRoot(settings)
    await mkdir(path, { recursive: true })
    const message = await shell.openPath(path)
    if (message) throw new Error(`打不开文件夹：${message}`)
  })

  ipcMain.handle(IPC_CHANNELS.providerSave, async (_event, raw: unknown) => {
    const { id: inputId, apiKey, ...fields } = parse(providerInputSchema, raw)
    if (inputId && !settings.get().providers.some((provider) => provider.id === inputId)) {
      throw new Error('供应商不存在')
    }
    const id = inputId ?? randomUUID()
    // 先存密钥：加密失败时整个保存都不生效
    if (apiKey) await secrets.set(id, apiKey)
    await settings.update((current) => {
      const provider = { id, ...fields }
      const providers = inputId
        ? current.providers.map((item) => (item.id === id ? provider : item))
        : [...current.providers, provider]
      return pruneRoles({ ...current, providers })
    })
    return view()
  })

  ipcMain.handle(IPC_CHANNELS.providerDelete, async (_event, raw: unknown) => {
    const id = parse(z.string().min(1), raw)
    await settings.update((current) =>
      pruneRoles({ ...current, providers: current.providers.filter((provider) => provider.id !== id) }),
    )
    await secrets.delete(id)
    return view()
  })

  ipcMain.handle(IPC_CHANNELS.mcpSave, async (_event, raw: unknown) => {
    await saveMcpServer(settings, secrets, raw)
    return view()
  })

  ipcMain.handle(IPC_CHANNELS.mcpDelete, async (_event, raw: unknown) => {
    const id = parse(z.string().min(1), raw)
    const server = settings.get().mcpServers.find((item) => item.id === id)
    if (!server) return view()
    await settings.update((current) => ({ ...current, mcpServers: current.mcpServers.filter((item) => item.id !== id) }))
    for (const key of mcpSecretKeys(server)) await secrets.delete(key)
    // 浏览器登录的：同一个地址没有别的服务器在用了就退出登录（撤销令牌，删掉本机的）
    if (server.auth === 'oauth' && !settings.get().mcpServers.some((item) => item.auth === 'oauth' && item.url === server.url)) {
      await oauthFor(secrets, server.url)
        .logout()
        .catch((error: unknown) => console.error(`[mcp] 删除 ${server.name} 时退出登录失败`, error))
    }
    return view()
  })

  ipcMain.handle(IPC_CHANNELS.roleSet, async (_event, rawRole: unknown, rawRef: unknown) => {
    const role = parse(z.enum(ROLES), rawRole)
    const ref = parse(modelRefSchema.nullable(), rawRef)
    if (ref && !modelExists(settings.get(), ref)) throw new Error('所选模型不存在')
    await settings.update((current) => ({ ...current, roles: { ...current.roles, [role]: ref } }))
    return view()
  })

  ipcMain.handle(IPC_CHANNELS.modelsList, async (_event, raw: unknown) => {
    const target = await endpointFor(parse(z.string().min(1), raw))
    if (!target.ok) return target
    return requestListModels(await coreConnection(), target.endpoint)
  })

  // 校验草稿连接，不落盘；编辑时密钥留空沿用已保存密钥，绝不回传给界面。
  ipcMain.handle(IPC_CHANNELS.modelsValidate, async (_event, raw: unknown, rawModelId: unknown) => {
    const input = parse(providerInputSchema, raw)
    const modelId = parse(z.string().trim().min(1).max(MAX_MODEL_ID_LENGTH), rawModelId)
    if (input.id && !settings.get().providers.some((provider) => provider.id === input.id)) throw new Error('供应商不存在')
    const apiKey = input.apiKey || (input.id ? await secrets.get(input.id) : null)
    if (!apiKey) throw new Error('请填写 API Key')
    return requestTestModel(await coreConnection(), { protocol: input.protocol, baseUrl: input.baseUrl, apiKey }, modelId)
  })

  ipcMain.handle(IPC_CHANNELS.modelsTest, async (_event, rawProviderId: unknown, rawModelId: unknown) => {
    const target = await endpointFor(parse(z.string().min(1), rawProviderId))
    if (!target.ok) return target
    return requestTestModel(await coreConnection(), target.endpoint, parse(z.string().min(1), rawModelId))
  })
}

function modelExists(settings: Settings, ref: ModelRef): boolean {
  return settings.providers.some(
    (provider) => provider.id === ref.providerId && provider.models.some((model) => model.id === ref.modelId && model.enabled !== false),
  )
}

// 供应商或模型被删掉后，指向它的角色清空
function pruneRoles(settings: Settings): Settings {
  const roles = { ...settings.roles }
  for (const role of ROLES) {
    const ref = roles[role]
    if (ref && !modelExists(settings, ref)) roles[role] = null
  }
  return { ...settings, roles }
}
