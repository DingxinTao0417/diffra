import { redactTerminalOutput, TERMINAL_ATTACHMENT_MAX_CHARS, TERMINAL_DEFAULT_LINES } from '../../../../shared/terminal-output'
import { FitAddon } from '@xterm/addon-fit'
import { type ITheme, Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { errorMessage } from '@/lib/errors'
import { showToast, store } from '@/state/store'

const FONT_FAMILY = '"Cascadia Mono", Consolas, "JetBrains Mono", monospace'
const SCROLLBACK_LINES = 5000
// 界面还没登记某个终端时先攒着它的输出，攒满就丢最早的
const MAX_PENDING_CHUNKS = 256

interface TerminalView {
  term: Terminal
  fit: FitAddon
  element: HTMLDivElement
  opened: boolean
}

// xterm 实例放在组件外面：切换任务、收起面板时终端内容和进程都保留
const views = new Map<string, TerminalView>()
const pending = new Map<string, string[]>()

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// xterm 默认的 16 色按深色背景配，浅色背景上「白色」文字（PowerShell 的数字、属性名）看不见。
// 浅色时换成 VS Code 浅色终端的配色
const LIGHT_ANSI: ITheme = {
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
}

function currentTheme(): ITheme {
  const background = cssVar('--background')
  // primary-color-allow: 终端光标
  const base: ITheme = { background, foreground: cssVar('--foreground'), cursor: cssVar('--primary'), cursorAccent: background, selectionBackground: cssVar('--soft') }
  return document.documentElement.classList.contains('dark') ? base : { ...LIGHT_ANSI, ...base }
}

// 跟着外观里的文字大小走，比正文略小
function currentFontSize(): number {
  return Math.round(Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.93)
}

// 本机终端和远程终端（features/devices/RemoteTerminalPanel.tsx）共用的 xterm：字体、配色跟着外观，输入交给 onData
export function createXterm(onData: (data: string) => void): { term: Terminal; fit: FitAddon; element: HTMLDivElement } {
  const element = document.createElement('div')
  element.className = 'h-full w-full'
  const term = new Terminal({ fontFamily: FONT_FAMILY, fontSize: currentFontSize(), theme: currentTheme(), cursorBlink: true, scrollback: SCROLLBACK_LINES })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.onData(onData)
  // Ctrl+` 留给应用收起终端，不发给 shell
  term.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.key === '`'))
  return { term, fit, element }
}

function createView(id: string): TerminalView {
  const view = { ...createXterm((data) => window.diffra.writeTerminal(id, data)), opened: false }
  views.set(id, view)
  for (const chunk of pending.get(id) ?? []) view.term.write(chunk)
  pending.delete(id)
  return view
}

// 把终端放进面板：第一次放进去时才 open，xterm 要在页面里才能量字符尺寸
export function attachTerminal(id: string, host: HTMLElement): void {
  const view = views.get(id)
  if (!view) return
  host.replaceChildren(view.element)
  if (!view.opened) {
    view.term.open(view.element)
    view.opened = true
  }
  fitTerminal(id)
  view.term.focus()
}

export function terminalAttachment(id: string): string {
  const term = views.get(id)?.term
  if (!term) return ''
  const selection = term.getSelection()
  if (selection) return redactTerminalOutput(selection.slice(-TERMINAL_ATTACHMENT_MAX_CHARS))
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let index = Math.max(0, buffer.length - TERMINAL_DEFAULT_LINES); index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
  return redactTerminalOutput(lines.join('\n').trim().slice(-TERMINAL_ATTACHMENT_MAX_CHARS))
}

export function fitTerminal(id: string): void {
  const view = views.get(id)
  if (!view?.opened || !view.element.isConnected) return
  const before = { cols: view.term.cols, rows: view.term.rows }
  view.fit.fit()
  // 终端和进程都从 80×24 开始，尺寸变了才通知进程
  if (view.term.cols !== before.cols || view.term.rows !== before.rows) {
    window.diffra.resizeTerminal(id, { cols: view.term.cols, rows: view.term.rows })
  }
}

