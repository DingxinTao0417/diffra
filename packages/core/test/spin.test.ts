import { describe, expect, test } from 'vitest'
import { newSpinTracker, noteCall, noteEdit, noteText, takeSpinReminders } from '../src/session/spin.js'

const exec = (cmd: string) => ({ cmd })

describe('补充的打转检测', () => {
  test('同一个调用（不管结果）第 6 次提醒一次；成功编辑后重新算', () => {
    const spin = newSpinTracker()
    for (let i = 0; i < 5; i++) noteCall(spin, 'exec_command', exec('date'))
    expect(takeSpinReminders(spin)).toEqual([])
    noteCall(spin, 'exec_command', exec('date'))
    expect(takeSpinReminders(spin)).toEqual([expect.stringContaining('same call 6 times')])
    // 同一种只提醒一次
    noteCall(spin, 'exec_command', exec('date'))
    expect(takeSpinReminders(spin)).toEqual([])
    noteEdit(spin)
    for (let i = 0; i < 6; i++) noteCall(spin, 'exec_command', exec('date'))
    expect(takeSpinReminders(spin)).toHaveLength(1)
  })

  test('做过事之后连续 12 次只读命令才提醒；一开始摸代码不算，中间跑了别的命令重新数', () => {
    const exploring = newSpinTracker()
    for (let i = 0; i < 30; i++) noteCall(exploring, 'exec_command', exec(`sed -n '1,80p' f${i}.ts`))
    expect(takeSpinReminders(exploring)).toEqual([])

    const spin = newSpinTracker()
    noteEdit(spin)
    for (let i = 0; i < 11; i++) noteCall(spin, 'exec_command', exec(`rg -n p${i} src`))
    noteCall(spin, 'exec_command', exec('npm test'))
    for (let i = 0; i < 11; i++) noteCall(spin, 'exec_command', exec(`cat g${i}.ts`))
    expect(takeSpinReminders(spin)).toEqual([])
    noteCall(spin, 'view_image', { path: 'shot.png' })
    expect(takeSpinReminders(spin)).toEqual([expect.stringContaining('only read or searched')])
  })

  test('轮询后台命令不算只读：等构建跑完时不提醒', () => {
    const spin = newSpinTracker()
    noteEdit(spin)
    for (let i = 0; i < 20; i++) {
      noteCall(spin, 'exec_command', exec(`cat log${i}.txt`))
      noteCall(spin, 'write_stdin', { session_id: 1234, yield_time_ms: 5000 + i })
    }
    expect(takeSpinReminders(spin)).toEqual([])
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
