import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { AGENTS_MD_MAX_BYTES, loadProjectDocs, renderProjectDocs } from '../src/session/agents-md.js'
import { knownWorldState, renderWorldState, type WorldState, type WorldStateEntry } from '../src/session/world-state.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffra-agents-md-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('AGENTS.md 查找', () => {
  test('从带 .git 的项目根到任务目录逐级找，每级 AGENTS.override.md 优先，没有 AGENTS.md 时用 CLAUDE.md', async () => {
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'packages', 'app'), { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), '根目录规则\n')
    writeFileSync(join(root, 'packages', 'AGENTS.override.md'), '覆盖规则\n')
    writeFileSync(join(root, 'packages', 'AGENTS.md'), '被覆盖\n')
    writeFileSync(join(root, 'packages', 'app', 'AGENTS.md'), '   \n')
    writeFileSync(join(root, 'packages', 'app', 'CLAUDE.md'), '子目录规则\n')
    // 项目根以上的不读
    const cwd = join(root, 'packages', 'app')
    const loaded = await loadProjectDocs(cwd)
    expect(loaded).toEqual({
      docs: [
        { path: '../../AGENTS.md', text: '根目录规则' },
        { path: '../AGENTS.override.md', text: '覆盖规则' },
        { path: 'CLAUDE.md', text: '子目录规则' },
      ],
      truncated: false,
    })
    expect(renderProjectDocs(cwd, loaded)).toBe(
      `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n--- ../../AGENTS.md ---\n根目录规则\n\n--- ../AGENTS.override.md ---\n覆盖规则\n\n--- CLAUDE.md ---\n子目录规则\n</INSTRUCTIONS>`,
    )
  })

  test('没有 .git 时只看任务目录；合计超过 32 KiB 截断并说明', async () => {
    const cwd = join(root, 'work')
    mkdirSync(cwd)
    writeFileSync(join(root, 'AGENTS.md'), '上一级的不读\n')
    writeFileSync(join(cwd, 'AGENTS.md'), 'x'.repeat(AGENTS_MD_MAX_BYTES + 100))
    const loaded = await loadProjectDocs(cwd)
    expect(loaded.truncated).toBe(true)
    expect(loaded.docs).toHaveLength(1)
    expect(loaded.docs[0]!.text.length).toBeLessThanOrEqual(AGENTS_MD_MAX_BYTES)
    expect(renderProjectDocs(cwd, loaded)).toContain('exceed 32 KiB')
    expect(renderProjectDocs(cwd, await loadProjectDocs(join(root, 'nothing-here')))).toBeNull()
  })
})

describe('世界状态的增量', () => {
  const state = (environment: string, agentsMd: string | null): WorldState => ({ environment, agentsMd })

  test('第一次发全量，没变化不发，变了只发变的那一节', () => {
    const first = renderWorldState(state('<env 1>', '# rules A'), {})
    expect(first?.text).toBe('[Diffra] Context for this task, set by Diffra (not written by the user). Later context updates replace the matching parts.\n\n<env 1>\n\n# rules A')
    expect(renderWorldState(state('<env 1>', '# rules A'), first!.values)).toBeNull()
    expect(renderWorldState(state('<env 2>', '# rules A'), first!.values)).toEqual({ text: '[Diffra] Context update:\n\n<env 2>', values: { environment: '<env 2>' } })
    expect(renderWorldState(state('<env 1>', '# rules B'), first!.values)?.text).toBe(
      '[Diffra] Context update:\n\nThese AGENTS.md instructions replace all previously provided AGENTS.md instructions.\n\n# rules B',
    )
    expect(renderWorldState(state('<env 1>', null), first!.values)?.text).toBe('[Diffra] Context update:\n\nThe previously provided AGENTS.md instructions no longer apply.')
  })

  test('发过的消息被撤销截掉或压缩掉之后，那几节算模型不知道', () => {
    const full: ModelMessage = { role: 'user', content: 'full' }
    const update: ModelMessage = { role: 'user', content: 'update' }
    const log: WorldStateEntry[] = [
      { index: 1, message: full, values: { environment: 'e1', agentsMd: 'a1' } },
      { index: 3, message: update, values: { environment: 'e2' } },
    ]
    const session = { messages: [{ role: 'user', content: 'q' }, full, { role: 'user', content: 'x' }, update] as ModelMessage[], compaction: null, worldStateLog: [...log] }
    expect(knownWorldState(session)).toEqual({ environment: 'e2', agentsMd: 'a1' })
    // 撤销截掉了后面那条
    session.messages = session.messages.slice(0, 3)
    expect(knownWorldState(session)).toEqual({ environment: 'e1', agentsMd: 'a1' })
    // 压缩到第 2 条之后：全量那条也没了
    session.messages.push(update)
    session.worldStateLog = [...log]
    const compacted = { ...session, compaction: { upTo: 2, summary: 's' } }
    expect(knownWorldState(compacted)).toEqual({ environment: 'e2' })
  })
})
