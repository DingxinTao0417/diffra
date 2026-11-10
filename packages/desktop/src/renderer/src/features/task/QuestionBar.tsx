import { useState } from 'react'
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
  if (questions.length === 0) return null
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
            <p className="text-sm text-foreground/85">{question.question}</p>
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
                <input
                  autoFocus
                  aria-label={`自己回答：${question.question}`}
                  value={editing.value}
                  placeholder="写下你的答案，回车确定"
                  className="min-w-40 flex-1 rounded-full border bg-background px-2.5 py-0.5 text-xs outline-none focus:border-ring/60"
                  onChange={(event) => setEditing({ question: questionIndex, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditing(null)
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    choose(questionIndex, { custom: editing.value })
                    setEditing(null)
                  }}
                  onBlur={() => setEditing(null)}
                />
              ) : (
                <button
                  type="button"
                  aria-pressed={'custom' in current}
                  title={'custom' in current ? current.custom : undefined}
                  className="rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:border-solid aria-pressed:border-foreground/30 aria-pressed:bg-soft aria-pressed:text-foreground"
                  onClick={() => setEditing({ question: questionIndex, value: 'custom' in current ? current.custom : '' })}
                >
                  其他…
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
