import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { macKey, type Modifier, windowsKey } from './keys.ts'

// 电脑操控（v2 · M5）的鼠标键盘：一个常驻的子进程，标准输入一行一条 JSON 命令，标准输出一行一个「OK …」或「ERR 原因」。
// Windows 用 PowerShell 编一段调 SendInput 的 C#；macOS 用 osascript 跑 JXA 调 CoreGraphics（输入文字用 System Events）。
// 不加原生依赖。不引 Electron（截屏在 host.ts），scripts/computer.test.ts 在 Windows 上直接测这个进程（只做不动鼠标的命令）
const READY_TIMEOUT_MS = 20_000
const OP_TIMEOUT_MS = 10_000

// 主屏幕上的一个点：fx、fy 是占屏幕宽高的比例（Windows 按比例发绝对坐标，和缩放无关），x、y 是逻辑像素（macOS 用）
export interface ScreenPoint {
  fx: number
  fy: number
  x: number
  y: number
}

export interface InputDriver {
  move(point: ScreenPoint): Promise<void>
  // clicks：第几下（双击的第二下是 2，macOS 要这个才认成双击）
  button(button: 'left' | 'right', down: boolean, clicks: number): Promise<void>
  // 滚轮格数：dy 正数往下，dx 正数往右
  wheel(dx: number, dy: number): Promise<void>
  // 规范化的键名（见 keys.ts），或者修饰键
  key(key: string, down: boolean): Promise<void>
  text(text: string): Promise<void>
  cursor(): Promise<{ fx: number; fy: number }>
  dispose(): void
}

