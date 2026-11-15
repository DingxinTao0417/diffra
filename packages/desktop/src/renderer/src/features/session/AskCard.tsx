import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, CircleHelp, FolderOpen, Plus, X } from 'lucide-react'
import { cn } from 'cn'
import { ASK_USER_OPTION_PREFIX, ASK_USER_SKIP, ASK_USER_SUBMIT, type AskAnswer, type AskQuestion, type AskUserInput } from '@diffra/core/types'
import type { PermissionRequestEvent, ProjectFile } from '../../../../shared/ipc'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { imageUrl } from '@/lib/images'
import { showToast } from '@/state/store'

interface AskCardProps {
  request: PermissionRequestEvent
  input: AskUserInput
  // 本机任务的项目目录：选文件用系统选择框；远程任务是 null，只能输入路径（对方的 core 校验）
  project: string | null
  onRespond(optionId: string | null, answers?: AskAnswer[]): void
}

// 智能体中途的提问（ask_user，第 673 步起）：几个问题分成选项卡，每个是选择（单选、多选，选项可以带预览图）、滑块或选文件。
// 只有一个单选问题时点选项就是回答；其余填好后提交，答案交给 core 逐个校验
export function AskCard({ request, input, project, onRespond }: AskCardProps) {
  const quick = request.options.some((option) => option.optionId.startsWith(ASK_USER_OPTION_PREFIX))
  const [tab, setTab] = useState(0)
  const [answers, setAnswers] = useState<Array<AskAnswer | null>>(() => input.questions.map(initialAnswer))
  const remaining = answers.filter((answer) => answer === null).length
  const cardRef = useRef<HTMLDivElement>(null)
  const question = input.questions[tab]!

  useEffect(() => {
    // 用户正在输入框里打字时不抢焦点
    const active = document.activeElement
    if (active instanceof HTMLElement && (active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return
    cardRef.current?.querySelector<HTMLElement>('[data-ask-first]')?.focus()
  }, [request.requestId])

  const answer = (index: number, value: AskAnswer | null) => setAnswers((current) => current.map((item, position) => (position === index ? value : item)))
  const submit = () => {
    if (remaining === 0) onRespond(ASK_USER_SUBMIT, answers as AskAnswer[])
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onRespond(ASK_USER_SKIP)
      return
    }
    const target = event.target as HTMLElement
    if (event.key === 'Enter' && !quick && !['BUTTON', 'INPUT', 'TEXTAREA'].includes(target.tagName)) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div ref={cardRef} className="space-y-3 rounded-xl border bg-card p-4 text-sm outline-none" data-testid="permission-card" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 font-bold">
        <CircleHelp className="size-4 text-muted-foreground" />
        智能体想先问你一下
      </div>
      <div className="space-y-3" data-testid="ask-user">
        {input.questions.length > 1 && <QuestionTabs questions={input.questions} answers={answers} tab={tab} onTab={setTab} />}
        <QuestionView
          key={tab}
          question={question}
          answer={answers[tab] ?? null}
          project={project}
          quick={quick}
          labelledBy={input.questions.length > 1 ? `ask-tab-${tab}` : undefined}
          onAnswer={(value) => {
            answer(tab, value)
            // 单选选好了跳到下一个还没答的问题
            if (question.type === 'choice' && !question.multiSelect && value) {
              const next = answers.findIndex((item, index) => index !== tab && item === null)
              if (next >= 0) setTab(next)
            }
          }}
          onPick={(index) => onRespond(`${ASK_USER_OPTION_PREFIX}${index}`)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!quick && (
          <Button disabled={remaining > 0} onClick={submit} data-testid="ask-submit">
            提交
          </Button>
        )}
        {!quick && remaining > 0 && input.questions.length > 1 && <span className="text-xs text-muted-foreground">还有 {remaining} 个没答</span>}
        <Button variant="ghost" className="ml-auto" onClick={() => onRespond(ASK_USER_SKIP)}>
          都不选，我来说
        </Button>
      </div>
    </div>
  )
}

function initialAnswer(question: AskQuestion): AskAnswer | null {
  return question.type === 'slider' ? { value: question.default ?? question.min } : null
}

function QuestionTabs({ questions, answers, tab, onTab }: { questions: AskQuestion[]; answers: Array<AskAnswer | null>; tab: number; onTab(index: number): void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const next = (tab + (event.key === 'ArrowRight' ? 1 : questions.length - 1)) % questions.length
    onTab(next)
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }
  return (
    <div role="tablist" aria-label="要回答的问题" className="flex flex-wrap gap-x-1 border-b" onKeyDown={onKeyDown}>
      {questions.map((question, index) => (
        <button
          key={index}
          type="button"
          role="tab"
          id={`ask-tab-${index}`}
          aria-selected={index === tab}
          tabIndex={index === tab ? 0 : -1}
          className={cn('-mb-px flex shrink-0 items-center gap-1 border-b-2 px-2.5 py-1.5 text-xs', index === tab ? 'border-foreground font-bold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          onClick={() => onTab(index)}
          data-testid="ask-tab"
        >
          {answers[index] !== null && <Check className="size-3" aria-label="已答" />}
          {question.header ?? `问题 ${index + 1}`}
        </button>
      ))}
    </div>
  )
}

interface QuestionViewProps {
  question: AskQuestion
  answer: AskAnswer | null
  project: string | null
  quick: boolean
  labelledBy?: string
  onAnswer(answer: AskAnswer | null): void
  onPick(index: number): void
}

function QuestionView({ question, answer, project, quick, labelledBy, onAnswer, onPick }: QuestionViewProps) {
  return (
    <div className="space-y-2.5" role={labelledBy ? 'tabpanel' : undefined} aria-labelledby={labelledBy}>
      <p className="break-words whitespace-pre-wrap">{question.question}</p>
      {question.type === 'choice' && <ChoiceView question={question} answer={answer} quick={quick} onAnswer={onAnswer} onPick={onPick} />}
      {question.type === 'slider' && <SliderView question={question} value={answer && 'value' in answer ? answer.value : (question.default ?? question.min)} onAnswer={onAnswer} />}
      {question.type === 'file' && <FileView question={question} files={answer && 'files' in answer ? answer.files : []} project={project} onAnswer={onAnswer} />}
    </div>
  )
}

function ChoiceView({ question, answer, quick, onAnswer, onPick }: { question: Extract<AskQuestion, { type: 'choice' }>; answer: AskAnswer | null; quick: boolean; onAnswer(answer: AskAnswer | null): void; onPick(index: number): void }) {
  const picked = answer && 'choice' in answer ? answer.choice : []
  const images = question.options.some((option) => option.image || option.imageOmitted)
  const id = useId()
  const toggle = (index: number) => {
    if (quick) return onPick(index)
    if (!question.multiSelect) return onAnswer({ choice: [index] })
    const next = picked.includes(index) ? picked.filter((item) => item !== index) : [...picked, index].sort((a, b) => a - b)
    onAnswer(next.length > 0 ? { choice: next } : null)
  }
  return (
    <div
      role={quick ? 'group' : question.multiSelect ? 'group' : 'radiogroup'}
      aria-label={question.question}
      className={cn('grid items-start gap-2', images ? 'grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]' : 'grid-cols-1')}
    >
      {question.options.map((option, index) => {
        const selected = picked.includes(index)
        return (
          <button
            key={index}
            type="button"
            role={quick ? undefined : question.multiSelect ? 'checkbox' : 'radio'}
            aria-checked={quick ? undefined : selected}
            // 名字只是选项本身，说明另外读
            aria-label={option.label}
            aria-describedby={option.description ? `${id}-${index}` : undefined}
            data-ask-first={index === 0 ? '' : undefined}
            className={cn('flex min-w-0 flex-col gap-1.5 rounded-lg border px-3 py-2 text-left hover:bg-accent', selected && 'border-foreground/50 bg-accent')}
            onClick={() => toggle(index)}
            data-testid="ask-option"
          >
            {option.image && <img src={imageUrl(option.image)} alt={option.label} className="max-h-40 w-full rounded-md border bg-background object-contain" />}
            {option.imageOmitted && <span className="text-xs text-muted-foreground">（预览图在对方电脑上）</span>}
            <span className="flex min-w-0 items-center gap-2 font-bold">
              {!quick && (
                <span className={cn('flex size-4 shrink-0 items-center justify-center border', question.multiSelect ? 'rounded-sm' : 'rounded-full', selected && 'border-foreground bg-foreground text-background')} aria-hidden>
                  {selected && <Check className="size-3" />}
                </span>
              )}
              <span className="min-w-0 break-words">{option.label}</span>
            </span>
            {option.description && (
              <span id={`${id}-${index}`} className="text-xs break-words text-muted-foreground">
                {option.description}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

function SliderView({ question, value, onAnswer }: { question: Extract<AskQuestion, { type: 'slider' }>; value: number; onAnswer(answer: AskAnswer): void }) {
  const unit = question.unit ? ` ${question.unit}` : ''
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={question.min}
          max={question.max}
          step={question.step}
          value={value}
          aria-label={question.question}
          aria-valuetext={`${value}${unit}`}
          data-ask-first=""
          className="min-w-0 flex-1 accent-foreground"
          onChange={(event) => onAnswer({ value: Number(event.target.value) })}
          data-testid="ask-slider"
        />
        <output className="w-24 shrink-0 text-right font-bold tabular-nums" data-testid="ask-slider-value">
          {value}
          {unit}
        </output>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>
          {question.min}
          {unit}
        </span>
        <span>
          {question.max}
          {unit}
        </span>
      </div>
    </div>
  )
}

function FileView({ question, files, project, onAnswer }: { question: Extract<AskQuestion, { type: 'file' }>; files: string[]; project: string | null; onAnswer(answer: AskAnswer | null): void }) {
  const [typed, setTyped] = useState('')
  const set = (next: string[]) => {
    const unique = [...new Set(next)]
    const kept = question.multiSelect ? unique : unique.slice(-1)
    onAnswer(kept.length > 0 ? { files: kept } : null)
  }
  const pick = () => {
    if (!project) return
    window.diffra.pickProjectFiles(project, question.multiSelect).then(
      ({ files: picked, outside }) => {
        if (outside > 0) showToast(`只能选这个项目里的文件，项目外的 ${outside} 个没加`)
        if (picked.length > 0) set([...files, ...picked])
      },
      (error: unknown) => showToast(errorMessage(error)),
    )
  }
  const add = async () => {
    const path = typed.trim().replace(/\\/g, '/')
    if (!path) return
    // 本机先查一下在不在项目里；远程任务的文件在对方电脑上，交给对方校验
    if (project) {
      const resolved = await window.diffra.resolveFiles(project, [path]).catch((): Record<string, ProjectFile | null> => ({}))
      const found = resolved[path] ?? null
      if (!found) return showToast(`项目里没有这个文件：${path}`)
      set([...files, found.relative])
    } else set([...files, path])
    setTyped('')
  }
  return (
    <div className="space-y-2">
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" data-testid="ask-files">
          {files.map((file) => (
            <li key={file} className="flex max-w-full items-center gap-1 rounded-md border bg-background py-0.5 pr-1 pl-2 font-mono text-xs">
              <span className="truncate">{file}</span>
              <button type="button" aria-label={`去掉 ${file}`} className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => set(files.filter((item) => item !== file))}>
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {project && (
          <Button variant="outline" size="sm" data-ask-first="" onClick={pick}>
            <FolderOpen />
            {question.multiSelect ? '从项目里选文件…' : '从项目里选一个文件…'}
          </Button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              event.stopPropagation()
              void add()
            }}
            placeholder="或者输入项目里的相对路径"
            aria-label="文件路径"
            data-ask-first={project ? undefined : ''}
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button variant="ghost" size="icon-sm" aria-label="添加这个文件" disabled={!typed.trim()} onClick={() => void add()}>
            <Plus />
          </Button>
        </div>
      </div>
    </div>
  )
}
