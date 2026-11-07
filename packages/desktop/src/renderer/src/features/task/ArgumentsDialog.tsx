import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Field } from '@/features/models/ProviderDialog'

export interface ArgumentsRequest {
  title: string
  description: string
  arguments: Array<{ name: string; label: string; hint: string; required: boolean }>
}

// 斜杠菜单里有参数的 MCP prompt 和自定义命令：先填参数，再展开成文字放进输入框，看过再发
export function ArgumentsDialog({
  request,
  onCancel,
  onSubmit,
}: {
  request: ArgumentsRequest | null
  onCancel(): void
  onSubmit(args: Record<string, string>): void
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>{request?.description || '填好参数后放进输入框，看过再发送。'}</DialogDescription>
        </DialogHeader>
        {request && <ArgumentsForm request={request} onCancel={onCancel} onSubmit={onSubmit} />}
      </DialogContent>
    </Dialog>
  )
}

function ArgumentsForm({ request, onCancel, onSubmit }: { request: ArgumentsRequest; onCancel(): void; onSubmit(args: Record<string, string>): void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const submit = (event: FormEvent) => {
    event.preventDefault()
    // 没填的可选参数不传
    onSubmit(Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== '')))
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      {request.arguments.map((arg, index) => (
        <Field key={arg.name} id={`argument-${arg.name}`} label={arg.required ? `${arg.label}（必填）` : arg.label} hint={arg.hint || undefined}>
          <Input
            id={`argument-${arg.name}`}
            autoFocus={index === 0}
            required={arg.required}
            value={values[arg.name] ?? ''}
            onChange={(event) => setValues((current) => ({ ...current, [arg.name]: event.target.value }))}
          />
        </Field>
      ))}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit">放进输入框</Button>
      </DialogFooter>
    </form>
  )
}
