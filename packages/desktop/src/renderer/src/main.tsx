import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_APPEARANCE } from '../../shared/settings'
import { App } from './App'
import { applyAppearance } from './lib/appearance'
import './styles.css'

// 读到设置之前先按默认外观（跟随系统深浅色）显示
applyAppearance(DEFAULT_APPEARANCE)

const container = document.getElementById('root')
if (!container) throw new Error('index.html 缺少 #root 节点')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
