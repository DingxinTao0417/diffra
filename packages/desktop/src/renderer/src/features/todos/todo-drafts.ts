import type { FileReference } from '../../../../shared/attachments'

// 快速记那一栏的草稿：切到别的页面再回来接着写（第 639 步）。和输入框的草稿一样只在内存里，应用退出后不保留
export interface TodoInputDraft {
  text: string
  at: Date | null
  project: string | null
  tags: string[]
  images: string[]
  files: FileReference[]
}

const drafts = new Map<string, TodoInputDraft>()

export function readTodoDraft(key: string): TodoInputDraft | undefined {
  return drafts.get(key)
}

// 什么都没填就不留
export function writeTodoDraft(key: string, draft: TodoInputDraft): void {
  const empty = draft.text === '' && draft.at === null && draft.project === null && draft.tags.length === 0 && draft.images.length === 0 && draft.files.length === 0
  if (empty) drafts.delete(key)
  else drafts.set(key, draft)
}
