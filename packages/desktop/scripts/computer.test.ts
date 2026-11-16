// 电脑操控（v2 · M5）：按键解析、文字拆分（src/main/computer/keys.ts）；Windows 上真的起一次驱动进程（src/main/computer/driver.ts），
// 只发不动鼠标键盘的命令（ping、读鼠标位置、不认识的命令）。node --test scripts/computer.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ScriptDriver } from '../src/main/computer/driver.ts'
import { macKey, parseKeys, textSegments, windowsKey } from '../src/main/computer/keys.ts'

test('按键：组合键拆成修饰键和主键，别名都认；乱写的、两个主键的报错', () => {
  assert.deepEqual(parseKeys('Ctrl+Shift+T'), { modifiers: ['ctrl', 'shift'], key: 't' })
  assert.deepEqual(parseKeys('cmd+option+Escape'), { modifiers: ['meta', 'alt'], key: 'escape' })
  assert.deepEqual(parseKeys('Enter'), { modifiers: [], key: 'enter' })
  assert.deepEqual(parseKeys('F12'), { modifiers: [], key: 'f12' })
  assert.deepEqual(parseKeys('ArrowDown'), { modifiers: [], key: 'down' })
  assert.deepEqual(parseKeys('Win'), { modifiers: ['meta'], key: null })
  assert.deepEqual(parseKeys('a'), { modifiers: [], key: 'a' })
  assert.throws(() => parseKeys('Ctrl+A+B'), /一次只能按一个主键/)
  assert.throws(() => parseKeys('Ctrl+F13'), /认不出这个键/)
  assert.throws(() => parseKeys('Hyper'), /认不出这个键/)
})

test('键码：Windows 的虚拟键码和扩展键，macOS 的 kVK', () => {
  assert.deepEqual(windowsKey('a'), { vk: 0x41, extended: false })
  assert.deepEqual(windowsKey('5'), { vk: 0x35, extended: false })
  assert.deepEqual(windowsKey('f5'), { vk: 0x74, extended: false })
  assert.deepEqual(windowsKey('left'), { vk: 0x25, extended: true })
  assert.deepEqual(windowsKey('ctrl'), { vk: 0x11, extended: false })
  assert.equal(macKey('c'), 0x08)
  assert.equal(macKey('enter'), 0x24)
  assert.equal(macKey('meta'), 0x37)
  assert.throws(() => macKey('f13'), /认不出这个键/)
})

test('输入的文字：换行、制表符按键发，别的按字符发', () => {
  assert.deepEqual(textSegments('你好\r\nworld\tx'), [{ text: '你好' }, { key: 'enter' }, { text: 'world' }, { key: 'tab' }, { text: 'x' }])
  assert.deepEqual(textSegments('\n'), [{ key: 'enter' }])
})

test('Windows 的驱动进程：起得来，回 ping，读得到鼠标位置，不认识的命令报错，结束后能再起', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diffra-computer-'))
  const driver = new ScriptDriver(dir)
  try {
    assert.equal(await driver.send({ op: 'ping' }), '')
    // 比例是相对主屏算的：鼠标在副屏上时会小于 0 或大于 1（副屏在左边、右边），只要求读得到数
    const cursor = await driver.cursor()
    assert.ok(Number.isFinite(cursor.fx) && Number.isFinite(cursor.fy), JSON.stringify(cursor))
    await assert.rejects(driver.send({ op: 'nope' }), /unknown op nope/)
    driver.dispose()
    assert.equal(await driver.send({ op: 'ping' }), '')
  } finally {
    driver.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
