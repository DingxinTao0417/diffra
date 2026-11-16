import { basename, extname } from 'node:path'

// 完成检查的范围：只改文档时不跑。判断保守一点：有一条不是文档就照常跑；读不到改动路径也照常跑
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc'])
const DOC_NAMES = [/^readme(?:\.[^.]+)?$/i, /^changelog(?:\.[^.]+)?$/i, /^license(?:\.[^.]+)?$/i, /^notice(?:\.[^.]+)?$/i]

export function isDocsOnly(paths: readonly string[]): boolean {
  if (paths.length === 0) return false
  return paths.every((path) => {
    const name = basename(path)
    const extension = extname(name).toLowerCase()
    // .txt 太常见，只有放在 docs/ 下才当文档；项目根目录的 a.txt 可能是数据或测试输入
    if (extension === '.txt') return /(^|[\\/])docs?[\\/]/i.test(path)
    return DOC_EXTENSIONS.has(extension) || DOC_NAMES.some((pattern) => pattern.test(name))
  })
}

export function shouldRunFinishCheck(changes: 'none' | 'edited' | 'unknown', paths: readonly string[] | null): boolean {
  if (changes === 'none') return false
  // 判断不了改了哪些文件时按改了代码处理，不能漏跑
  if (changes === 'unknown' || paths === null || paths.length === 0) return true
  return !isDocsOnly(paths)
}
