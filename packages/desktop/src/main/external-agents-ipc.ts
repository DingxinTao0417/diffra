import { randomUUID } from 'node:crypto'
import { detectExternalAgent, type ExternalAgentSpec, locateCommand, setExternalAgents } from '@diffra/core'
import { ipcMain } from 'electron'
import { z } from 'zod'
import { EXTERNAL_AGENT_PRESETS, type ExternalAgentConfig, type ExternalAgentDiscovery, type ExternalAgentInput } from '../shared/external-agents'
import { IPC_CHANNELS } from '../shared/ipc'
import { coreConnection } from './core-process'
import { parse } from './ipc-input'
import type { SecretStore } from './secret-store'
import { settingsView } from './settings-ipc'
import { ENV_NAME_PATTERN, type SettingsStore } from './settings-store'

// 环境变量的值存在密钥库里，按智能体 id 和名字分开
export function externalSecretKey(agentId: string, name: string): string {
  return `external:${agentId}:env:${name}`
}

const inputSchema = z
  .object({
    id: z.string().min(1).max(100).optional(),
    presetId: z.string().min(1).nullable(),
    name: z.string().trim().min(1, '名称不能为空').max(60, '名称太长'),
    command: z.string().trim().min(1, '启动命令不能为空').max(1000),
    args: z.array(z.string().max(2000)).max(50),
    env: z.array(z.object({ name: z.string().regex(ENV_NAME_PATTERN, '环境变量名只能用字母、数字和 _，不能以数字开头'), value: z.string().max(10_000).nullable() })).max(50),
  })
  .refine((input) => new Set(input.env.map((item) => item.name)).size === input.env.length, '环境变量名重复')

// 设置里的一项连同密钥库里的值，交给 core 起进程用；值读不出来时传空，由它自己报错
async function specOf(agent: ExternalAgentConfig, secrets: SecretStore): Promise<ExternalAgentSpec> {
  const env = await Promise.all(
    agent.envNames.map(async (name) => {
      const value = await secrets.get(externalSecretKey(agent.id, name)).catch((error: unknown) => {
        console.error(`[external] 读取 ${agent.name} 的 ${name} 失败`, error)
        return null
      })
      return { name, value: value ?? '' }
    }),
  )
  return { id: agent.id, name: agent.name, command: agent.command, args: agent.args, env }
}

// 设置里的外接智能体清单交给 core：启动时和改了之后各发一次，失败只记日志（建任务时会报找不到这个智能体）
export async function syncExternalAgents(settings: SettingsStore, secrets: SecretStore): Promise<void> {
  try {
    const specs = await Promise.all(settings.get().externalAgents.map((agent) => specOf(agent, secrets)))
    await setExternalAgents(await coreConnection(), specs)
  } catch (error) {
    console.error('[external] 同步外接智能体到 core 失败', error)
  }
}

export function registerExternalAgentsIpc(settings: SettingsStore, secrets: SecretStore): void {
  const view = () => settingsView(settings, secrets)

  // 预设要的命令在本机找没找到（PATH 加常见安装位置）；不运行它们
  ipcMain.handle(IPC_CHANNELS.externalAgentDiscover, async (): Promise<ExternalAgentDiscovery[]> =>
    Promise.all(
      EXTERNAL_AGENT_PRESETS.map(async (preset) => {
        const cliPath = await locateCommand(preset.cli)
        for (const launch of preset.launch) {
          const launchPath = await locateCommand(launch.command)
          if (launchPath) return { presetId: preset.id, cliPath, launch, launchPath }
        }
        return { presetId: preset.id, cliPath, launch: preset.launch.at(-1)!, launchPath: null }
      }),
    ),
  )

  ipcMain.handle(IPC_CHANNELS.externalAgentSave, async (_event, raw: unknown) => {
    const input = parse(inputSchema, raw)
    const agents = settings.get().externalAgents
    const previous = input.id ? agents.find((agent) => agent.id === input.id) : undefined
    if (input.id && !previous) throw new Error('这个外接智能体已经不在了')
    if (agents.some((agent) => agent.id !== input.id && agent.name.toLowerCase() === input.name.toLowerCase())) throw new Error(`已经有名为「${input.name}」的外接智能体`)
    const missing = input.env.find((item) => item.value === null && !previous?.envNames.includes(item.name))
    if (missing) throw new Error(`「${missing.name}」还没有填值`)
    const id = previous?.id ?? randomUUID()
    // 先存密钥：加密失败时整个保存都不生效
    for (const item of input.env) if (item.value !== null) await secrets.set(externalSecretKey(id, item.name), item.value)
    const agent: ExternalAgentConfig = { id, presetId: input.presetId, name: input.name, command: input.command, args: input.args, envNames: input.env.map((item) => item.name) }
    await settings.update((current) => ({
      ...current,
      externalAgents: previous ? current.externalAgents.map((item) => (item.id === id ? agent : item)) : [...current.externalAgents, agent],
    }))
    for (const name of previous?.envNames ?? []) if (!agent.envNames.includes(name)) await secrets.delete(externalSecretKey(id, name))
    await syncExternalAgents(settings, secrets)
    return view()
  })

  // 删掉以后旧任务照样能打开看，发消息时说明智能体不在了
  ipcMain.handle(IPC_CHANNELS.externalAgentDelete, async (_event, raw: unknown) => {
    const id = parse(z.string().min(1), raw)
    const agent = settings.get().externalAgents.find((item) => item.id === id)
    if (!agent) return view()
    await settings.update((current) => ({ ...current, externalAgents: current.externalAgents.filter((item) => item.id !== id) }))
    for (const name of agent.envNames) await secrets.delete(externalSecretKey(id, name))
    await syncExternalAgents(settings, secrets)
    return view()
  })

  // 检测表单里的这一份（还没保存的也行）：值留空的环境变量用已保存的
  ipcMain.handle(IPC_CHANNELS.externalAgentDetect, async (_event, raw: unknown) => {
    const input: ExternalAgentInput = parse(inputSchema, raw)
    const saved = input.id ? settings.get().externalAgents.find((agent) => agent.id === input.id) : undefined
    const env = await Promise.all(
      input.env.map(async (item) => ({ name: item.name, value: item.value ?? (saved ? ((await secrets.get(externalSecretKey(saved.id, item.name)).catch(() => null)) ?? '') : '') })),
    )
    return detectExternalAgent(await coreConnection(), { id: input.id ?? 'detect', name: input.name, command: input.command, args: input.args, env })
  })
}
