import { useMemo, useState } from 'react'
import { BookOpen, CircleAlert, Globe, LoaderCircle, LogIn, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatTime } from '@/lib/format'
import { interpret, useArchitecture } from '../architecture-store'
import { useArch } from '../context'
import { formatCount } from '../graph'
import { LanguageBar } from '../parts'

// 概览：模型写的系统简介、技术栈、入口、建议的阅读顺序、外部系统，加上静态分析的关键数字
export function OverviewView() {
  const { analysis, interpretation, index, project, go } = useArch()
  const progress = useArchitecture((state) => state.running[project.id])
  const interpreting = progress?.phase === 'interpreting'
  const hasSummary = Boolean(interpretation?.summary)
  const outdated = Boolean(interpretation?.generatedAt && interpretation.fingerprint !== analysis.fingerprint)
  const externals = useMemo(() => analysis.externals.filter((item) => !item.builtin), [analysis])
  const entries = interpretation?.entryPoints.length ? interpretation.entryPoints : analysis.files.filter((file) => file.entry).map((file) => ({ path: file.path, description: '' }))
  const focusPath = (path: string) => {
    const file = index.file(path)
    go({ tab: 'dependencies', section: 'graph', scope: file ? `dir:${file.module}` : `dir:${index.collapse(path)}`, focus: file ? `file:${path}` : `dir:${path}` })
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="architecture-overview">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <section className="space-y-3 rounded-xl border bg-card p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <h2 className="font-bold">系统简介</h2>
            {interpretation?.generatedAt && (
              <span className="text-xs text-muted-foreground">
                {interpretation.model.modelId} · {formatTime(interpretation.generatedAt)}
                {interpretation.dropped > 0 && ` · 丢掉了 ${interpretation.dropped} 处对不上代码的引用`}
              </span>
            )}
          </div>
          {outdated && (
            <div className="flex items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs">
              <CircleAlert className="size-3.5 text-warning" />
              这份解读基于上一次分析，代码已经变了，可以重新解读
            </div>
          )}
          {hasSummary ? (
            <div className="space-y-2 text-sm leading-relaxed whitespace-pre-wrap" data-testid="architecture-summary">
              {interpretation!.summary}
            </div>
          ) : (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                静态分析已经画出了结构。让模型读一份压缩过的摘要（目录、依赖、关键文件的符号、清单和 README，不发整份代码），说明分层、模块职责、外部系统和关键流程。用「规划」角色的模型，没配就用「编码」。
              </p>
              <Button size="sm" disabled={interpreting} onClick={() => void interpret(project.id)}>
                {interpreting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {interpreting ? '解读中，大约一两分钟' : '让模型解读'}
              </Button>
            </div>
          )}
          {interpretation && interpretation.techStack.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {interpretation.techStack.map((item) => (
                <Badge key={item} variant="secondary">
                  {item}
                </Badge>
              ))}
            </div>
          )}
        </section>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="architecture-stats">
          <Tile label="代码文件" value={formatCount(analysis.stats.files)} />
          <Tile label="代码行" value={formatCount(analysis.stats.lines)} />
          <Tile label="包" value={String(index.codePackages().length)} />
          <Tile label="目录" value={formatCount(analysis.modules.length)} />
          <Tile label="文件之间的依赖" value={formatCount(analysis.edges.length)} />
          <Tile label="循环依赖" value={String(index.fileCycles.length)} warn={index.fileCycles.length > 0} onClick={() => go({ tab: 'dependencies' })} />
          <Tile label="外部包" value={String(externals.length)} onClick={() => go({ tab: 'dependencies' })} />
          <Tile label="没对上的导入" value={String(analysis.unresolved.length)} warn={analysis.unresolved.length > 0} />
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-bold">语言</h2>
          <LanguageBar languages={analysis.stats.languages} limit={8} />
        </section>

        <div className="grid gap-6 md:grid-cols-2">
          <section className="space-y-2">
            <h2 className="flex items-center gap-1.5 text-sm font-bold">
              <LogIn className="size-4 text-muted-foreground" />
              入口
            </h2>
            {entries.length === 0 && <p className="text-xs text-muted-foreground">清单里没写入口，也没找到惯例的入口文件</p>}
            {entries.map((entry) => (
              <button key={entry.path} type="button" className="block w-full rounded-md px-2 py-1 text-left hover:bg-accent" onClick={() => focusPath(entry.path)}>
                <div className="truncate font-mono text-xs">{entry.path}</div>
                {entry.description && <div className="text-xs text-muted-foreground">{entry.description}</div>}
              </button>
            ))}
          </section>
          {interpretation && interpretation.readingOrder.length > 0 && (
            <section className="space-y-2">
              <h2 className="flex items-center gap-1.5 text-sm font-bold">
                <BookOpen className="size-4 text-muted-foreground" />
                建议从这里开始读
              </h2>
              <ol className="space-y-1">
                {interpretation.readingOrder.map((item, at) => (
                  <li key={item.path}>
                    <button type="button" className="flex w-full gap-2 rounded-md px-2 py-1 text-left hover:bg-accent" onClick={() => focusPath(item.path)}>
                      <span className="text-xs text-muted-foreground tabular-nums">{at + 1}.</span>
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-xs">{item.path}</span>
                        <span className="block text-xs text-muted-foreground">{item.reason}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        {interpretation && interpretation.externalSystems.length > 0 && (
          <section className="space-y-2">
            <h2 className="flex items-center gap-1.5 text-sm font-bold">
              <Globe className="size-4 text-muted-foreground" />
              外部系统
            </h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {interpretation.externalSystems.map((system) => (
                <button key={system.name} type="button" className="rounded-lg border p-3 text-left hover:bg-accent" onClick={() => go({ tab: 'dependencies', section: 'graph', scope: 'system', focus: `system:${system.name}` })}>
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{system.name}</span>
                    <Badge variant="outline">{system.kind}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{system.description}</p>
                </button>
              ))}
            </div>
          </section>
        )}

        <AnalysisDetails />
      </div>
    </div>
  )
}

function Tile({ label, value, warn = false, onClick }: { label: string; value: string; warn?: boolean; onClick?(): void }) {
  const content = (
    <>
      <div className={warn ? 'text-xl font-semibold text-warning tabular-nums' : 'text-xl font-semibold tabular-nums'}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </>
  )
  return onClick ? (
    <button type="button" className="rounded-lg border p-3 text-left hover:bg-accent" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="rounded-lg border p-3">{content}</div>
  )
}

function AnalysisDetails() {
  const { analysis, peek } = useArch()
  const [showUnresolved, setShowUnresolved] = useState(false)
  const { skipped } = analysis.stats
  return (
    <section className="space-y-2 text-xs text-muted-foreground">
      <h2 className="text-sm font-bold text-foreground">分析说明</h2>
      <p>
        深度解析了 {analysis.stats.parsedFiles} 个文件（TS/JS/Vue/Python/Go/Rust/Java），其余语言只统计文件和行数。这次重新解析了 {analysis.stats.reparsed} 个文件，其余用上次的结果。
        {analysis.commits.length > 0 ? ` 改动频率按最近 ${analysis.churnDays} 天的 ${analysis.commits.length} 次提交算。` : ' 不是 git 仓库，没有改动频率。'}
      </p>
      {(skipped.tooLarge > 0 || skipped.generated > 0 || skipped.overLimit > 0 || skipped.failed > 0) && (
        <p>
          跳过：{skipped.tooLarge > 0 && `超过 512 KB 的 ${skipped.tooLarge} 个；`}
          {skipped.generated > 0 && `看起来是压缩或生成的 ${skipped.generated} 个；`}
          {skipped.overLimit > 0 && `超过 2 万个文件上限的 ${skipped.overLimit} 个；`}
          {skipped.failed > 0 && `解析失败的 ${skipped.failed} 个`}
        </p>
      )}
      {analysis.unresolved.length > 0 && (
        <div className="space-y-1">
          <button type="button" className="hover:underline" onClick={() => setShowUnresolved((value) => !value)}>
            {showUnresolved ? '收起' : '看看'}没对上任何文件的 {analysis.unresolved.length} 条项目内导入（拼错、生成的文件、被 .gitignore 跳过）
          </button>
          {showUnresolved &&
            analysis.unresolved.map((item) => (
              <button key={`${item.file}:${item.line}:${item.specifier}`} type="button" className="flex w-full gap-2 rounded-sm px-1 text-left font-mono hover:bg-accent" onClick={() => peek(analysis.files[item.file]!.path, item.line)}>
                <span className="min-w-0 flex-1 truncate">
                  {analysis.files[item.file]!.path}:{item.line}
                </span>
                <span>{item.specifier}</span>
              </button>
            ))}
        </div>
      )}
    </section>
  )
}
