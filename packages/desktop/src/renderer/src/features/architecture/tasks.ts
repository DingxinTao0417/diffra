import { TODO_MAX_TEXT } from '../../../../shared/todos'
import { addTodo, openHome } from '@/state/actions'
import { showToast, store } from '@/state/store'

// 在这个项目的首页输入框里填好一段话，用户看过、改过再发；不直接开跑
export function draftTask(projectPath: string, text: string): void {
  openHome(projectPath)
  store.set((state) => ({ ...state, composerInsert: { target: 'home', text, mode: 'fill' } }))
}

export async function todoFromArchitecture(projectPath: string, text: string): Promise<void> {
  await addTodo(text.length > TODO_MAX_TEXT ? `${text.slice(0, TODO_MAX_TEXT - 1)}…` : text, undefined, { project: projectPath, tags: ['架构'] })
  showToast('已加到待办')
}
