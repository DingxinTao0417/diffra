import type { PromptImage, SkillInfo } from '@diffra/core/types'
import type { FileReference } from '../../../../shared/attachments'

// 输入框的草稿：切到别的页面、任务或设置再回来时接着写。只在内存里，应用退出后不保留。
export interface ComposerImage extends PromptImage {
  id: string
  // 输入框里的 @插入文本，用来给附件着色、点击预览
  mention: string
}

export interface ComposerFile extends FileReference {
  mention: string
}

export interface ComposerDraft {
  text: string
  images: ComposerImage[]
  files: ComposerFile[]
  goal: boolean
  skills: SkillInfo[]
}

const drafts = new Map<string, ComposerDraft>()

export const composerDraftKey = {
  home: (project: string | null) => `home:${project ?? ''}`,
  design: (project: string | null) => `design:${project ?? ''}`,
  task: (sessionId: string) => `task:${sessionId}`,
}

export function readComposerDraft(key: string): ComposerDraft | null {
  return drafts.get(key) ?? null
}

export function writeComposerDraft(key: string, draft: ComposerDraft): void {
  if (draft.text === '' && draft.images.length === 0 && draft.files.length === 0 && draft.skills.length === 0 && !draft.goal) {
    drafts.delete(key)
    return
  }
  drafts.set(key, draft)
}

export function clearComposerDraft(key: string): void {
  drafts.delete(key)
}
