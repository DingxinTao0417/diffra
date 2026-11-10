import { useMemo, useState } from 'react'
import type { PromptQuestion } from '@diffra/core/types'
import { LoaderCircle, PenTool, Search, WandSparkles } from 'lucide-react'
import type { Todo } from '../../../../shared/todos'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Segmented } from '@/components/ui/segmented'
import { errorMessage } from '@/lib/errors'
import { folderName, formatTime } from '@/lib/format'
import { formatDue } from '@/lib/todo-time'
import { dispatchTodos, setTodoSchedule } from '@/state/actions'
import { showToast, useAppState } from '@/state/store'
import { QuestionBar } from '../task/QuestionBar'

const NO_PROJECT = '__none__'
const MAX_LISTED_TASKS = 50

// 几条待办合成一条消息；一条就原样发
export function todosMessage(todos: Todo[]): string {
  if (todos.length === 1) return todos[0]!.text
  return ['请完成下面几件事：', ...todos.map((todo) => `- ${todo.text.replace(/\n+/g, ' ')}`)].join('\n')
}

// 把待办派给任务：新任务（选项目、普通或设计）或已有任务（可搜索）。发之前能改、能优化提示词。
// scheduleAt 有值时是定时发送：只有一条待办，存成它的定时，到时由定时器在后台发
export function SendTodosDialog({ todos, scheduleAt, onClose }: { todos: Todo[]; scheduleAt?: Date; onClose(sent: boolean): void }) {
  const projects = useAppState((state) => state.projects)
  const tasks = useAppState((state) => state.tasks)
  // 改已有的定时发送时，从原来定好的对象和内容开始
  const planned = scheduleAt && todos[0]?.schedule?.action.kind === 'send' ? todos[0].schedule.action : null
  const [kind, setKind] = useState<'new' | 'existing'>(planned?.target.kind ?? 'new')
  const [project, setProject] = useState((planned?.target.kind === 'new' ? planned.target.project : todos[0]?.project) ?? projects[0] ?? NO_PROJECT)
  const [design, setDesign] = useState(planned?.target.kind === 'new' && planned.target.design)
  const [query, setQuery] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(planned?.target.kind === 'existing' ? planned.target.sessionId : null)
  const [text, setText] = useState(() => planned?.text ?? todosMessage(todos))
  const [original, setOriginal] = useState<string | null>(null)
  const [questions, setQuestions] = useState<{ key: number; items: PromptQuestion[] }>({ key: 0, items: [] })
  const [enhancing, setEnhancing] = useState(false)
  const [busy, setBusy] = useState(false)

  const candidates = useMemo(() => {
    const words = query.trim().toLowerCase()
    return tasks
      .filter((task) => !task.archived && (!words || task.title.toLowerCase().includes(words) || task.cwd.toLowerCase().includes(words)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_LISTED_TASKS)
  }, [tasks, query])
  const target = kind === 'existing' ? tasks.find((task) => task.sessionId === sessionId) : undefined
  const ready = text.trim() !== '' && (kind === 'new' || target !== undefined)

  const enhance = async () => {
    setEnhancing(true)
    try {
      const result = await window.diffra.enhancePrompt({
        text,
        project: kind === 'new' ? (project === NO_PROJECT ? null : project) : (target?.cwd ?? null),
        sessionId: target?.sessionId ?? null,
        mentions: [],
        design: kind === 'new' ? design : (target?.design ?? false),
      })
      setOriginal((current) => current ?? text)
      setText(result.prompt)
      setQuestions((current) => ({ key: current.key + 1, items: result.questions }))
    } catch (error) {
      showToast(`优化失败：${errorMessage(error)}`)
    } finally {
      setEnhancing(false)
    }
  }

  const send = async (mode: 'send' | 'fill') => {
    if (!ready) return
    if (scheduleAt && todos[0]) {
      const sendTarget = kind === 'new' ? { kind: 'new' as const, project: project === NO_PROJECT ? null : project, design } : target ? { kind: 'existing' as const, sessionId: target.sessionId, cwd: target.cwd, title: target.title } : null
      if (!sendTarget) return
      await setTodoSchedule(todos[0].id, { at: scheduleAt.toISOString(), action: { kind: 'send', text: text.trim(), target: sendTarget }, result: null })
      onClose(true)
      return
    }
    setBusy(true)
    try {
      const ids = todos.map((todo) => todo.id)
      if (kind === 'new') await dispatchTodos(ids, text.trim(), { kind: 'new', project: project === NO_PROJECT ? null : project, design })
      else if (target) await dispatchTodos(ids, text.trim(), { kind: 'existing', sessionId: target.sessionId, cwd: target.cwd, mode })
      onClose(true)
    } catch (error) {
      showToast(`发送失败：${errorMessage(error)}`)
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose(false)}>
      <DialogContent className="sm:max-w-2xl" data-testid="send-todos">
        <DialogHeader>
          <DialogTitle>{scheduleAt ? '定时发给任务' : todos.length > 1 ? `把 ${todos.length} 条待办派给任务` : '把待办派给任务'}</DialogTitle>
          <DialogDescription>
            {scheduleAt ? `${formatDue(scheduleAt.toISOString(), new Date())} 在后台发出，Diffra 那时要开着。` : ''}发之前可以改，也可以先优化成更具体的说法。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Segmented<'new' | 'existing'>
            label="发给谁"
            value={kind}
            options={[
              { value: 'new', label: '新任务' },
              { value: 'existing', label: '已有任务' },
            ]}
            onChange={setKind}
          />
          {kind === 'new' ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="todo-project" className="text-muted-foreground">
                项目
              </label>
              <select id="todo-project" value={project} onChange={(event) => setProject(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2">
                {[...new Set([...(todos[0]?.project ? [todos[0].project] : []), ...projects])].map((path) => (
                  <option key={path} value={path}>
                    {folderName(path)}
                  </option>
                ))}
                <option value={NO_PROJECT}>无项目</option>
              </select>
              <button
                type="button"
                aria-pressed={design}
                className="flex items-center gap-1 rounded-md border px-2 py-1 text-muted-foreground hover:bg-accent aria-pressed:border-foreground/30 aria-pressed:bg-soft aria-pressed:text-foreground"
                onClick={() => setDesign(!design)}
              >
                <PenTool className="size-3.5" />
                设计任务
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 rounded-md border px-2">
                <Search className="size-3.5 text-muted-foreground" />
                <input aria-label="搜索任务" value={query} placeholder="按标题或项目搜索" className="h-8 flex-1 bg-transparent text-sm outline-none" onChange={(event) => setQuery(event.target.value)} />
              </div>
              {/* 最多露 5 行（每行 2rem），多的滚动 */}
              <div className="max-h-[calc(5*2rem+2px)] overflow-y-auto rounded-md border" role="listbox" aria-label="任务">
                {candidates.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">没有找到任务</p>}
                {candidates.map((task) => (
                  <button
                    key={task.sessionId}
                    type="button"
                    role="option"
                    aria-selected={task.sessionId === sessionId}
                    className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent', task.sessionId === sessionId && 'bg-soft hover:bg-soft')}
                    onClick={() => setSessionId(task.sessionId)}
                  >
                    {task.design && <PenTool className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{task.title || '未命名任务'}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {task.noProject ? '无项目' : folderName(task.cwd)} · {formatTime(task.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <QuestionBar key={questions.key} questions={questions.items} text={text} onChange={setText} />
          <textarea
            aria-label="要发的内容"
            value={text}
            rows={Math.min(12, Math.max(4, text.split('\n').length + 1))}
            onChange={(event) => setText(event.target.value)}
            className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-ring/60"
          />
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-1">
            <Button variant="ghost" disabled={enhancing || text.trim() === ''} onClick={() => void enhance()}>
              {enhancing ? <LoaderCircle className="size-4 animate-spin" /> : <WandSparkles className="size-4" />}
              优化
            </Button>
            {original !== null && (
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => {
                  setText(original)
                  setOriginal(null)
                  setQuestions((current) => ({ ...current, items: [] }))
                }}
              >
                撤销优化
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {kind === 'existing' && !scheduleAt && (
              <Button variant="outline" disabled={!ready || busy} onClick={() => void send('fill')}>
                只填入输入框
              </Button>
            )}
            <Button disabled={!ready || busy} onClick={() => void send('send')}>
              {scheduleAt ? '定时发送' : '发送'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
