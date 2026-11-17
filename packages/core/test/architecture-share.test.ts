import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { ArchitectureEvent, TargetArchitecture } from '../src/architecture/model.js'
import { ArchitectureService } from '../src/architecture/service.js'
import { SHARED_JSON, SHARED_MARKDOWN } from '../src/architecture/share.js'
import { findRipgrep } from '../src/environment.js'

// 架构定义放进仓库、和团队共享（v2 · M9）
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const item of cleanup.splice(0)) item()
})

async function analyzed(project: string) {
  const data = mkdtempSync(join(tmpdir(), 'diffra-share-data-'))
  const events: ArchitectureEvent[] = []
  const service = new ArchitectureService(data, findRipgrep, (event) => events.push(event))
  cleanup.push(() => rmSync(data, { recursive: true, force: true }))
  const { id } = await service.add(project)
  await service.analyze(id)
  const deadline = Date.now() + 10_000
  while (!events.some((event) => event.outcome === 'done')) {
    if (Date.now() > deadline) throw new Error('分析没结束')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return { service, id, data }
}

const block = (id: string, name: string, paths: string[]) => ({ id, name, description: '', kind: 'code' as const, paths, packages: [], pinned: true, unverified: false })
const layer = (id: string, name: string, blocks: ReturnType<typeof block>[]) => ({ id, name, description: '', pinned: true, groups: [{ id: `${id}-g`, name: '', pinned: true, blocks }] })

// 一张手画的目标架构：入口在上层、库在下层，加一条禁止的依赖
const TARGET: TargetArchitecture = {
  version: 1,
  updatedAt: '2026-11-15T00:00:00.000Z',
  diagram: {
    kind: 'application',
    source: 'static',
    generatedAt: '2026-11-15T00:00:00.000Z',
    model: null,
    fingerprint: '',
    layers: [layer('top', '入口层', [block('entry', '入口', ['a.ts'])]), layer('bottom', '库', [block('lib', '工具库', ['lib/**'])])],
    sides: [],
    connectors: [{ from: 'top', to: 'bottom', label: '函数调用' }],
    dropped: 0,
  },
  rules: [
    { id: 'r1', kind: 'layers', strict: false },
    { id: 'r2', kind: 'forbid', from: 'lib', to: 'entry', note: '走接口' },
  ],
}

describe('导出到仓库、从仓库导入', () => {
  test('导出写 .diffra/ 下的 JSON 和 Markdown；另一台电脑打开同一个项目看到不一样、导入后一样，本机原来的留备份', { timeout: 30_000 }, async () => {
    const project = mkdtempSync(join(tmpdir(), 'diffra-share-'))
    cleanup.push(() => rmSync(project, { recursive: true, force: true }))
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'shop' }))
    writeFileSync(join(project, 'a.ts'), "import { b } from './lib/b'\nexport const a = b\n")
    writeFileSync(join(project, 'b.ts'), 'export const x = 1\n')

    const mine = await analyzed(project)
    expect(await mine.service.sharedStatus(mine.id)).toEqual({ state: 'none' })
    await mine.service.saveTarget(mine.id, TARGET)
    const { files } = await mine.service.exportShared(mine.id)
    expect(files).toEqual([join(project, SHARED_JSON), join(project, SHARED_MARKDOWN)])
    const json = JSON.parse(readFileSync(join(project, SHARED_JSON), 'utf8'))
    expect(json.format).toBe('diffra-architecture')
    expect(Object.keys(json.diagrams).sort()).toEqual(['application', 'system', 'technology'])
    expect(json.target.rules).toHaveLength(2)
    const markdown = readFileSync(join(project, SHARED_MARKDOWN), 'utf8')
    expect(markdown).toContain('## 应用架构')
    expect(markdown).toContain('```mermaid\nflowchart TB')
    expect(markdown).toContain('## 目标架构')
    expect(markdown).toContain('- 只能依赖同层或下层')
    expect(markdown).toContain('- 「工具库」不许依赖「入口」：走接口')
    expect(markdown).toContain('n_top -->|"函数调用"| n_bottom')
    expect(await mine.service.sharedStatus(mine.id)).toMatchObject({ state: 'present', matches: true, hasTarget: true, diagrams: 3 })

    // 同事的电脑：分析出来的图一样，但没有目标架构 → 不一样，导入后一样
    const theirs = await analyzed(project)
    expect(await theirs.service.sharedStatus(theirs.id)).toMatchObject({ state: 'present', matches: false })
    await theirs.service.importShared(theirs.id)
    expect(await theirs.service.sharedStatus(theirs.id)).toMatchObject({ state: 'present', matches: true })
    expect((await theirs.service.target(theirs.id))?.rules).toHaveLength(2)
    expect(readdirSync(join(theirs.data, theirs.id)).some((name) => name.startsWith('diagrams.json.before-import-'))).toBe(true)
  })

  test('仓库里那份格式不对：说明原因，不导入', { timeout: 30_000 }, async () => {
    const project = mkdtempSync(join(tmpdir(), 'diffra-share-bad-'))
    cleanup.push(() => rmSync(project, { recursive: true, force: true }))
    writeFileSync(join(project, 'a.ts'), 'export const a = 1\n')
    const { service, id } = await analyzed(project)
    mkdirSync(join(project, '.diffra'))
    writeFileSync(join(project, SHARED_JSON), JSON.stringify({ format: 'diffra-architecture', version: 9 }))
    expect(await service.sharedStatus(id)).toMatchObject({ state: 'invalid' })
    await expect(service.importShared(id)).rejects.toThrow('格式不对')
    writeFileSync(join(project, SHARED_JSON), '{ nope')
    expect(await service.sharedStatus(id)).toEqual({ state: 'invalid', error: '.diffra/architecture.json 不是有效的 JSON' })
    expect(existsSync(join(project, SHARED_MARKDOWN))).toBe(false)
  })
})
