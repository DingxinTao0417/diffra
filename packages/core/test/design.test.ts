import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { DESIGN_STYLES, type DesignActionResult } from '../src/protocol.js'
import { toBrowserAction } from '../src/session/browser.js'
import { designInstructions, designTools } from '../src/session/design.js'
import { downloadImage, MAX_IMAGE_BYTES, PLACE_IMAGE_TOOL, sniffImage } from '../src/session/design-image.js'
import { runTurn, type TurnIO } from '../src/session/loop.js'
import { Session } from '../src/session/session.js'

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never
type Step = { toolCalls: Array<{ name: string; input: unknown }> } | { text: string }

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }

function scriptedModel(steps: Step[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: steps.map((step, index) => ({
      stream: simulateReadableStream<StreamPart>({
        chunks:
          'text' in step
            ? [
                { type: 'stream-start' as const, warnings: [] },
                { type: 'text-start' as const, id: 't' },
                { type: 'text-delta' as const, id: 't', delta: step.text },
                { type: 'text-end' as const, id: 't' },
                { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
              ]
            : [
                { type: 'stream-start' as const, warnings: [] },
                ...step.toolCalls.map((call, callIndex) => ({ type: 'tool-call' as const, toolCallId: `call-${index}-${callIndex}`, toolName: call.name, input: JSON.stringify(call.input) })),
                { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
              ],
      }),
    })),
  })
}

// 1x1 的 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

let server: Server
let origin: string
const hits: string[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '/'
    hits.push(path)
    const redirect = /^\/hop(\d+)$/.exec(path)
    if (redirect) {
      const left = Number(redirect[1])
      response.writeHead(302, { location: left > 1 ? `/hop${left - 1}` : '/photo.png' })
      response.end()
    } else if (path === '/photo.png') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(PNG)
    } else if (path === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html></html>')
    } else if (path === '/declared-big') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) })
      response.end()
    } else if (path === '/streamed-big') {
      response.writeHead(200, { 'content-type': 'image/png' })
      const chunk = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < 11; i++) response.write(chunk)
      response.end()
    } else if (path === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'image/png' })
        response.end(PNG)
      }, 1000)
    } else if (path === '/not-image') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end('just text')
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

describe('sniffImage', () => {
  test('认出四种格式和像素尺寸，其他内容返回 null', () => {
    expect(sniffImage(PNG)).toEqual({ format: 'png', width: 1, height: 1 })
    const gif = Buffer.from([...Buffer.from('GIF89a'), 0x40, 0x01, 0xf0, 0x00, 0, 0, 0, 0])
    expect(sniffImage(gif)).toEqual({ format: 'gif', width: 320, height: 240 })
    // SOI、一个 APP0 段，然后 SOF0：高 200、宽 300
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x01, 0x2c, 0x03, 0, 0, 0, 0])
    expect(sniffImage(jpeg)).toEqual({ format: 'jpeg', width: 300, height: 200 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0)
    webp.write('WEBP', 8)
    webp.write('VP8X', 12)
    webp.writeUIntLE(639, 24, 3)
    webp.writeUIntLE(479, 27, 3)
    expect(sniffImage(webp)).toEqual({ format: 'webp', width: 640, height: 480 })
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })
})

describe('downloadImage', () => {
  const signal = new AbortController().signal

  test('下载图片，最多跟 3 次跳转', async () => {
    const result = await downloadImage(`${origin}/hop3`, signal)
    expect(result.bytes.equals(PNG)).toBe(true)
    expect(result.finalUrl).toBe(`${origin}/photo.png`)
    await expect(downloadImage(`${origin}/hop4`, signal)).rejects.toThrow('redirected more than 3 times')
  })

  test('网页、超过 10MB（声明的和实际读到的）、超时、非 http 协议都拒绝', async () => {
    await expect(downloadImage(`${origin}/page`, signal)).rejects.toThrow('web page, not an image file')
    await expect(downloadImage(`${origin}/declared-big`, signal)).rejects.toThrow('larger than 10 MB')
    await expect(downloadImage(`${origin}/streamed-big`, signal)).rejects.toThrow('larger than 10 MB')
    await expect(downloadImage(`${origin}/slow`, signal, 200)).rejects.toThrow('took longer than 0.2 seconds')
    await expect(downloadImage('ftp://example.com/a.png', signal)).rejects.toThrow('Only http(s) image URLs')
  })
})