export async function newTerminal(cwd: string): Promise<void> {
  try {
    const { id, shell } = await window.diffra.createTerminal(cwd, { cols: 80, rows: 24 })
    createView(id)
    store.set((state) => ({
      ...state,
      panel: 'terminal',
      terminals: [...state.terminals, { id, cwd, shell, exitCode: null }],
      activeTerminal: id,
    }))
  } catch (error) {
    showToast(`打不开终端：${errorMessage(error)}`)
  }
}

// 把一条命令打进这个项目的终端（第 662 步，对话里命令输出的「在终端里运行」）：有开着的就用它，没有就新开一个。
// 不按回车：智能体的命令是 bash 写法，终端可能是别的 shell，跑不跑由用户看过再定
export async function typeIntoTerminal(cwd: string, text: string): Promise<void> {
  let id = store.get().terminals.find((item) => item.cwd === cwd && item.exitCode === null)?.id
  if (!id) {
    await newTerminal(cwd)
    id = store.get().terminals.findLast((item) => item.cwd === cwd)?.id
  }
  if (!id) return
  showTerminal(id)
  window.diffra.writeTerminal(id, text)
}

export function showTerminal(id: string): void {
  store.set((state) => ({ ...state, panel: 'terminal', activeTerminal: id }))
}

// 终端在右侧栏（第 533 步），和别的面板互斥；没有终端时顺手开一个
export function toggleTerminalPanel(cwd: string): void {
  const state = store.get()
  if (state.panel === 'terminal') store.set((current) => ({ ...current, panel: null }))
  else if (state.terminals.length === 0) void newTerminal(cwd)
  else store.set((current) => ({ ...current, panel: 'terminal' }))
}

export function closeTerminal(id: string): void {
  const tab = store.get().terminals.find((item) => item.id === id)
  if (tab?.exitCode === null) window.diffra.killTerminal(id).catch((error: unknown) => console.error('结束终端失败', error))
  views.get(id)?.term.dispose()
  views.delete(id)
  pending.delete(id)
  store.set((state) => {
    const terminals = state.terminals.filter((item) => item.id !== id)
    return {
      ...state,
      terminals,
      activeTerminal: state.activeTerminal === id ? (terminals.at(-1)?.id ?? null) : state.activeTerminal,
      panel: state.panel === 'terminal' && terminals.length === 0 ? null : state.panel,
    }
  })
}

// 终端输出、进程退出和外观变化只监听一次
export function wireTerminalEvents(): () => void {
  const offData = window.diffra.onTerminalData(({ id, data }) => {
    const view = views.get(id)
    if (view) {
      view.term.write(data)
      return
    }
    const chunks = pending.get(id) ?? []
    chunks.push(data)
    if (chunks.length > MAX_PENDING_CHUNKS) chunks.shift()
    pending.set(id, chunks)
  })
  // 智能体起的开发服务器：在后台加一个标签页，不打开终端面板；任务监控「运行中」列着它，点「查看输出」才打开（第 527 步）
  const offOpened = window.diffra.onTerminalOpened(({ id, cwd, shell, devServer }) => {
    if (!views.has(id)) createView(id)
    store.set((state) => ({
      ...state,
      terminals: [...state.terminals, { id, cwd, shell, exitCode: null, devServer: { ...devServer, url: null } }],
      activeTerminal: state.activeTerminal ?? id,
    }))
  })
  const offUrl = window.diffra.onTerminalUrl(({ id, url }) => {
    store.set((state) => ({ ...state, terminals: state.terminals.map((item) => (item.id === id && item.devServer ? { ...item, devServer: { ...item.devServer, url } } : item)) }))
  })
  const offExit = window.diffra.onTerminalExit(({ id, exitCode }) => {
    views.get(id)?.term.write(`\r\n\x1b[2m[进程已退出，代码 ${exitCode}]\x1b[0m\r\n`)
    store.set((state) => ({ ...state, terminals: state.terminals.map((item) => (item.id === id ? { ...item, exitCode } : item)) }))
  })
  // 外观设置写在 <html> 的 class 和 data 属性上，变了就同步终端的配色和字号
  const observer = new MutationObserver(() => {
    const theme = currentTheme()
    const fontSize = currentFontSize()
    for (const [id, view] of views) {
      view.term.options.theme = theme
      view.term.options.fontSize = fontSize
      fitTerminal(id)
    }
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-palette', 'data-font'] })
  return () => {
    offData()
    offOpened()
    offUrl()
    offExit()
    observer.disconnect()
  }
}
