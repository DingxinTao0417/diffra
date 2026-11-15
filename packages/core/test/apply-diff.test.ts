import { describe, expect, test } from 'vitest'
import { unifiedToPatch } from '../src/session/apply-diff.js'

// 第 686 步：回答里的 unified diff 换成 apply_patch 的写法
describe('unified diff 转补丁', () => {
  test('改文件：去掉 a/ b/，每段 @@ 换成 @@，增删和上下文行照抄；没有换行那一行的提示不要', () => {
    const diff = ['diff --git a/src/app.ts b/src/app.ts', 'index 1..2 100644', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,3 +1,3 @@', ' const a = 1', '-const b = 2', '+const b = 3', ' export {}', '\\ No newline at end of file', ''].join('\n')
    expect(unifiedToPatch(diff)).toBe(['*** Begin Patch', '*** Update File: src/app.ts', '@@', ' const a = 1', '-const b = 2', '+const b = 3', ' export {}', '*** End Patch'].join('\n'))
  })

  test('新建和删除：/dev/null 那边；几个文件一起；Windows 换行', () => {
    const diff = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+第一行', '+第二行', '--- a/old.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-旧的'].join('\r\n')
    expect(unifiedToPatch(diff)).toBe(['*** Begin Patch', '*** Add File: new.txt', '+第一行', '+第二行', '*** Delete File: old.txt', '*** End Patch'].join('\n'))
  })

  test('没写文件名的不认，说清楚', () => {
    expect(() => unifiedToPatch(['@@ -1 +1 @@', '-a', '+b'].join('\n'))).toThrow('没写文件名')
  })
})
