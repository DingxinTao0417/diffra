import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { enhancePrompt } from '../src/prompt-enhance.js'
import { startScriptedServer } from './scripted-server.js'

let project: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'diffra-enhance-'))
  writeFileSync(join(project, 'a.txt'), 'alpha\n')
  mkdirSync(join(project, 'src'))
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

const modelAt = (baseUrl: string) => ({ endpoint: { protocol: 'openai-compatible' as const, baseUrl, apiKey: 'k' }, modelId: 'm', contextWindow: null, provider: null })

describe('优化提示词', () => {
  test('带着项目顶层和附件问一次模型，拿回改写稿和问题；默认答案那一行一定在改写稿里', async () => {
    const server = await startScriptedServer([
      {
        toolCalls: [
          {
            name: 'submit_prompt',
            input: {
              prompt: '把 @a.txt 里的 alpha 改成大写。\n改完跑一遍测试。',
              questions: [{ question: '只改这一个文件吗？', options: [{ label: '只改它', text: '只改 a.txt，别的文件不动。' }, { label: '全局', text: '项目里所有 alpha 都改。' }] }],
            },
          },
        ],
      },
    ])
    try {
      const result = await enhancePrompt({ model: modelAt(server.baseUrl), text: '改一下 @a.txt', cwd: project, mentions: ['@a.txt'], design: false }, null)
      expect(result.prompt).toBe('把 @a.txt 里的 alpha 改成大写。\n改完跑一遍测试。\n只改 a.txt，别的文件不动。')
      expect(result.questions).toHaveLength(1)
      expect(result.usage).not.toBeNull()
      const body = server.bodies[0]!
      expect(body).toContain('Top level of the project: ')
      expect(body).toContain('a.txt')
      expect(body).toContain('src/')
      expect(body).toContain('Attachments (keep these tokens exactly): @a.txt')
      expect(body).toContain('改一下 @a.txt')
      expect(body).toContain('"tool_choice":{"type":"function","function":{"name":"submit_prompt"}}')
    } finally {
      await server.close()
    }
  })

  test('服务不接受指定工具的 tool_choice（DeepSeek 思考模式）：改用 auto 再问一次', async () => {
    const server = await startScriptedServer(
      [{ toolCalls: [{ name: 'submit_prompt', input: { prompt: '把 alpha 改成大写。', questions: [] } }] }],
      { rejectForcedToolChoice: true },
    )
    try {
      const result = await enhancePrompt({ model: modelAt(server.baseUrl), text: '改一下', cwd: null, mentions: [], design: false }, null)
      expect(result.prompt).toBe('把 alpha 改成大写。')
      expect(server.rejected()).toBe(1)
      expect(server.bodies).toHaveLength(1)
      expect(server.bodies[0]).toContain('"tool_choice":"auto"')
    } finally {
      await server.close()
    }
  })

  test('模型没调 submit_prompt：报错，不给半截结果', async () => {
    const server = await startScriptedServer([{ text: '我觉得挺好的' }])
    try {
      await expect(enhancePrompt({ model: modelAt(server.baseUrl), text: '改一下', cwd: null, mentions: [], design: false }, null)).rejects.toThrow('模型没有给出优化后的提示词')
    } finally {
      await server.close()
    }
  })
})
