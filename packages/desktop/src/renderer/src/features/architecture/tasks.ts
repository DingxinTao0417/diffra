import { TODO_MAX_TEXT, TODO_MAX_TITLE } from '../../../../shared/todos'
import { addTodo, openHome } from '@/state/actions'
import { showToast, store } from '@/state/store'

// 在这个项目的首页输入框里填好一段话，用户看过、改过再发；不直接开跑
export function draftTask(projectPath: string, text: string): void {
  openHome(projectPath)
  store.set((state) => ({ ...state, composerInsert: { target: 'home', text, mode: 'fill' } }))
}

// 架构给的一句话当标题，生成的提示词当正文
export async function todoFromArchitecture(projectPath: string, title: string, body: string): Promise<void> {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
  await addTodo(clip(title, TODO_MAX_TITLE), undefined, { project: projectPath, tags: ['架构'], body: clip(body, TODO_MAX_TEXT) })
  showToast('已加到待办')
}
