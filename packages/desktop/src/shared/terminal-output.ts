// 只保留内存中的有限输出；常见凭据尽力脱敏，用户仍应在预览中检查。
export const TERMINAL_OUTPUT_MAX_CHARS = 64_000
export const TERMINAL_ATTACHMENT_MAX_CHARS = 16_000
export { TERMINAL_DEFAULT_LINES, TERMINAL_MAX_LINES } from '@diffra/core/types'

export function redactTerminalOutput(text: string): string {
  return text
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*)(?:Bearer\s+)?[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}
