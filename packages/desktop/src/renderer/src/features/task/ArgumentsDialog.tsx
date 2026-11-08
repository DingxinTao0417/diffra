import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

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
          <DialogTitle className="font-mono">{request?.title}</DialogTitle>
          <DialogDescription>{request?.description || '参数会填入输入框，发送前可以再修改。'}</DialogDescription>
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
    <form onSubmit={submit} className="flex min-h-0 flex-col gap-4">
      {/* 滚动区会裁掉贴边控件的焦点环，上下留 4px 再用负边距抵消 */}
      <DialogBody className="space-y-4">
        {request.arguments.map((arg, index) => {
          const id = `argument-${arg.name}`
          return (
            <div key={arg.name} className="space-y-1.5">
              <Label htmlFor={id}>
                <span>
                  {arg.label}
                  {/* 必填的语义由 input 的 required 传达，星号只给眼睛看 */}
                  {arg.required && (
                    <span aria-hidden="true" className="ml-0.5 text-destructive">
                      *
                    </span>
                  )}
                </span>
              </Label>
              <Input
                id={id}
                autoFocus={index === 0}
                required={arg.required}
                aria-describedby={arg.hint ? `${id}-hint` : undefined}
                value={values[arg.name] ?? ''}
                onChange={(event) => setValues((current) => ({ ...current, [arg.name]: event.target.value }))}
              />
              {arg.hint && (
                <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                  {arg.hint}
                </p>
              )}
            </div>
          )
        })}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit">放进输入框</Button>
      </DialogFooter>
    </form>
  )
}
