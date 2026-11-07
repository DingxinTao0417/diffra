import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  reporter: 'list',
  projects: [
    // 开发版：electron . 启动未打包的应用（pnpm test）
    { name: 'dev' },
    // 打包版：启动 electron-builder 打出来的程序，先打包再跑（pnpm test:packaged）
    { name: 'packaged', metadata: { executable: 'release/win-unpacked/Diffra.exe' } },
  ],
})
