import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// 跟随系统的浅色/深色设置
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => document.documentElement.classList.toggle('dark', darkQuery.matches)
applyTheme()
darkQuery.addEventListener('change', applyTheme)

const container = document.getElementById('root')
if (!container) throw new Error('index.html 缺少 #root 节点')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
