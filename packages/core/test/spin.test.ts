import { describe, expect, test } from 'vitest'
import { newSpinTracker, noteCall, noteEdit, noteText, takeSpinReminders } from '../src/session/spin.js'

describe('补充的打转检测', () => {
  test('同一个调用（不管结果）第 6 次提醒一次；成功编辑后重新算', () => {
    const spin = newSpinTracker()
    for (let i = 0; i < 5; i++) noteCall(spin, 'run_command', { command: 'date' })
    expect(takeSpinReminders(spin)).toEqual([])
    noteCall(spin, 'run_command', { command: 'date' })
    expect(takeSpinReminders(spin)).toEqual([expect.stringContaining('same call 6 times')])
    // 同一种只提醒一次
    noteCall(spin, 'run_command', { command: 'date' })
    expect(takeSpinReminders(spin)).toEqual([])
    noteEdit(spin)
    for (let i = 0; i < 6; i++) noteCall(spin, 'run_command', { command: 'date' })
    expect(takeSpinReminders(spin)).toHaveLength(1)
  })

  test('做过事之后连续 12 次只读才提醒；一开始摸代码不算，中间跑了命令重新数', () => {
    const exploring = newSpinTracker()
    for (let i = 0; i < 30; i++) noteCall(exploring, 'read_file', { path: `f${i}.ts` })
    expect(takeSpinReminders(exploring)).toEqual([])

    const spin = newSpinTracker()
    noteEdit(spin)
    for (let i = 0; i < 11; i++) noteCall(spin, 'search', { pattern: `p${i}` })
    noteCall(spin, 'run_command', { command: 'ls' })
    for (let i = 0; i < 11; i++) noteCall(spin, 'read_file', { path: `g${i}.ts` })
    expect(takeSpinReminders(spin)).toEqual([])
    noteCall(spin, 'read_file', { path: 'g11.ts' })
    expect(takeSpinReminders(spin)).toEqual([expect.stringContaining('only read or searched')])
  })

  test('同一段话说了 3 次提醒；很短的话不算，只差空白的算同一段', () => {
    const spin = newSpinTracker()
    const text = '我再看一下这个文件的内容，确认一下刚才的修改有没有问题，然后继续下一步。'
    for (let i = 0; i < 5; i++) noteText(spin, '好的')
    noteText(spin, text)
    noteText(spin, `${text}\n`)
    expect(takeSpinReminders(spin)).toEqual([])
    noteText(spin, `  ${text}`)
    expect(takeSpinReminders(spin)).toEqual([expect.stringContaining('same message 3 times')])
  })
})
