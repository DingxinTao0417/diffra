// 引擎在运行时加载 CanvasKit 的 WASM、内置字体和 HarfBuzz；这个模块告诉它去哪取，必须在引擎加载任何东西之前执行
import '@open-pencil/core/runtime-assets/install'
import { createDefaultEditorState, createDocumentGraph, createEditor } from '@open-pencil/core'
import { fontManager } from '@open-pencil/core/text'
import { EDITOR_KEY } from '@open-pencil/vue'
import { createApp, reactive } from 'vue'
import { installBridge } from './bridge'
import DesignApp from './DesignApp.vue'
import { prepareFontsWhenVisible, requestLocalFonts, watchTextFonts } from './fonts'
import { createLocalIcons } from './icons'
import './design.css'

// 主进程把 nativeTheme 设成 Diffra 的外观设置，prefers-color-scheme 跟着它，界面配色随之切深浅色
const darkQuery = matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => document.documentElement.classList.toggle('dark', darkQuery.matches)
applyTheme()
darkQuery.addEventListener('change', applyTheme)
const theme = darkQuery.matches ? 'dark' : 'light'
const graph = createDocumentGraph('design', theme)
const page = graph.getPages()[0]
if (!page) throw new Error('新建的设计文档没有页面')
// 状态交给 Vue 的 reactive，画布和工具栏才能跟着编辑器的变化更新。
// 画布夹在两侧面板之间：缩放到合适大小、居中都按画布本身的尺寸算，不按窗口
const viewportSize = () => {
  const canvas = document.querySelector('canvas')
  return { width: canvas?.clientWidth || window.innerWidth, height: canvas?.clientHeight || window.innerHeight }
}
// 图标用内置的 Lucide 图标数据（设计页断网，拉不到 Iconify 在线接口）
const editor = createEditor({ graph, state: reactive(createDefaultEditorState(page.id)), getViewportSize: viewportSize, icons: createLocalIcons() })

installBridge(editor)
// 主进程只给了这个视图读系统字体的权限；拿到列表后，中文等内置字体没有的字回退到系统字体。
// 回退字体按平台挑（Windows 是微软雅黑等），不告诉它平台时按 Linux 的字体找，Windows 上一个都找不到
fontManager.setFallbackUserAgent(navigator.userAgent)
requestLocalFonts().catch((error: unknown) => console.error('读取系统字体失败', error))
watchTextFonts(editor)
prepareFontsWhenVisible(editor)
// 每次编辑（包括撤销、智能体的修改）都告诉主进程，由它攒一会儿再自动保存
editor.onEditorEvent('history:changed', () => window.diffraDesignHost?.changed())

const app = createApp(DesignApp)
app.provide(EDITOR_KEY, editor)
app.mount('#design')
