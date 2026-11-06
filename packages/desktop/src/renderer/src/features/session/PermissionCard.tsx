import { ShieldQuestion } from 'lucide-react'
import type { PermissionRequestEvent } from '../../../../shared/ipc'
import { Button } from '@/components/ui/button'

interface PermissionCardProps {
  request: PermissionRequestEvent
  onRespond(optionId: string | null): void
}

export function PermissionCard({ request, onRespond }: PermissionCardProps) {
  const command = commandOf(request.toolCall.rawInput)
  return (
    <div className="space-y-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-4 text-sm" data-testid="permission-card">
      <div className="flex items-center gap-2 font-medium">
        <ShieldQuestion className="size-4" />
        需要你确认才能执行
      </div>
      <pre className="overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
        {command ?? request.toolCall.title}
      </pre>
      <div className="flex flex-wrap gap-2">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            size="sm"
            variant={option.kind.startsWith('reject') ? 'outline' : 'default'}
            onClick={() => onRespond(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
      </div>
    </div>
  )
}

function commandOf(rawInput: unknown): string | null {
  return typeof rawInput === 'object' && rawInput !== null && 'command' in rawInput && typeof rawInput.command === 'string'
    ? rawInput.command
    : null
}
