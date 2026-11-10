// 扩展弹窗：连接状态；把当前标签页交给某个任务或收回；停下正在用浏览器的任务
import { NATIVE_HOST_NAMES } from '../../src/shared/browser-bridge'
import type { PopupRequest, PopupState } from './popup-protocol'

const app = document.getElementById('app')!

const HOST_LABELS: Record<string, string> = { [NATIVE_HOST_NAMES.packaged]: 'Diffra', [NATIVE_HOST_NAMES.development]: 'Diffra（开发版）', [NATIVE_HOST_NAMES.test]: 'Diffra（测试）' }

function ask<T>(request: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(request) as Promise<T>
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

function section(title: string | null, ...children: Array<Node | string>): HTMLElement {
  return el('section', {}, ...(title ? [el('h2', { textContent: title })] : []), ...children)
}

async function render(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const state = await ask<PopupState>({ kind: 'state', tabId: tab?.id ?? null })
  const connected = state.links.filter((link) => link.connected)
  const parts: HTMLElement[] = []

  if (connected.length === 0) {
    const running = state.links.some((link) => link.hostRunning)
    const retry = el('button', { textContent: '重新连接', onclick: () => void ask({ kind: 'retry' }).then(() => setTimeout(() => void render(), 1000)) })
    parts.push(
      section(
        null,
        el('p', {}, el('span', { className: 'dot' }), running ? 'Diffra 没有打开' : '还没连上 Diffra'),
        el('p', { className: 'muted', textContent: running ? '打开 Diffra 后会自动连上。' : '这台电脑上要装着 Diffra，并且打开过一次。装好打开后会自动连上。' }),
        el('p', { className: 'actions' }, retry),
      ),
    )
    app.replaceChildren(...parts)
    return
  }

  parts.push(section(null, ...connected.map((link) => el('p', {}, el('span', { className: 'dot on' }), `已连接 ${HOST_LABELS[link.host] ?? link.host}`))))

  const titleOf = (host: string, sessionId: string) => connected.find((link) => link.host === host)?.tasks.find((task) => task.sessionId === sessionId)?.title ?? '任务'
  const url = tab?.url ?? ''
  if (tab?.id !== undefined) {
    const tabId = tab.id
    if (state.tab) {
      parts.push(
        section(
          '当前标签页',
          el('p', { textContent: `已交给任务「${titleOf(state.tab.host, state.tab.sessionId)}」，智能体会在这里操作。` }),
          el('p', { className: 'actions' }, el('button', { textContent: '收回', onclick: () => void ask({ kind: 'release', tabId }).then(render) })),
        ),
      )
    } else if (!/^https?:/i.test(url)) {
      parts.push(section('当前标签页', el('p', { className: 'muted', textContent: '浏览器自己的页面不能交给 Diffra，打开一个网页再试。' })))
    } else {
      const choices = connected.flatMap((link) => link.tasks.map((task) => ({ host: link.host, task })))
      if (choices.length === 0) {
        parts.push(section('当前标签页', el('p', { className: 'muted', textContent: 'Diffra 里还没有任务。先在 Diffra 里开一个任务，再把这个标签页交给它。' })))
      } else {
        const select = el('select', { ariaLabel: '交给哪个任务' })
        for (const choice of choices) {
          select.append(el('option', { value: `${choice.host}\n${choice.task.sessionId}`, textContent: `${choice.task.running ? '● ' : ''}${choice.task.title}${connected.length > 1 ? `（${HOST_LABELS[choice.host] ?? choice.host}）` : ''}` }))
        }
        const share = el('button', {
          className: 'primary',
          textContent: '交给 Diffra',
          onclick: () => {
            const [host = '', sessionId = ''] = select.value.split('\n')
            void ask({ kind: 'share', host, tabId, sessionId }).then(render)
          },
        })
        parts.push(section('把当前标签页交给任务', el('p', { className: 'muted', textContent: '智能体会用这个标签页里已经登录的状态。' }), select, share))
      }
    }
  }

  if (state.busy.length > 0) {
    parts.push(
      section(
        '正在用浏览器的任务',
        el(
          'ul',
          {},
          ...state.busy.map((item) =>
            el('li', {}, el('span', { textContent: titleOf(item.host, item.sessionId) }), el('button', { textContent: '停止', onclick: () => void ask({ kind: 'stop', host: item.host, sessionId: item.sessionId }).then(render) })),
          ),
        ),
      ),
    )
  }
  parts.push(section(null, el('p', { className: 'muted', textContent: '智能体操作时浏览器顶部会提示「正在调试此浏览器」；点提示条上的「取消」也会让它停下。' })))
  app.replaceChildren(...parts)
}

void render()
