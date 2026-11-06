import { randomUUID } from 'node:crypto'
import { type ModelEndpoint, type ModelError, requestListModels, requestTestModel } from '@diffra/core'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS } from '../shared/ipc'
import { type ModelRef, ROLES, type Settings, type SettingsView } from '../shared/settings'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import type { SecretStore } from './secret-store'
import { modelRefSchema, providerFieldsSchema, type SettingsStore } from './settings-store'

const providerInputSchema = providerFieldsSchema.extend({
  id: z.string().min(1).optional(),
  apiKey: z.string().trim().optional(),
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
    const { providers, roles } = settings.get()
    return {
      providers: await Promise.all(
        providers.map(async (provider) => ({ ...provider, keyHint: await secrets.hint(provider.id) })),
      ),
      roles,
      loadError: settings.loadError ?? secrets.loadError,
    }
  }

  const endpointFor = (providerId: string) => providerEndpoint(settings, secrets, providerId)

  ipcMain.handle(IPC_CHANNELS.settingsGet, () => view())

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
