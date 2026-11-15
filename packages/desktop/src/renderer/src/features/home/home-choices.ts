import type { ModelRef } from '../../../../shared/settings'

// 首页、设计首页上选的模型、出计划和设计风格：切到别的页面再回来还是它们。和输入框草稿一样只在内存里，应用退出后不保留。
export interface HomeChoices {
  // null 是没选过，用编码角色的模型
  model: ModelRef | null
  planMode: boolean
  // null 是「自动」
  designStyle: string | null
}

const EMPTY_HOME_CHOICES: HomeChoices = { model: null, planMode: false, designStyle: null }

const choices = new Map<string, HomeChoices>()

export const homeChoicesKey = (design: boolean) => (design ? 'design' : 'home')

export function readHomeChoices(key: string): HomeChoices {
  return choices.get(key) ?? EMPTY_HOME_CHOICES
}

export function writeHomeChoices(key: string, next: HomeChoices): void {
  choices.set(key, next)
}