const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
public static class DiffraInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  static void Send(INPUT input) {
    if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("SendInput failed (" + Marshal.GetLastWin32Error() + "), a window running as administrator may be in front");
  }
  static INPUT Mouse(int dx, int dy, uint data, uint flags) { INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; return i; }
  public static void Move(double fx, double fy) { Send(Mouse((int)Math.Round(fx * 65535), (int)Math.Round(fy * 65535), 0, 0x0001 | 0x8000)); }
  public static void Button(string button, bool down) { uint flag = button == "right" ? (down ? 0x0008u : 0x0010u) : (down ? 0x0002u : 0x0004u); Send(Mouse(0, 0, 0, flag)); }
  public static void Wheel(int delta, bool horizontal) { Send(Mouse(0, 0, unchecked((uint)delta), horizontal ? 0x1000u : 0x0800u)); }
  public static void Key(ushort vk, bool extended, bool down) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = (extended ? 0x0001u : 0u) | (down ? 0u : 0x0002u); Send(i); }
  public static void Text(string text) {
    foreach (char c in text) {
      INPUT down = new INPUT(); down.type = 1; down.u.ki.wScan = c; down.u.ki.dwFlags = 0x0004u; Send(down);
      INPUT up = new INPUT(); up.type = 1; up.u.ki.wScan = c; up.u.ki.dwFlags = 0x0004u | 0x0002u; Send(up);
    }
  }
  public static string Cursor() {
    POINT p; GetCursorPos(out p);
    double w = Math.Max(1, GetSystemMetrics(0) - 1), h = Math.Max(1, GetSystemMetrics(1) - 1);
    return (p.X / w).ToString(CultureInfo.InvariantCulture) + " " + (p.Y / h).ToString(CultureInfo.InvariantCulture);
  }
}
'@
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $c = ConvertFrom-Json $line
    $reply = 'OK'
    switch ($c.op) {
      'move' { [DiffraInput]::Move([double]$c.fx, [double]$c.fy) }
      'button' { [DiffraInput]::Button([string]$c.button, [bool]$c.down) }
      'wheel' { [DiffraInput]::Wheel([int]$c.delta, [bool]$c.horizontal) }
      'key' { [DiffraInput]::Key([uint16]$c.vk, [bool]$c.extended, [bool]$c.down) }
      'text' { [DiffraInput]::Text([string]$c.text) }
      'cursor' { $reply = 'OK ' + [DiffraInput]::Cursor() }
      'ping' { }
      default { throw ('unknown op ' + $c.op) }
    }
    [Console]::Out.WriteLine($reply)
  } catch {
    [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '[\\r\\n]+', ' '))
  }
  [Console]::Out.Flush()
}
`

const MAC_SCRIPT = `ObjC.import('Cocoa')
ObjC.import('CoreGraphics')
const output = $.NSFileHandle.fileHandleWithStandardOutput
const input = $.NSFileHandle.fileHandleWithStandardInput
function reply(text) { output.writeData($(text + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)) }
const FLAGS = { shift: $.kCGEventFlagMaskShift, ctrl: $.kCGEventFlagMaskControl, alt: $.kCGEventFlagMaskAlternate, meta: $.kCGEventFlagMaskCommand }
const bounds = $.CGDisplayBounds($.CGMainDisplayID())
let flags = 0
let position = $.CGPointMake(0, 0)
let pressed = null
function post(event) { $.CGEventPost($.kCGHIDEventTap, event) }
function handle(c) {
  switch (c.op) {
    case 'move': {
      position = $.CGPointMake(c.x, c.y)
      const type = pressed === 'left' ? $.kCGEventLeftMouseDragged : pressed === 'right' ? $.kCGEventRightMouseDragged : $.kCGEventMouseMoved
      const event = $.CGEventCreateMouseEvent(null, type, position, pressed === 'right' ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft)
      $.CGEventSetFlags(event, flags)
      post(event)
      return 'OK'
    }
    case 'button': {
      const right = c.button === 'right'
      const type = right ? (c.down ? $.kCGEventRightMouseDown : $.kCGEventRightMouseUp) : c.down ? $.kCGEventLeftMouseDown : $.kCGEventLeftMouseUp
      const event = $.CGEventCreateMouseEvent(null, type, position, right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft)
      $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, c.clicks)
      $.CGEventSetFlags(event, flags)
      post(event)
      pressed = c.down ? c.button : null
      return 'OK'
    }
    case 'wheel': {
      post($.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, -c.dy, -c.dx))
      return 'OK'
    }
    case 'key': {
      if (c.modifier) flags = c.down ? flags | FLAGS[c.modifier] : flags & ~FLAGS[c.modifier]
      const event = $.CGEventCreateKeyboardEvent(null, c.code, c.down)
      $.CGEventSetFlags(event, flags)
      post(event)
      return 'OK'
    }
    case 'text': {
      Application('System Events').keystroke(c.text)
      return 'OK'
    }
    case 'cursor': {
      const point = $.CGEventGetLocation($.CGEventCreate(null))
      return 'OK ' + ((point.x - bounds.origin.x) / bounds.size.width) + ' ' + ((point.y - bounds.origin.y) / bounds.size.height)
    }
    case 'ping':
      return 'OK'
  }
  throw new Error('unknown op ' + c.op)
}
reply('READY')
let buffer = ''
for (;;) {
  const data = input.availableData
  if (data.length === 0) break
  buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    try {
      reply(handle(JSON.parse(line)))
    } catch (error) {
      reply('ERR ' + String((error && error.message) || error).replace(/\\s+/g, ' '))
    }
  }
}
`

type Encoded = Record<string, unknown>

interface Platform {
  file: string
  script: string
  command(path: string): { command: string; args: string[] }
  key(key: string, down: boolean): Encoded
  button(button: 'left' | 'right', down: boolean, clicks: number): Encoded
  wheel(dx: number, dy: number): Encoded[]
  move(point: ScreenPoint): Encoded
}

const MODIFIERS = new Set<string>(['ctrl', 'shift', 'alt', 'meta'])

const WINDOWS: Platform = {
  file: 'diffra-input.ps1',
  script: WINDOWS_SCRIPT,
  command: (path) => ({ command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path] }),
  key: (key, down) => ({ op: 'key', ...windowsKey(key), down }),
  button: (button, down) => ({ op: 'button', button, down }),
  // 一格 120；往上滚是正数
  wheel: (dx, dy) => [...(dy ? [{ op: 'wheel', delta: -dy * 120, horizontal: false }] : []), ...(dx ? [{ op: 'wheel', delta: dx * 120, horizontal: true }] : [])],
  move: (point) => ({ op: 'move', fx: point.fx, fy: point.fy }),
}

const MAC: Platform = {
  file: 'diffra-input.js',
  script: MAC_SCRIPT,
  command: (path) => ({ command: '/usr/bin/osascript', args: ['-l', 'JavaScript', path] }),
  key: (key, down) => ({ op: 'key', code: macKey(key), down, ...(MODIFIERS.has(key) ? { modifier: key as Modifier } : {}) }),
  button: (button, down, clicks) => ({ op: 'button', button, down, clicks }),
  wheel: (dx, dy) => [{ op: 'wheel', dx, dy }],
  move: (point) => ({ op: 'move', x: point.x, y: point.y }),
}

export function platformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

// 常驻子进程：命令按顺序一条条发，每条最多等 10 秒；超时、退出了就结束它，下次用时重新起
export class ScriptDriver implements InputDriver {
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private buffer = ''
  private readonly replies: string[] = []
  private waiter: ((line: string | null) => void) | null = null
  private queue: Promise<unknown> = Promise.resolve()
  // 不用构造参数属性：scripts 下的测试直接用 Node 跑这个文件，Node 只去掉类型、不认这种写法
  private readonly dir: string
  private readonly platform: Platform

  constructor(dir: string, platform: Platform = process.platform === 'darwin' ? MAC : WINDOWS) {
    this.dir = dir
    this.platform = platform
  }

  private start(): Promise<void> {
    this.starting ??= (async () => {
      await mkdir(this.dir, { recursive: true })
      const path = join(this.dir, this.platform.file)
      await writeFile(path, this.platform.script, 'utf8')
      const { command, args } = this.platform.command(path)
      const child = spawn(command, args, { windowsHide: true, stdio: 'pipe' })
      this.child = child
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.receive(chunk))
      child.stderr.on('data', () => {})
      child.stdin.on('error', () => {})
      child.once('exit', () => {
        if (this.child === child) this.reset()
      })
      const ready = await this.next(READY_TIMEOUT_MS)
      if (ready !== 'READY') {
        this.dispose()
        throw new Error(ready === null ? '鼠标键盘的驱动没启动起来' : `鼠标键盘的驱动启动失败：${ready}`)
      }
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private reset(): void {
    this.child = null
    this.buffer = ''
    this.replies.length = 0
    const waiter = this.waiter
    this.waiter = null
    waiter?.(null)
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      const waiter = this.waiter
      if (waiter) {
        this.waiter = null
        waiter(line)
      } else this.replies.push(line)
    }
  }

  private next(timeoutMs: number): Promise<string | null> {
    const queued = this.replies.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null
        resolve(null)
      }, timeoutMs)
      this.waiter = (line) => {
        clearTimeout(timer)
        resolve(line)
      }
    })
  }

  send(command: Encoded): Promise<string> {
    const run = async () => {
      if (!this.child) await this.start()
      const child = this.child
      if (!child) throw new Error('鼠标键盘的驱动没启动起来')
      child.stdin.write(`${JSON.stringify(command)}\n`)
      const reply = await this.next(OP_TIMEOUT_MS)
      if (reply === null) {
        this.dispose()
        throw new Error(`鼠标键盘的驱动 ${OP_TIMEOUT_MS / 1000} 秒没有回应`)
      }
      if (reply.startsWith('ERR')) throw new Error(reply.slice(3).trim() || '驱动报错')
      return reply.slice(2).trim()
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return result
  }

  async move(point: ScreenPoint): Promise<void> {
    await this.send(this.platform.move(point))
  }

  async button(button: 'left' | 'right', down: boolean, clicks: number): Promise<void> {
    await this.send(this.platform.button(button, down, clicks))
  }

  async wheel(dx: number, dy: number): Promise<void> {
    for (const command of this.platform.wheel(dx, dy)) await this.send(command)
  }

  async key(key: string, down: boolean): Promise<void> {
    await this.send(this.platform.key(key, down))
  }

  async text(text: string): Promise<void> {
    await this.send({ op: 'text', text })
  }

  async cursor(): Promise<{ fx: number; fy: number }> {
    const [fx, fy] = (await this.send({ op: 'cursor' })).split(' ').map(Number)
    if (fx === undefined || fy === undefined || !Number.isFinite(fx) || !Number.isFinite(fy)) throw new Error('读不到鼠标位置')
    return { fx, fy }
  }

  dispose(): void {
    const child = this.child
    this.reset()
    child?.kill()
  }
}

// e2e 用的假驱动：不动真的鼠标键盘，把收到的操作一行一条记进文件
export class FakeDriver implements InputDriver {
  private position = { fx: 0.5, fy: 0.5 }
  private readonly log: string

  constructor(log: string) {
    this.log = log
  }

  private record(entry: Record<string, unknown>): void {
    appendFileSync(this.log, `${JSON.stringify(entry)}\n`)
  }

  async move(point: ScreenPoint): Promise<void> {
    this.position = { fx: point.fx, fy: point.fy }
    this.record({ op: 'move', x: Math.round(point.x), y: Math.round(point.y) })
  }

  async button(button: 'left' | 'right', down: boolean, clicks: number): Promise<void> {
    this.record({ op: 'button', button, down, clicks })
  }

  async wheel(dx: number, dy: number): Promise<void> {
    this.record({ op: 'wheel', dx, dy })
  }

  async key(key: string, down: boolean): Promise<void> {
    this.record({ op: 'key', key, down })
  }

  async text(text: string): Promise<void> {
    this.record({ op: 'text', text })
  }

  async cursor(): Promise<{ fx: number; fy: number }> {
    return this.position
  }

  dispose(): void {}
}
