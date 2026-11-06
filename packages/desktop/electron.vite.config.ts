import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

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
        // 本包是 "type": "module"，electron-vite 默认会把 preload 打成 ESM；沙箱里的 preload 只能是 CJS。
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { '@': resolve(import.meta.dirname, 'src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
  },
})
