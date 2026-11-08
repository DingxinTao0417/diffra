declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}

// 主进程用 executeJavaScript 调 __diffraDesign；设计页拿不到 window.diffra
interface Window {
  __diffraDesign?: import('./bridge').DesignBridge
  // 设计页 preload 给的唯一能力（src/preload/design.ts）
  diffraDesignHost?: { changed(): void }
}
