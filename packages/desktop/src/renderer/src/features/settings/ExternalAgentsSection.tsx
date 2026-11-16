import { useEffect, useState } from 'react'
import type { ExternalAgentDetection } from '@diffra/core/types'
import { Bot, LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import {
  detectionAdvice,
  EXTERNAL_AGENT_PRESETS,
  EXTERNAL_DETECTION_KIND_LABELS,
  type ExternalAgentConfig,
  type ExternalAgentDiscovery,
  type ExternalAgentInput,
  externalAgentPreset,
} from '../../../../shared/external-agents'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage } from '@/lib/errors'
import { showToast, store, useAppState } from '@/state/store'
import { SettingsGroup, SettingsHeader, SettingsRow } from './SettingsLayout'

const NO_AGENTS: ExternalAgentConfig[] = []

// 表单：参数一行一个，环境变量的值不回显，留空表示沿用已保存的
interface Draft {
  id?: string
  presetId: string | null
  name: string
  command: string
  args: string
  env: Array<{ name: string; value: string; saved: boolean }>
}

const toInput = (draft: Draft): ExternalAgentInput => ({
  ...(draft.id ? { id: draft.id } : {}),
  presetId: draft.presetId,
  name: draft.name.trim(),
  command: draft.command.trim(),
  args: draft.args.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  env: draft.env.filter((item) => item.name.trim()).map((item) => ({ name: item.name.trim(), value: item.value === '' && item.saved ? null : item.value })),
})

type Detection = { state: 'running' } | { state: 'done'; result: ExternalAgentDetection }

