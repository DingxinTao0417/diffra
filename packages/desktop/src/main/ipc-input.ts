import type { z } from 'zod'

// 界面传来的数据在这里校验，校验失败的说明直接给用户看
export function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  throw new Error(`输入不合法：${result.error.issues.map((issue) => issue.message).join('；')}`)
}
