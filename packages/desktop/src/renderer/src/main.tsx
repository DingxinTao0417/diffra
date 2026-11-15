import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_APPEARANCE } from '../../shared/settings'
import { App } from './App'
import { AppErrorBoundary } from './features/shell/AppErrorBoundary'
import { applyAppearance } from './lib/appearance'
import { reportRendererError, watchUncaughtErrors } from './lib/error-report'
import './styles.css'

// 读到设置之前先按默认外观（跟随系统深浅色）显示
applyAppearance(DEFAULT_APPEARANCE)
watchUncaughtErrors()

const container = document.getElementById('root')
if (!container) throw new Error('index.html 缺少 #root 节点')

// 传了这两个回调 React 就不再自己打到控制台，照样打一份
const onRenderError = (error: unknown, info: { componentStack?: string }) => {
  console.error(error)
  reportRendererError('render', error, info.componentStack)
}

createRoot(container, { onCaughtError: onRenderError, onUncaughtError: onRenderError }).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