// 外接智能体：添加、检测、编辑、删除。账号登录由各 CLI 自己在终端里做，这里只给指引
export function ExternalAgentsSection() {
  const agents = useAppState((state) => state.settings?.externalAgents ?? NO_AGENTS)
  const [discovery, setDiscovery] = useState<ExternalAgentDiscovery[] | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [detections, setDetections] = useState<Record<string, Detection>>({})
  const [deleting, setDeleting] = useState<ExternalAgentConfig | null>(null)

  const discover = async () => {
    setDiscovering(true)
    try {
      setDiscovery(await window.diffra.discoverExternalAgents())
    } catch (error) {
      showToast(`查找本机命令失败：${errorMessage(error)}`)
    } finally {
      setDiscovering(false)
    }
  }
  useEffect(() => void discover(), [])

  const detect = async (key: string, input: ExternalAgentInput) => {
    setDetections((current) => ({ ...current, [key]: { state: 'running' } }))
    try {
      const result = await window.diffra.detectExternalAgent(input)
      setDetections((current) => ({ ...current, [key]: { state: 'done', result } }))
    } catch (error) {
      setDetections((current) => ({ ...current, [key]: { state: 'done', result: { ok: false, kind: 'start-failed', message: errorMessage(error), detail: null } } }))
    }
  }

  const save = async () => {
    if (!draft) return
    try {
      const settings = await window.diffra.saveExternalAgent(toInput(draft))
      store.set((state) => ({ ...state, settings }))
      setDraft(null)
    } catch (error) {
      showToast(`保存失败：${errorMessage(error)}`)
    }
  }

  const remove = async (agent: ExternalAgentConfig) => {
    try {
      const settings = await window.diffra.deleteExternalAgent(agent.id)
      store.set((state) => ({ ...state, settings }))
    } catch (error) {
      showToast(`删除失败：${errorMessage(error)}`)
    }
  }

  const startAdd = (presetId: string | null) => {
    const preset = externalAgentPreset(presetId)
    const found = discovery?.find((item) => item.presetId === presetId)
    const launch = found?.launch ?? preset?.launch.at(-1) ?? { command: '', args: [] }
    setDraft({ presetId, name: preset?.name ?? '', command: launch.command, args: launch.args.join('\n'), env: [] })
  }

  const startEdit = (agent: ExternalAgentConfig) =>
    setDraft({ id: agent.id, presetId: agent.presetId, name: agent.name, command: agent.command, args: agent.args.join('\n'), env: agent.envNames.map((name) => ({ name, value: '', saved: true })) })

  const added = new Set(agents.map((agent) => agent.presetId).filter(Boolean))

  return (
    <>
      <SettingsHeader
        title="外接智能体"
        description="让 Claude Code、Codex、Gemini CLI、Copilot CLI 来跑任务。它们用自己的模型和账号，在终端里登录过就能用；Diffra 只负责起进程、显示过程、请你确认，不经手它们的账号。"
      />
      <SettingsGroup title="已添加" data-testid="external-agents">
        {agents.length === 0 && <EmptyState variant="plain" icon={Bot} title="还没有添加外接智能体" description="从下面选一个添加，或者自定义启动命令。添加后新建任务时在模型菜单里选它。" />}
        {agents.map((agent) => {
          const preset = externalAgentPreset(agent.presetId)
          const detection = detections[agent.id]
          return (
            <div key={agent.id} className="px-4 py-3" data-testid="external-agent-row">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-base">
                    <span className="truncate">{agent.name}</span>
                    {!preset && <Badge variant="outline">自定义</Badge>}
                    {detection && <DetectionBadge detection={detection} />}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={[agent.command, ...agent.args].join(' ')}>
                    {[agent.command, ...agent.args].join(' ')}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={detection?.state === 'running'}
                  onClick={() => void detect(agent.id, { id: agent.id, presetId: agent.presetId, name: agent.name, command: agent.command, args: agent.args, env: agent.envNames.map((name) => ({ name, value: null })) })}
                >
                  检测
                </Button>
                <Button variant="outline" size="sm" onClick={() => startEdit(agent)}>
                  编辑
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(agent)}>
                  删除
                </Button>
              </div>
              {detection?.state === 'done' && <DetectionResult result={detection.result} presetId={agent.presetId} />}
              {draft?.id === agent.id && <AgentForm draft={draft} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} detection={detections[`draft:${agent.id}`]} onDetect={() => void detect(`draft:${agent.id}`, toInput(draft))} />}
            </div>
          )
        })}
      </SettingsGroup>

      <SettingsGroup
        title="添加"
        data-testid="external-agent-presets"
      >
        <div className="flex items-center justify-end px-4 pt-2">
          <Button variant="ghost" size="sm" disabled={discovering} onClick={() => void discover()}>
            {discovering ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            重新查找
          </Button>
        </div>
        {EXTERNAL_AGENT_PRESETS.map((preset) => {
          const found = discovery?.find((item) => item.presetId === preset.id)
          return (
            <div key={preset.id} className="px-4 py-3" data-testid="external-agent-preset">
              <SettingsRow
                className="px-0 py-0"
                label={
                  <span className="flex items-center gap-2">
                    {preset.name}
                    {discovery === null ? null : found?.cliPath ? <Badge variant="secondary">已装</Badge> : <Badge variant="outline">没找到 {preset.cli}</Badge>}
                    {added.has(preset.id) && <Badge variant="outline">已添加</Badge>}
                  </span>
                }
                hint={
                  found?.cliPath ? (
                    <>
                      {found.cliPath} · 启动：{[found.launch.command, ...found.launch.args].join(' ')}
                      {found.launch.command !== preset.cli && (found.launchPath ? '（本机装好的适配器）' : '（第一次会先下载适配器）')}
                      <br />
                      没登录的话：{preset.login}
                    </>
                  ) : (
                    <>
                      安装：<code className="font-mono">{preset.install}</code>，然后{preset.login}。
                      <br />
                      {preset.note}
                    </>
                  )
                }
              >
                <Button variant="ghost" size="sm" onClick={() => void window.diffra.openExternal(preset.docs).catch((error: unknown) => showToast(errorMessage(error)))}>
                  说明
                </Button>
                <Button variant="outline" size="sm" disabled={draft !== null && !draft.id && draft.presetId === preset.id} onClick={() => startAdd(preset.id)}>
                  <Plus className="size-3.5" />
                  添加
                </Button>
              </SettingsRow>
              {draft && !draft.id && draft.presetId === preset.id && (
                <AgentForm draft={draft} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} detection={detections[`new:${preset.id}`]} onDetect={() => void detect(`new:${preset.id}`, toInput(draft))} />
              )}
            </div>
          )
        })}
        <div className="px-4 py-3">
          <SettingsRow className="px-0 py-0" label="自定义" hint="其他支持 ACP（Agent Client Protocol）的命令行智能体：填它的启动命令和参数。">
            <Button variant="outline" size="sm" disabled={draft !== null && !draft.id && draft.presetId === null} onClick={() => startAdd(null)}>
              <Plus className="size-3.5" />
              添加
            </Button>
          </SettingsRow>
          {draft && !draft.id && draft.presetId === null && (
            <AgentForm draft={draft} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} detection={detections['new:custom']} onDetect={() => void detect('new:custom', toInput(draft))} />
          )}
        </div>
      </SettingsGroup>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>用它做的任务还在，能打开看记录；要接着做得先把它加回来。它在终端里的登录不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive-solid" onClick={() => deleting && void remove(deleting)}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function DetectionBadge({ detection }: { detection: Detection }) {
  if (detection.state === 'running')
    return (
      <Badge variant="outline">
        <LoaderCircle className="animate-spin" />
        检测中
      </Badge>
    )
  const { result } = detection
  if (result.ok) return <Badge variant="secondary">可用{result.agentVersion ? ` · ${result.agentVersion}` : ''}</Badge>
  return <Badge variant={result.kind === 'auth' ? 'warning' : 'destructive'}>{EXTERNAL_DETECTION_KIND_LABELS[result.kind]}</Badge>
}

