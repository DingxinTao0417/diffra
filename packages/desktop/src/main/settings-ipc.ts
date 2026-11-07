import { randomUUID } from 'node:crypto'
import { type ModelEndpoint, type ModelError, requestListModels, requestTestModel } from '@diffra/core'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { MCP_TRANSPORTS, type McpServerConfig, type ModelRef, ROLES, type Settings, type SettingsView } from '../shared/settings'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import { mcpSecretKey, mcpSecretKeys } from './mcp-servers'
import type { SecretStore } from './secret-store'
import {
  appearanceSchema,
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

export function registerSettingsIpc(settings: SettingsStore, secrets: SecretStore): void {
  const view = async (): Promise<SettingsView> => {
    const { providers, roles, appearance, defaultPermissionMode, security, execution, mcpServers } = settings.get()
    return {
      providers: await Promise.all(
        providers.map(async (provider) => ({ ...provider, keyHint: await secrets.hint(provider.id) })),
      ),
      roles,
      appearance,
      defaultPermissionMode,
      security,
      execution,
      mcpServers,
      loadError: settings.loadError ?? secrets.loadError,
    }
  }

  const endpointFor = (providerId: string) => providerEndpoint(settings, secrets, providerId)

  ipcMain.handle(IPC_CHANNELS.settingsGet, () => view())

  ipcMain.handle(IPC_CHANNELS.preferencesSave, async (_event, raw: unknown) => {
    const change = parse(
      z.object({
        appearance: appearanceSchema.optional(),
        defaultPermissionMode: permissionModeSchema.optional(),
        security: securitySchema.optional(),
        execution: executionSchema.optional(),
      }),
      raw,
    )
    await settings.update((current) => ({ ...current, ...change }))
    return view()
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

  // 只保存当前类型用到的那组名字和值，另一组连同密钥一起删掉
  ipcMain.handle(IPC_CHANNELS.mcpSave, async (_event, raw: unknown) => {
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
    }
    await settings.update((current) => ({
      ...current,
      mcpServers: previous ? current.mcpServers.map((item) => (item.id === id ? server : item)) : [...current.mcpServers, server],
    }))
    const kept = new Set(mcpSecretKeys(server))
    for (const key of previous ? mcpSecretKeys(previous) : []) if (!kept.has(key)) await secrets.delete(key)
    return view()
  })

  ipcMain.handle(IPC_CHANNELS.mcpDelete, async (_event, raw: unknown) => {
    const id = parse(z.string().min(1), raw)
    const server = settings.get().mcpServers.find((item) => item.id === id)
    if (!server) return view()
    await settings.update((current) => ({ ...current, mcpServers: current.mcpServers.filter((item) => item.id !== id) }))
    for (const key of mcpSecretKeys(server)) await secrets.delete(key)
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

  ipcMain.handle(IPC_CHANNELS.modelsTest, async (_event, rawProviderId: unknown, rawModelId: unknown) => {
    const target = await endpointFor(parse(z.string().min(1), rawProviderId))
    if (!target.ok) return target
    return requestTestModel(await coreConnection(), target.endpoint, parse(z.string().min(1), rawModelId))
  })
}

function modelExists(settings: Settings, ref: ModelRef): boolean {
  return settings.providers.some(
    (provider) => provider.id === ref.providerId && provider.models.some((model) => model.id === ref.modelId),
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
