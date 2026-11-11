import { useEffect } from 'react'
import { loadProjects, wireArchitecture } from './architecture-store'
import type { ArchitectureRoute } from './context'
import { ProjectCards } from './ProjectCards'
import { ProjectDetail } from './ProjectDetail'

export function ArchitectureView({ route }: { route: ArchitectureRoute }) {
  useEffect(() => {
    wireArchitecture()
    void loadProjects()
  }, [])
  return route.projectId ? <ProjectDetail key={route.projectId} route={route} projectId={route.projectId} /> : <ProjectCards />
}
