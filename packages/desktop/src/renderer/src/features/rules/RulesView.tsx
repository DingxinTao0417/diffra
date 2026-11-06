import { useCallback, useEffect, useState } from 'react'
import type { RulePack } from '@diffra/core/types'
import { ChevronDown, ChevronRight, Trash2, Upload } from 'lucide-react'
import type { ProjectState, RulePacksView } from '../../../../shared/ipc'
import type { ProjectRuleSettings } from '../../../../shared/settings'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { errorMessage } from '@/lib/errors'

interface RulesViewProps {
  projectPath: string | null
  projects: string[]
  onProjectChange(path: string): void
}

export function RulesView({ projectPath, projects, onProjectChange }: RulesViewProps) {
  const [packs, setPacks] = useState<RulePacksView | null>(null)
  const [project, setProject] = useState<ProjectState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [view, current] = await Promise.all([window.diffra.listRulePacks(), projectPath ? window.diffra.getProject(projectPath) : null])
      setPacks(view)
      setProject(current)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [projectPath])

  useEffect(() => {
    void reload()
  }, [reload])

  // 先更新界面再保存：勾选框是受控的，等保存回来再变会让连续点击基于旧状态
  const saveRules = async (change: (rules: ProjectRuleSettings) => ProjectRuleSettings) => {
    if (!project) return
    const next = change(project.rules)
    setError(null)
    setProject({ ...project, rules: next })
    try {
      setProject(await window.diffra.saveProjectRules(project.path, next))
      setNotice('已保存，新建或重新打开的任务按新设置运行')
    } catch (caught) {
      setError(errorMessage(caught))
      setProject(project)
    }
  }

  const importPack = async () => {
    setError(null)
    try {
      const { view, imported } = await window.diffra.importRulePack()
      setPacks(view)
      if (imported) setNotice(`已导入规则包「${imported}」`)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const deletePack = async (pack: RulePack) => {
    setError(null)
    try {
      setPacks(await window.diffra.deleteRulePack(pack.id))
      setNotice(`已删除规则包「${pack.name}」`)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  if (!packs) return <p className="text-sm text-muted-foreground">{error ?? '正在读取规则包…'}</p>
  const rules = project?.rules

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">规范</h1>
          <p className="text-sm text-muted-foreground">
            按项目里出现的语言挑选规则包写进提示词；能用检查工具查的问题，请配成项目的检查命令。
          </p>
        </div>
        <Button onClick={importPack}>
          <Upload />
          导入规则包
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>操作失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && <p className="text-sm text-muted-foreground" data-testid="rules-notice">{notice}</p>}
      {packs.errors.map((item) => (
        <Alert key={item.file} variant="destructive">
          <AlertTitle>规则包 {item.file} 无法读取，已跳过</AlertTitle>
          <AlertDescription>{item.message}</AlertDescription>
        </Alert>
      ))}

      <Card>
        <CardHeader>
          <CardTitle>项目</CardTitle>
          {projects.length > 0 ? (
            <select
              aria-label="项目"
              data-testid="rules-project"
              className="h-8 max-w-full rounded-md border bg-background px-2 font-mono text-xs"
              value={projectPath ?? ''}
              onChange={(event) => onProjectChange(event.target.value)}
            >
              {projects.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          ) : (
            <CardDescription data-testid="rules-project">还没有项目，先新建任务选择项目文件夹</CardDescription>
          )}
        </CardHeader>
        {rules && (
          <CardContent className="space-y-2 text-sm">
            <Toggle
              label="推荐级规则也写进提示词"
              hint="默认只放强制级，篇幅超过 4000 字的部分会省略"
              checked={rules.includeRecommended}
              onChange={(checked) => saveRules((current) => ({ ...current, includeRecommended: checked }))}
            />
            <Toggle
              label="完成前按规则审查改动"
              hint="检查命令通过后，用「评审」角色的模型（没分配时用编码模型）审查这一轮的改动；需要 Git"
              checked={rules.review}
              onChange={(checked) => saveRules((current) => ({ ...current, review: checked }))}
            />
          </CardContent>
        )}
      </Card>

      <div className="space-y-3">
        {packs.packs.map(({ pack, builtin }) => {
          const enabled = !rules?.disabledPacks.includes(pack.id)
          const required = pack.rules.filter((rule) => rule.level === 'required').length
          const open = expanded === pack.id
          return (
            <Card key={pack.id} data-testid={`rule-pack-${pack.id}`}>
              <CardHeader className="space-y-2">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    aria-label={`在当前项目启用「${pack.name}」`}
                    className="size-4 accent-primary"
                    checked={enabled}
                    disabled={!rules}
                    onChange={(event) =>
                      saveRules((current) => ({
                        ...current,
                        disabledPacks: event.target.checked
                          ? current.disabledPacks.filter((id) => id !== pack.id)
                          : [...current.disabledPacks, pack.id],
                      }))
                    }
                  />
                  <CardTitle>{pack.name}</CardTitle>
                  <Badge variant={builtin ? 'secondary' : 'outline'}>{builtin ? '内置' : '导入'}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {pack.languages.includes('*') ? '所有语言' : pack.languages.join(', ')} · 强制 {required} 条 · 推荐{' '}
                    {pack.rules.length - required} 条
                  </span>
                  <div className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setExpanded(open ? null : pack.id)}>
                      {open ? <ChevronDown /> : <ChevronRight />}
                      {open ? '收起' : '查看规则'}
                    </Button>
                    {!builtin && (
                      <Button size="sm" variant="ghost" aria-label={`删除「${pack.name}」`} onClick={() => deletePack(pack)}>
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </div>
                <CardDescription className="text-xs">
                  出处：{pack.source}；许可：{pack.license}
                </CardDescription>
              </CardHeader>
              {open && (
                <CardContent>
                  <ul className="space-y-1 text-sm">
                    {pack.rules.map((rule) => (
                      <li key={rule.id} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          aria-label={`启用规则 ${rule.id}`}
                          className="mt-1 size-4 shrink-0 accent-primary"
                          checked={!rules?.disabledRules.includes(rule.id)}
                          disabled={!rules || !enabled}
                          onChange={(event) =>
                            saveRules((current) => ({
                              ...current,
                              disabledRules: event.target.checked
                                ? current.disabledRules.filter((id) => id !== rule.id)
                                : [...current.disabledRules, rule.id],
                            }))
                          }
                        />
                        <span className="w-28 shrink-0 font-mono text-xs leading-5 text-muted-foreground">{rule.id}</span>
                        <Badge variant={rule.level === 'required' ? 'default' : 'outline'} className="mt-0.5">
                          {rule.level === 'required' ? '强制' : '推荐'}
                        </Badge>
                        <span>{rule.text}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}

interface ToggleProps {
  label: string
  hint: string
  checked: boolean
  onChange(checked: boolean): void
}

function Toggle({ label, hint, checked, onChange }: ToggleProps) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 size-4 accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}
