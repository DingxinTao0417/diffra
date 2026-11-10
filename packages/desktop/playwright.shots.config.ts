import { defineConfig } from '@playwright/test'

// 官网截图（scripts/shots/）：不是测试，单独跑，一次一个窗口
export default defineConfig({
  testDir: './scripts/shots',
  testMatch: '*.shots.ts',
  timeout: 300_000,
  workers: 1,
  reporter: 'list',
})
