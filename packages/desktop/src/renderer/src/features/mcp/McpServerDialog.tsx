import { type FormEvent, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { McpServerConfig, SettingsView } from '../../../../shared/settings'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Textarea } from '@/components/ui/textarea'
import { Field } from '@/components/ui/field'
import { errorMessage } from '@/lib/errors'

interface McpServerDialogProps {
  open: boolean
  // null 表示新建
  server: McpServerConfig | null
  onOpenChange(open: boolean): void
  onSaved(view: SettingsView): void
}

export function McpServerDialog({ open, server, onOpenChange, onSaved }: McpServerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{server ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</DialogTitle>
          <DialogDescription>环境变量和请求头的值加密保存在本机，保存后不再显示。</DialogDescription>
        </DialogHeader>
        {/* 表单每次打开重新挂载，状态从 server 重新初始化 */}
        <McpServerForm
          server={server}
          onSaved={(view) => {
            onSaved(view)
            onOpenChange(false)
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

// saved：已经存过值的名字，值留空表示不改；replacing：点了「更换」，显示输入框
interface ValueRow {
  key: string
  name: string
  value: string
  saved: boolean
  replacing: boolean
}

const rowsOf = (names: string[]): ValueRow[] => names.map((name) => ({ key: crypto.randomUUID(), name, value: '', saved: true, replacing: false }))

const TRANSPORT_OPTIONS: Array<{ value: McpServerConfig['transport']; label: string }> = [
  { value: 'stdio', label: '本地命令' },
  { value: 'http', label: '远程 HTTP' },
]

function McpServerForm({ server, onSaved, onCancel }: { server: McpServerConfig | null; onSaved(view: SettingsView): void; onCancel(): void }) {
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<McpServerConfig['transport']>(server?.transport ?? 'stdio')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(server?.args.join('\n') ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [env, setEnv] = useState<ValueRow[]>(rowsOf(server?.envNames ?? []))
  const [headers, setHeaders] = useState<ValueRow[]>(rowsOf(server?.headerNames ?? []))
  // 浏览器登录（OAuth，v2）：保存后在「已安装」里点登录；令牌加密存在本机，不用填请求头
  const [oauth, setOauth] = useState(server?.auth === 'oauth')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stdio = transport === 'stdio'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const rows = (stdio ? env : headers).filter((row) => row.name.trim() !== '' || row.value !== '')
    const unfilled = rows.find((row) => !row.saved && row.value === '')
    if (unfilled) {
      setError(`「${unfilled.name.trim() || '未命名'}」还没有填值`)
      return
    }
    const values = rows.map((row) => ({ name: row.name.trim(), value: row.saved && row.value === '' ? null : row.value }))
    setSaving(true)
    setError(null)
    try {
      onSaved(
        await window.diffra.saveMcpServer({
          id: server?.id,
          name: name.trim(),
          enabled: server?.enabled ?? true,
          transport,
          command: command.trim(),
          args: args
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== ''),
          url: url.trim(),
          env: stdio ? values : [],
          headers: stdio || oauth ? [] : values,
          ...(!stdio && oauth ? { auth: 'oauth' as const } : {}),
        }),
      )
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* 连接方式决定后面的字段，放在第一项 */}
      <div className="space-y-1.5">
        <Label>连接方式</Label>
        <Segmented label="连接方式" value={transport} options={TRANSPORT_OPTIONS} onChange={(value) => setTransport(value)} />
      </div>
      <Field id="mcp-name" label="名称" hint="只能用字母、数字、- 和 _，会显示在工具名前。">
        <Input id="mcp-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="github" required />
      </Field>
      {stdio ? (
        <>
          <Field id="mcp-command" label="命令" hint="在项目目录里运行，比如 npx、uvx、node。">
            <Input id="mcp-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" />
          </Field>
          <Field id="mcp-args" label="参数" hint="一行一个。">
            <Textarea
              id="mcp-args"
              rows={3}
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={'-y\n@modelcontextprotocol/server-github'}
              className="font-mono text-sm"
            />
          </Field>
          <ValueRows label="环境变量" namePlaceholder="GITHUB_TOKEN" rows={env} onChange={setEnv} />
        </>
      ) : (
        <>
          <Field id="mcp-url" label="地址">
            <Input id="mcp-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={oauth} onCheckedChange={(checked) => setOauth(checked === true)} aria-label="用浏览器登录（OAuth）" className="mt-0.5" />
            <span>
              用浏览器登录（OAuth）
              <span className="block text-xs text-muted-foreground">服务器要求在浏览器里登录账号时选这个。保存后在列表里点「在浏览器里登录」，令牌加密存在本机。</span>
            </span>
          </label>
          {!oauth && <ValueRows label="请求头" namePlaceholder="Authorization" rows={headers} onChange={setHeaders} />}
        </>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? '正在保存…' : '保存'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ValueRows({ label, namePlaceholder, rows, onChange }: { label: string; namePlaceholder: string; rows: ValueRow[]; onChange(rows: ValueRow[]): void }) {
  const update = (key: string, change: Partial<ValueRow>) => onChange(rows.map((row) => (row.key === key ? { ...row, ...change } : row)))
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2" data-testid="mcp-value-row">
          <Input
            aria-label={`${label}名称`}
            value={row.name}
            placeholder={namePlaceholder}
            className="w-44 font-mono text-sm"
            // 改了名字就是新的一项，要重新填值
            onChange={(event) => update(row.key, { name: event.target.value, saved: false })}
          />
          {row.saved && !row.replacing ? (
            // 已保存的值读不回来，只显示占位；点「更换」才出现输入框
            <>
              <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg bg-muted/60 px-2.5 text-sm text-muted-foreground">•••••• 已保存</div>
              <Button type="button" size="sm" variant="ghost" aria-label={`更换${label} ${row.name} 的值`} onClick={() => update(row.key, { replacing: true })}>
                更换
              </Button>
            </>
          ) : (
            <Input
              aria-label={`${label}的值`}
              type="password"
              value={row.value}
              placeholder={row.saved ? '新的值，留空则不改' : '值'}
              className="flex-1"
              autoFocus={row.replacing}
              onChange={(event) => update(row.key, { value: event.target.value })}
            />
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`删除${label} ${row.name}`}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" onClick={() => onChange([...rows, { key: crypto.randomUUID(), name: '', value: '', saved: false, replacing: false }])}>
        <Plus className="size-3.5" />
        添加{label}
      </Button>
    </div>
  )
}
