import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { Clipboard, ClipboardCopy, ExternalLink, FileDiff, FileText, FolderOpen, Globe, Link, PanelRight } from 'lucide-react'
import type { ProjectFile } from '../../../../shared/ipc'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { errorMessage } from '@/lib/errors'
import { showToast, store } from '@/state/store'

// 回答里的链接和文件引用（第 534、535 步）。本机任务的对话给这个上下文；远程任务没有，链接交给系统浏览器、文件引用按普通代码显示
export interface AnswerTarget {
  sessionId: string
  project: string
  // 这个任务改过的文件（相对项目，用 /）：右键多一项「查看改动」
  changed: ReadonlySet<string>
}

export const AnswerContext = createContext<AnswerTarget | null>(null)

const copy = (text: string, done: string) =>
  navigator.clipboard.writeText(text).then(
    () => showToast(done),
    (error: unknown) => showToast(`复制失败：${errorMessage(error)}`),
  )

const openExternal = (url: string) => window.diffra.openExternal(url).catch((error: unknown) => showToast(errorMessage(error)))

function openInBrowser(sessionId: string, url: string) {
  store.set((state) => ({ ...state, panel: 'browser' }))
  window.diffra.browserNavigate(sessionId, url).catch((error: unknown) => showToast(errorMessage(error)))
}

const isWebUrl = (href: string) => /^https?:\/\//i.test(href)

// 回答里的链接：网址默认在这个任务的内置浏览器里打开，右键可以换系统浏览器；指向项目文件的链接按文件引用处理
export function AnswerLink({ href, children }: { href?: string; children?: ReactNode }) {
  const target = useContext(AnswerContext)
  // 不带协议的、file: 开头的、盘符开头的都可能是文件；mailto: 这类别的协议不是（盘符只有一个字母，协议至少两个）
  const file = target && href && (/^file:/i.test(href) || !/^[a-z][\w+.-]+:/i.test(href)) ? fileOfHref(href) : null
  if (file) return <FileReference path={file.path} line={file.line} label={children} />
  const open = () => {
    if (!href) return
    if (target && isWebUrl(href)) openInBrowser(target.sessionId, href)
    else void openExternal(href)
  }
  const anchor = (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        open()
      }}
    >
      {children}
    </a>
  )
  if (!href || !isWebUrl(href)) return anchor
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>
      <ContextMenuContent>
        {target && (
          <ContextMenuItem onSelect={() => openInBrowser(target.sessionId, href)}>
            <Globe />
            在内置浏览器打开
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => void openExternal(href)}>
          <ExternalLink />
          用系统浏览器打开
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copy(href, '已复制链接')}>
          <Link />
          复制链接
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// [loop.ts](packages/core/src/loop.ts#L1430)、[x](./a.ts:12)、file:///D:/p/a.ts
function fileOfHref(href: string): { path: string; line: number | null } | null {
  let text = href.replace(/^file:\/\/\/?/i, '')
  try {
    text = decodeURIComponent(text)
  } catch {
    return null
  }
  const hash = /#L(\d+)(?:-L?\d+)?$/.exec(text)
  if (hash) return { path: text.slice(0, hash.index), line: Number(hash[1]) }
  return fileOfCode(text)
}