describe('设计任务的放图片工具', () => {
  let project: string
  let outside: string

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'diffra-design-'))
    outside = mkdtempSync(join(tmpdir(), 'diffra-design-outside-'))
  })

  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  function makeSession(steps: Step[], options: { readOnlyPaths?: string[]; designStyle?: string | null } = {}) {
    const session = new Session({
      cwd: project,
      config: {
        model: { endpoint: { protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, modelId: 'mock', contextWindow: 100_000, provider: null },
        reviewModel: null,
        planModel: null,
        fallbackModel: null,
        checks: { afterEdit: null, beforeFinish: null },
        readOnlyPaths: options.readOnlyPaths ?? [],
        rules: { packs: [] },
        permissionMode: 'ask',
        security: {},
        limits: { compactAtPercent: 70, maxSteps: 20, goalMaxRounds: 5 },
        plugins: [],
        design: true,
        designStyle: options.designStyle ?? null,
        checkpointDir: null,
      },
      environment: { bashPath: null, rgPath: 'rg' },
      checkpoints: null,
      rulePacks: [],
      systemPrompt: 'base prompt',
      model: scriptedModel(steps),
    })
    session.design = { tools: [{ name: 'get_node', description: 'Get a node', inputSchema: { type: 'object' }, readOnly: true }], instructions: '' }
    return session
  }

  // 设计页：记下每次调用；get_node 返回原来的图层名
  function designIO(permission: string | null = 'allow_once') {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const io: TurnIO & { updates: SessionUpdate[]; permissions: number } = {
      updates: [],
      permissions: 0,
      update: async (update) => {
        io.updates.push(update)
      },
      requestPermission: async () => {
        io.permissions++
        return permission
      },
      recordUsage: async () => {},
      design: async (tool, args): Promise<DesignActionResult> => {
        calls.push({ tool, args: args as Record<string, unknown> })
        if (tool === 'get_node') return { text: JSON.stringify({ id: '1:2', name: '头图 · assets/old.png' }), image: null }
        return { text: JSON.stringify({ id: '1:2' }), image: null }
      },
    }
    return { io, calls }
  }

  const resultText = (session: Session) =>
    session.messages.flatMap((message) => (message.role === 'tool' ? message.content.flatMap((part) => (part.type === 'tool-result' ? [JSON.stringify(part.output)] : [])) : [])).join('\n')

  test('下载网图：数据不经过模型直接填进节点，副本存到 assets/，图层名带路径和来源', async () => {
    const session = makeSession([{ toolCalls: [{ name: PLACE_IMAGE_TOOL, input: { id: '1:2', source: `${origin}/hop1` } }] }, { text: '好了' }])
    const { io, calls } = designIO()
    await runTurn(session, { id: 't1', text: '换成真实图片' }, io)
    const fill = calls.find((call) => call.tool === 'set_image_fill')
    expect(fill?.args).toEqual({ id: '1:2', image_data: PNG.toString('base64'), scale_mode: 'FILL' })
    const saved = readdirSync(join(project, 'assets'))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatch(/^photo-[0-9a-f]{8}\.png$/)
    expect(readFileSync(join(project, 'assets', saved[0]!)).equals(PNG)).toBe(true)
    expect(calls.find((call) => call.tool === 'rename_node')?.args).toEqual({ id: '1:2', name: `头图 · assets/${saved[0]} · ${origin}/photo.png` })
    expect(resultText(session)).toContain('Placed the 1x1 PNG image into node 1:2')
    // 本地地址不用问
    expect(io.permissions).toBe(0)
    // 给模型的工具里有它，图片数据不在模型的对话里
    expect(Object.keys(designTools(session))).toContain(PLACE_IMAGE_TOOL)
    expect(JSON.stringify(session.messages)).not.toContain(PNG.toString('base64'))
  })

  test('项目里的文件直接用，不另存；项目外的要授权，拒绝了就不读', async () => {
    writeFileSync(join(project, 'logo.png'), PNG)
    writeFileSync(join(outside, 'photo.png'), PNG)
    const session = makeSession([
      { toolCalls: [{ name: PLACE_IMAGE_TOOL, input: { id: '1:2', source: 'logo.png', scale_mode: 'FIT' } }] },
      { toolCalls: [{ name: PLACE_IMAGE_TOOL, input: { id: '1:2', source: join(outside, 'photo.png') } }] },
      { text: '好了' },
    ])
    const { io, calls } = designIO('reject_once')
    await runTurn(session, { id: 't1', text: '放 logo' }, io)
    expect(calls.filter((call) => call.tool === 'set_image_fill').map((call) => call.args.scale_mode)).toEqual(['FIT'])
    expect(calls.find((call) => call.tool === 'rename_node')?.args).toEqual({ id: '1:2', name: '头图 · logo.png' })
    expect(existsSync(join(project, 'assets'))).toBe(false)
    expect(io.permissions).toBe(1)
    expect(resultText(session)).toContain('The user rejected external path access')
  })

  test('assets 是禁写目录时不存副本；不是图片的文件拒绝', async () => {
    const session = makeSession(
      [
        { toolCalls: [{ name: PLACE_IMAGE_TOOL, input: { id: '1:2', source: `${origin}/photo.png` } }] },
        { toolCalls: [{ name: PLACE_IMAGE_TOOL, input: { id: '1:2', source: `${origin}/not-image` } }] },
        { text: '好了' },
      ],
      { readOnlyPaths: ['assets'] },
    )
    const { io, calls } = designIO()
    await runTurn(session, { id: 't1', text: '放图' }, io)
    expect(existsSync(join(project, 'assets'))).toBe(false)
    expect(calls.filter((call) => call.tool === 'set_image_fill')).toHaveLength(1)
    const text = resultText(session)
    expect(text).toContain('Did not save a copy in the project')
    expect(text).toContain('not a PNG, JPEG, WebP or GIF image')
  })

  test('设计说明：工作流、检查工具和找图的说法；选了风格预设才带预设', () => {
    const plain = designInstructions(makeSession([]))
    expect(plain).toContain('Design workflow:')
    expect(plain).toContain('design_lint')
    expect(plain).toContain(PLACE_IMAGE_TOOL)
    expect(plain).not.toContain('Style preset:')
    const styled = designInstructions(makeSession([], { designStyle: 'magazine' }))
    expect(styled).toContain(DESIGN_STYLES.find((style) => style.id === 'magazine')!.instructions)
    expect(designInstructions(makeSession([], { designStyle: 'no-such-style' }))).not.toContain('Style preset:')
  })

  test('浏览器的列图片动作', () => {
    expect(toBrowserAction('browser_images', {})).toEqual({ action: 'images' })
  })
})
