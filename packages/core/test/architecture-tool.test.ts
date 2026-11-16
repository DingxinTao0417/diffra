import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { analyzeProject } from '../src/architecture/engine.js'
import { ArchitectureService, projectIdOf } from '../src/architecture/service.js'
import { findRipgrep } from '../src/environment.js'
import { runTurn } from '../src/session/loop.js'
import { makeSession, project, recordingIO, scriptedModel, useTempProject } from './loop-helpers.js'

// 任务里的智能体查架构图（v2 · M9）：分析过的项目才有 architecture 工具，工具读最近一次分析的结果
useTempProject()

let dataDir: string | null = null
afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = null
})

function serviceIn(): ArchitectureService {
  dataDir = mkdtempSync(join(tmpdir(), 'diffra-arch-data-'))
  return new ArchitectureService(dataDir, findRipgrep, () => {})
}

describe('architecture 工具', () => {
  test('没分析过不给工具；分析过给，查依赖和调用拿到 文件:行，卡片标题写查的是什么', async () => {
    writeFileSync(join(project, 'a.ts'), "import { b } from './b'\nexport function a() { return b() }\n")
    writeFileSync(join(project, 'b.ts'), 'export function b() { return 1 }\n')
    const service = serviceIn()
    const model = scriptedModel([
      { toolCalls: [{ name: 'architecture', input: { action: 'dependencies', path: 'a.ts' } }] },
      { toolCalls: [{ name: 'architecture', input: { action: 'callers', path: 'b.ts', symbol: 'b' } }] },
      { text: 'a 依赖 b' },
    ])
    const session = await makeSession(model, undefined, undefined, undefined, undefined, undefined, undefined, { architecture: service })
    expect(Object.keys(session.toolSet())).not.toContain('architecture')

    const { analysis } = await analyzeProject({ projectId: projectIdOf(project), root: project, rgPath: await findRipgrep(), cache: null, signal: new AbortController().signal, onProgress: () => {} })
    mkdirSync(join(dataDir!, projectIdOf(project)), { recursive: true })
    writeFileSync(join(dataDir!, projectIdOf(project), 'analysis.json'), JSON.stringify(analysis))
    expect(Object.keys(session.toolSet())).toContain('architecture')

    const io = recordingIO()
    await runTurn(session, { id: 't', text: 'a 依赖什么' }, io)
    expect(io.updates.some((update) => update.sessionUpdate === 'tool_call' && update.title === '查架构：依赖 a.ts')).toBe(true)
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('b.ts (line 1) names: b')
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('a.ts a (call at a.ts:2)')
  })
})
