// 业务错误：http 层按 status 和 code 原样返回给调用方
export class AppError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const invalid = (message: string) => new AppError(400, 'invalid', message)
export const forbidden = (message: string) => new AppError(403, 'forbidden', message)
export const notFound = (message: string) => new AppError(404, 'not_found', message)
export const conflict = (message: string) => new AppError(409, 'conflict', message)
