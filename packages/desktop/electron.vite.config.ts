import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { openPencil } from '@open-pencil/core/node/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'electron-vite'

// OpenPencil 引擎间接依赖 @acemir/cssom（core → dom-css → cssom）。它的 browser 字段指向一个不导出任何东西的全局脚本
// （var CSSOM = …），按浏览器解析会缺 parse；改用它的 CommonJS 入口。pnpm 下桌面端直接解析不到它，顺着依赖链找
const resolveFrom = (from: string, id: string) => createRequire(from).resolve(id)
const cssomEntry = resolveFrom(resolveFrom(resolveFrom(import.meta.filename, '@open-pencil/core'), '@open-pencil/dom-css'), '@acemir/cssom')

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // core 以独立子进程运行：打成 out/main/core.js，由主进程 spawn。
          core: resolve(import.meta.dirname, '../core/src/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        // design：设计页的 preload，只有一个通知通道（见 src/preload/design.ts）
        input: {
          index: resolve(import.meta.dirname, 'src/preload/index.ts'),
          design: resolve(import.meta.dirname, 'src/preload/design.ts'),
        },
        // 本包是 "type": "module"，electron-vite 默认会把 preload 打成 ESM；沙箱里的 preload 只能是 CJS。
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src/renderer/src'),
        '@acemir/cssom': cssomEntry,
        // @lobehub/icons 的 peer 依赖，没有安装，指到占位模块（见文件里的说明）
        '@lobehub/ui': resolve(import.meta.dirname, 'src/renderer/src/lib/lobe-ui-shim.tsx'),
      },
    },
    build: {
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          // 设计页（OpenPencil 矢量编辑器，Vue）单独一个页面：要放开 WASM 和 eval，不能和主界面共用 CSP
          design: resolve(import.meta.dirname, 'src/renderer/design.html'),
        },
        // @lobehub/icons 每个组件文件都带 "use client"，打包时逐个告警上千条；这里不是 React Server Components，指令没有意义
        checks: { moduleLevelDirective: false },
      },
    },
    // Vue 编译出的虚拟模块（App.vue?vue&lang.ts）也以 .ts 结尾，不能让 React 插件处理
    // inject: false：引擎资源只在设计页的入口里装，主界面不加载
    plugins: [react({ exclude: [/\.vue/, /\/node_modules\//] }), vue(), tailwindcss(), openPencil({ inject: false })],
  },
})
