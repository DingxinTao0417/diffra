import { useRef, useState } from 'react'
import type { PromptQuestion } from '@diffra/core/types'
import { cn } from 'cn'

// 现在选的是第几个选项，或者用户自己写的答案
type Choice = { index: number } | { custom: string }

const lineOf = (question: PromptQuestion, choice: Choice) => ('custom' in choice ? choice.custom : (question.options[choice.index]?.text ?? ''))

// 把提示词里原来那个答案的一行换成新答案；那一行被手动改掉、找不到时接在末尾
export function replaceAnswer(text: string, from: string, to: string): string {
  if (from && text.includes(from)) return text.replace(from, to)
  return `${text.trimEnd()}\n${to}`
}

// 问题条：只有用户能回答的问题，每个问题几个选项。提示词已经按第一个（默认）答案写好，
// 点别的选项只把那一行换掉，不再调模型；「其他…」可以自己写一句
export function QuestionBar({ questions, text, onChange, className }: { questions: PromptQuestion[]; text: string; onChange(text: string): void; className?: string }) {
  const [choices, setChoices] = useState<Choice[]>(() => questions.map(() => ({ index: 0 })))
  const [editing, setEditing] = useState<{ question: number; value: string } | null>(null)
  // 按 Esc 关掉时随后的失焦不算写完
  const cancelled = useRef(false)
  if (questions.length === 0) return null
  // 回车、点别处都算写完：有字就用它，空着就当没改
  const confirm = () => {
    if (!editing || cancelled.current) return
    if (editing.value.trim()) choose(editing.question, { custom: editing.value.trim() })
    setEditing(null)
  }
  const choose = (questionIndex: number, choice: Choice) => {
    const question = questions[questionIndex]!
    const current = choices[questionIndex] ?? { index: 0 }
    const to = lineOf(question, choice).trim()
    if (!to) return
    onChange(replaceAnswer(text, lineOf(question, current), to))
    setChoices(choices.map((item, index) => (index === questionIndex ? choice : item)))
  }
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="question-bar">
      {questions.map((question, questionIndex) => {
        const current = choices[questionIndex] ?? { index: 0 }
        return (
          <div key={questionIndex} className="flex flex-col gap-1.5" data-testid="question">
            <p className="text-sm text-foreground">{question.question}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              {question.options.map((option, optionIndex) => {
                const selected = 'index' in current && current.index === optionIndex
                return (
                  <button
                    key={optionIndex}
                    type="button"
                    aria-pressed={selected}
                    title={option.text}
                    className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:border-foreground/30 aria-pressed:bg-soft aria-pressed:text-foreground"
                    onClick={() => choose(questionIndex, { index: optionIndex })}
                  >
                    {option.label}
                  </button>
                )
              })}
              {editing?.question === questionIndex ? (
                // 跟着内容长高，最多 4 行，再多在框里滚动；Shift+回车换行
                <textarea
                  autoFocus
                  rows={1}
                  aria-label={`自己回答：${question.question}`}
                  value={editing.value}
                  placeholder="写下你的答案，回车确定，Shift+回车换行"
                  className="field-sizing-content max-h-[calc(4lh+0.5rem)] w-full basis-full resize-none rounded-lg border bg-background px-2.5 py-1 text-xs leading-relaxed outline-none focus:border-ring/60"
                  onChange={(event) => setEditing({ question: questionIndex, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      cancelled.current = true
                      setEditing(null)
                    }
                    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    confirm()
                  }}
                  onBlur={confirm}
                />
              ) : (
                <button
                  type="button"
                  aria-pressed={'custom' in current}
                  title={'custom' in current ? current.custom : undefined}
                  className="max-w-full truncate rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:border-solid aria-pressed:border-foreground/30 aria-pressed:bg-soft aria-pressed:text-foreground sm:max-w-80"
                  onClick={() => {
                    cancelled.current = false
                    setEditing({ question: questionIndex, value: 'custom' in current ? current.custom : '' })
                  }}
                >
                  {'custom' in current ? current.custom.replace(/\s+/g, ' ') : '其他…'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
