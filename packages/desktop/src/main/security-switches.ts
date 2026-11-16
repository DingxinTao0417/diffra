import type { CheckSwitches } from '@diffra/core'
import { effectiveSecurity, type ProjectSecurity, type Settings } from '../shared/settings'

// 推给 core 的检查开关：全局的，加上单独设过的项目（v2 · M10）。设置页和项目设置改了都推一次，已经打开的任务立即按新值
export function securitySwitches(settings: Pick<Settings, 'security' | 'projects'>): CheckSwitches {
  const global = effectiveSecurity(settings.security, undefined)
  const projects: Record<string, ProjectSecurity> = {}
  for (const [path, project] of Object.entries(settings.projects)) if (project.security && Object.keys(project.security).length > 0) projects[path] = project.security
  return { ...global, projects }
}