// 行内代码里像文件路径的：带扩展名、没有空格，后面可以跟 :行号（src/api.js、loop.ts:1430、D:\p\a.ts:12:3）；
// 点开头、没有扩展名的也算（.gitignore、src/.env，第 540 步）。是不是真有这个文件由主进程查
const FILE_IN_CODE = /^((?:[A-Za-z]:)?(?:[^\s:*?"<>|]*[^\s:*?"<>|/\\.]\.[A-Za-z][A-Za-z0-9]{0,9}|(?:[^\s:*?"<>|]*[/\\])?\.[A-Za-z][\w.-]*))(?::(\d+)(?:[:-]\d+)?)?$/

export function fileOfCode(text: string): { path: string; line: number | null } | null {
  const match = FILE_IN_CODE.exec(text.trim())
  return match ? { path: match[1]!, line: match[2] ? Number(match[2]) : null } : null
}

// 查文件在不在项目里：同一刻的查询攒成一次；在的一直记着，不在的过一会儿再查（智能体可能刚建了它）
const MISS_TTL_MS = 5_000
const resolved = new Map<string, { file: ProjectFile | null; at: number; pending?: Promise<ProjectFile | null> }>()
let queue: Array<{ project: string; path: string; done(file: ProjectFile | null): void }> = []

function lookup(project: string, path: string): Promise<ProjectFile | null> {
  const key = `${project}\n${path}`
  const hit = resolved.get(key)
  if (hit?.pending) return hit.pending
  if (hit && (hit.file || Date.now() - hit.at < MISS_TTL_MS)) return Promise.resolve(hit.file)
  const pending = new Promise<ProjectFile | null>((done) => {
    queue.push({ project, path, done })
    if (queue.length === 1) queueMicrotask(flush)
  })
  resolved.set(key, { file: null, at: Date.now(), pending })
  return pending
}

function flush() {
  const batch = queue
  queue = []
  const byProject = new Map<string, typeof batch>()
  for (const item of batch) byProject.set(item.project, [...(byProject.get(item.project) ?? []), item])
  for (const [project, items] of byProject) {
    const paths = [...new Set(items.map((item) => item.path))]
    window.diffra.resolveFiles(project, paths).then(
      (files) => {
        for (const item of items) {
          const file = files[item.path] ?? null
          resolved.set(`${project}\n${item.path}`, { file, at: Date.now() })
          item.done(file)
        }
      },
      (error: unknown) => {
        console.error('[answer] 查回答里提到的文件失败', error)
        for (const item of items) {
          resolved.delete(`${project}\n${item.path}`)
          item.done(null)
        }
      },
    )
  }
}

// 只写了文件名：先在这个任务改过的文件里按文件名找（只有一个同名的才算），找不到再当作项目根目录下的文件
function candidatePath(target: AnswerTarget, path: string): string {
  if (/[/\\]/.test(path)) return path
  const same = [...target.changed].filter((item) => item.slice(item.lastIndexOf('/') + 1) === path)
  return same.length === 1 ? same[0]! : path
}

// 行内代码：是项目里的文件就显示成文件引用，否则照常
export function AnswerCode({ children, className }: { children?: ReactNode; className?: string }) {
  const target = useContext(AnswerContext)
  const text = typeof children === 'string' ? children : null
  // 代码块里的 code 带语言类名或换行，不当文件引用
  const file = target && text && !className && !text.includes('\n') ? fileOfCode(text) : null
  if (!file) return <code className={className}>{children}</code>
  return <FileReference path={file.path} line={file.line} label={text} code />
}

function FileReference({ path, line, label, code }: { path: string; line: number | null; label: ReactNode; code?: boolean }) {
  const target = useContext(AnswerContext)!
  const candidate = candidatePath(target, path)
  const [file, setFile] = useState<ProjectFile | null | undefined>(undefined)
  useEffect(() => {
    let stale = false
    void lookup(target.project, candidate).then((found) => !stale && setFile(found))
    return () => {
      stale = true
    }
  }, [target.project, candidate])
  if (!file) return code ? <code>{label}</code> : <span>{label}</span>
  // 点了都在右侧文件面板里打开这一个文件、定位到那一行（第 546 步）；看改动走右键
  const view = () => store.set((state) => ({ ...state, panel: 'file', filePreview: { project: target.project, path: file.relative, line } }))
  const changed = target.changed.has(file.relative)
  const run = (action: Promise<unknown>) => action.catch((error: unknown) => showToast(errorMessage(error)))
  const copyContent = async () => {
    const content = await window.diffra.readFile(target.project, file.relative)
    if (content.binary) return showToast('二进制文件，不能复制内容')
    await copy(content.text, content.truncated ? '已复制文件开头 1 MB' : '已复制文件内容')
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          // primary-color-allow: 回答里可点的文件引用，和链接同色
          className="inline-flex max-w-full items-baseline gap-1 rounded-sm align-baseline text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          title={file.relative + (line ? `:${line}` : '')}
          data-testid="file-reference"
          onClick={view}
        >
          <LanguageBadge path={file.relative} />
          <span className={code ? 'font-mono text-[0.9em] break-all' : 'break-all'}>{label}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={view}>
          <PanelRight />
          在右侧栏打开
        </ContextMenuItem>
        {changed && (
          <ContextMenuItem onSelect={() => store.set((state) => ({ ...state, panel: 'review', reviewFile: file.relative }))}>
            <FileDiff />
            查看改动
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => void run(window.diffra.openFile(target.project, file.relative))}>
          <FileText />
          用默认应用打开
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copy(file.path, '已复制路径')}>
          <Clipboard />
          复制路径
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void run(copyContent())}>
          <ClipboardCopy />
          复制文件内容
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void run(window.diffra.revealFile(target.project, file.relative))}>
          <FolderOpen />
          在资源管理器中显示
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// 语言小方块：常见语言写缩写、配语言的代表色（和编辑器里的文件图标同一个意思），别的文件是通用文件图标
const LANGUAGES: Record<string, { label: string; color: string; dark?: boolean }> = {
  ts: { label: 'TS', color: '#3178c6' },
  tsx: { label: 'TS', color: '#3178c6' },
  mts: { label: 'TS', color: '#3178c6' },
  cts: { label: 'TS', color: '#3178c6' },
  js: { label: 'JS', color: '#e8c400', dark: true },
  jsx: { label: 'JS', color: '#e8c400', dark: true },
  mjs: { label: 'JS', color: '#e8c400', dark: true },
  cjs: { label: 'JS', color: '#e8c400', dark: true },
  py: { label: 'PY', color: '#3776ab' },
  json: { label: '{}', color: '#c08a00' },
  md: { label: 'MD', color: '#5b6b7b' },
  mdx: { label: 'MD', color: '#5b6b7b' },
  css: { label: 'CSS', color: '#663399' },
  scss: { label: 'CSS', color: '#c6538c' },
  html: { label: '<>', color: '#e34c26' },
  vue: { label: 'V', color: '#41b883' },
  svelte: { label: 'S', color: '#ff3e00' },
  go: { label: 'GO', color: '#00add8' },
  rs: { label: 'RS', color: '#ce422b' },
  java: { label: 'J', color: '#b07219' },
  kt: { label: 'KT', color: '#7f52ff' },
  cs: { label: 'C#', color: '#178600' },
  c: { label: 'C', color: '#555c66' },
  h: { label: 'H', color: '#555c66' },
  cpp: { label: 'C+', color: '#00599c' },
  rb: { label: 'RB', color: '#cc342d' },
  php: { label: 'PHP', color: '#777bb4' },
  swift: { label: 'SW', color: '#f05138' },
  sh: { label: '$', color: '#4b5563' },
  ps1: { label: '$', color: '#2671be' },
  sql: { label: 'SQL', color: '#c27c0e' },
  yml: { label: 'YML', color: '#a1262d' },
  yaml: { label: 'YML', color: '#a1262d' },
  toml: { label: 'TML', color: '#9c4221' },
}

export function LanguageBadge({ path }: { path: string }) {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const language = LANGUAGES[extension]
  if (!language) return <FileText className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
  return (
    <span
      aria-hidden="true"
      className="flex size-3.5 shrink-0 items-center justify-center self-center rounded-xs font-sans text-[7px] leading-none font-bold tracking-tight"
      style={{ backgroundColor: language.color, color: language.dark ? '#1f1f1f' : '#fff' }}
    >
      {language.label}
    </span>
  )
}
