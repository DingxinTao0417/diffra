import { useContext } from 'react'
import { AnswerContext, openFilePreview, useProjectFile } from '../answer-links'

// 检查、审查、扫描结果里的「路径:行号」：是项目里的文件就能点开到那一行（第 658 步）；远程、只读会话里照原样显示
export function LocationLink({ location, className }: { location: string; className?: string }) {
  const target = useContext(AnswerContext)
  const match = /^(.+?):(\d+)(?::\d+)?$/.exec(location)
  const file = useProjectFile(match?.[1] ?? null)
  if (!match || !file || !target) return <span className={className}>{location}</span>
  return (
    <button
      type="button"
      // primary-color-allow: 能点开的源码位置，和回答里的文件引用同色
      className={`${className ?? ''} text-primary hover:underline`}
      title={`在文件面板打开 ${file.relative}:${match[2]}`}
      onClick={(event) => {
        event.preventDefault()
        openFilePreview(target.project, file.relative, Number(match[2]))
      }}
      data-testid="finding-location"
    >
      {location}
    </button>
  )
}
