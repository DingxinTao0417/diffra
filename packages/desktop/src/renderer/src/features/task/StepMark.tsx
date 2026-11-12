import type { StepStatus } from '@diffra/core/types'
import { Check, ChevronRight } from 'lucide-react'

// 步骤清单里一步前面的记号，对话里的步骤卡和任务监控共用：做完打勾、正在做是箭头、没做是空心圆
export function StepMark({ status }: { status: StepStatus }) {
  if (status === 'completed') return <Check className="mt-1 size-3.5 shrink-0 text-muted-foreground" strokeWidth={2.6} />
  if (status === 'in_progress') return <ChevronRight className="mt-1 size-3.5 shrink-0 text-foreground" strokeWidth={2.6} />
  return <span className="mx-0.5 mt-1.5 size-2.5 shrink-0 rounded-full border border-muted-foreground/50" />
}
