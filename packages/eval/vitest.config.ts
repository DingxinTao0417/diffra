import { defineConfig } from 'vitest/config'

// tasks/ 和 deep-scan/ 里是题目项目，带着各自的测试（node --test、unittest），不归 vitest 跑
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 180_000,
  },
})