function DetectionResult({ result, presetId }: { result: ExternalAgentDetection; presetId: string | null }) {
  if (result.ok) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-testid="external-detection">
        已连上{result.agentName ? `「${result.agentName}」` : ''}：{result.path}
        {result.loadSession ? '，能接着原来的对话' : '，不支持接着原来的对话（重开任务后它看不到之前的上下文）'}
        {result.images ? '' : '，不收图片'}。
      </p>
    )
  }
  const advice = detectionAdvice(result, externalAgentPreset(presetId))
  return (
    <div className="mt-2 space-y-1 text-xs" data-testid="external-detection">
      <p className="text-destructive">{result.message}</p>
      {advice && <p className="text-muted-foreground">下一步：{advice}</p>}
      {result.detail && <pre className="max-h-32 overflow-auto rounded-md bg-muted/60 p-2 font-mono break-all whitespace-pre-wrap text-muted-foreground">{result.detail}</pre>}
    </div>
  )
}

function AgentForm({
  draft,
  onChange,
  onSave,
  onCancel,
  detection,
  onDetect,
}: {
  draft: Draft
  onChange(draft: Draft): void
  onSave(): Promise<void>
  onCancel(): void
  detection: Detection | undefined
  onDetect(): void
}) {
  const [saving, setSaving] = useState(false)
  const key = draft.id ?? draft.presetId ?? 'custom'
  const valid = draft.name.trim() !== '' && draft.command.trim() !== ''
  return (
    <form
      className="mt-3 space-y-3 rounded-lg border bg-background p-3"
      aria-label={draft.id ? `编辑 ${draft.name}` : '添加外接智能体'}
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid) return
        setSaving(true)
        void onSave().finally(() => setSaving(false))
      }}
    >
      <Field id={`external-name-${key}`} label="名称">
        <Input id={`external-name-${key}`} value={draft.name} maxLength={60} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      </Field>
      <Field id={`external-command-${key}`} label="启动命令" hint="命令名（在 PATH 和常见安装位置里找）或可执行文件的完整路径。">
        <Input id={`external-command-${key}`} className="font-mono" value={draft.command} onChange={(event) => onChange({ ...draft, command: event.target.value })} />
      </Field>
      <Field id={`external-args-${key}`} label="参数" hint="一行一个。">
        <Textarea id={`external-args-${key}`} className="min-h-16 font-mono" value={draft.args} onChange={(event) => onChange({ ...draft, args: event.target.value })} />
      </Field>
      <div className="space-y-1.5">
        <div className="text-sm">环境变量</div>
        <p className="text-xs text-muted-foreground">值可能是密钥，加密保存，保存后不再显示；留空表示不改。账号登录请在终端里完成，不用填在这里。</p>
        {draft.env.map((item, index) => (
          <div key={index} className="flex gap-2">
            <Input aria-label="变量名" placeholder="名字" className="w-48 font-mono" value={item.name} onChange={(event) => onChange({ ...draft, env: draft.env.map((entry, position) => (position === index ? { ...entry, name: event.target.value } : entry)) })} />
            <Input
              aria-label={`${item.name || '变量'} 的值`}
              type="password"
              placeholder={item.saved ? '已保存，留空不改' : '值'}
              className="min-w-0 flex-1"
              value={item.value}
              onChange={(event) => onChange({ ...draft, env: draft.env.map((entry, position) => (position === index ? { ...entry, value: event.target.value } : entry)) })}
            />
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...draft, env: draft.env.filter((_, position) => position !== index) })}>
              移除
            </Button>
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...draft, env: [...draft.env, { name: '', value: '', saved: false }] })}>
          <Plus className="size-3.5" />
          添加环境变量
        </Button>
      </div>
      {detection && (
        <div className="flex items-center gap-2">
          <DetectionBadge detection={detection} />
        </div>
      )}
      {detection?.state === 'done' && <DetectionResult result={detection.result} presetId={draft.presetId} />}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!valid || detection?.state === 'running'} onClick={onDetect}>
          {detection?.state === 'running' && <LoaderCircle className="size-3.5 animate-spin" />}
          检测
        </Button>
        <Button type="submit" size="sm" disabled={!valid || saving}>
          保存
        </Button>
      </div>
    </form>
  )
}
