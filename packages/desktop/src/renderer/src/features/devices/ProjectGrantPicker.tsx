import { TriangleAlert } from 'lucide-react'
import type { RemoteLevel, RemoteProjectGrant } from '../../../../shared/remote'
import { Checkbox } from '@/components/ui/checkbox'
import { Segmented } from '@/components/ui/segmented'
import { folderName } from '@/lib/format'
import { useAppState } from '@/state/store'

const LEVEL_OPTIONS: Array<{ value: RemoteLevel; label: string }> = [
  { value: 'view', label: '可查看' },
  { value: 'control', label: '可查看和操作' },
]

export function describeGrants(projects: RemoteProjectGrant[]): string {
  if (projects.length === 0) return '不开放任何项目'
  return projects.map((project) => `${folderName(project.path)}（${project.level === 'control' ? '可查看和操作' : '可查看'}）`).join('、')
}

// 给一台设备开放哪些项目、每个项目开到哪一级。可选的是侧栏里的项目，加上已经授权过的
export function ProjectGrantPicker({ value, onChange }: { value: RemoteProjectGrant[]; onChange(value: RemoteProjectGrant[]): void }) {
  const sidebar = useAppState((state) => state.projects)
  const projects = [...new Set([...sidebar, ...value.map((grant) => grant.path)])]
  const control = value.some((grant) => grant.level === 'control')
  const levelOf = (path: string) => value.find((grant) => grant.path === path)?.level ?? null

  const toggle = (path: string, checked: boolean) => onChange(checked ? [...value, { path, level: 'view' }] : value.filter((grant) => grant.path !== path))
  const setLevel = (path: string, level: RemoteLevel) => onChange(value.map((grant) => (grant.path === path ? { ...grant, level } : grant)))

  return (
    <div className="space-y-3">
      {projects.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">还没有项目。先在首页选一个项目文件夹，再来授权。</p>
      ) : (
        <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border" aria-label="开放的项目">
          {projects.map((path) => {
            const level = levelOf(path)
            const id = `grant-${path}`
            return (
              <li key={path} className="flex items-center gap-3 px-3 py-2">
                <Checkbox id={id} checked={level !== null} onCheckedChange={(checked) => toggle(path, checked === true)} aria-label={`开放 ${folderName(path)}`} />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer" title={path}>
                  <div className="truncate text-sm">{folderName(path)}</div>
                  <div className="truncate text-xs text-muted-foreground">{path}</div>
                </label>
                {level && <Segmented size="sm" label={`${folderName(path)} 的权限`} value={level} options={LEVEL_OPTIONS} onChange={(next) => setLevel(path, next)} />}
              </li>
            )
          })}
        </ul>
      )}
      {control && (
        <p className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning" role="note">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          「可查看和操作」等于让对方以你的 Windows 账户在这台电脑上运行命令：能让智能体跑命令，也能自己点确认。按项目授权只限定能操作哪些任务，不是沙箱，只授权给你信任的人。
        </p>
      )}
    </div>
  )
}
