import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { ArchitectureEvent } from '../src/architecture/model.js'
import { ArchitectureService, watchedChange } from '../src/architecture/service.js'
import { findRipgrep } from '../src/environment.js'

// 监听文件变化（v2 · M9）：打开着的项目代码一改就说过期，开了自动更新就重新分析
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const item of cleanup.splice(0)) item()
})

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等太久了')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function setup() {
  const project = mkdtempSync(join(tmpdir(), 'diffra-watch-'))
  const data = mkdtempSync(join(tmpdir(), 'diffra-watch-data-'))
  writeFileSync(join(project, 'a.ts'), "import { b } from './b'\nexport const a = b\n")
  writeFileSync(join(project, 'b.ts'), 'export const b = 1\n')
  mkdirSync(join(project, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(project, 'node_modules', 'x', 'index.js'), 'module.exports = 1\n')
  const events: ArchitectureEvent[] = []
  const service = new ArchitectureService(data, findRipgrep, (event) => events.push(event))
  cleanup.push(() => {
    service.dispose()
    rmSync(project, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  })
  const { id } = await service.add(project)
  await service.analyze(id)
  await until(() => events.some((event) => event.outcome === 'done'))
  events.length = 0
  return { project, data, service, id, events }
}

describe('监听文件变化', () => {
  test('哪些变化算：代码文件和清单，不算依赖、构建目录和别的文件', () => {
    expect(watchedChange('src/a.ts')).toBe(true)
    expect(watchedChange('src\\deep\\B.java')).toBe(true)
    expect(watchedChange('package.json')).toBe(true)
    expect(watchedChange('tsconfig.base.json')).toBe(true)
    expect(watchedChange('node_modules/x/index.js')).toBe(false)
    expect(watchedChange('.git/index')).toBe(false)
    expect(watchedChange('dist/app.js')).toBe(false)
    expect(watchedChange('README.md')).toBe(false)
    expect(watchedChange(null)).toBe(true)
  })

  test('改了代码说过期；依赖目录里的改动不算；关掉监听后不再说', { timeout: 30_000 }, async () => {
    const { project, service, id, events } = await setup()
    await service.watch(id, true, false)
    writeFileSync(join(project, 'node_modules', 'x', 'index.js'), 'module.exports = 2\n')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(events.filter((event) => event.stale !== undefined)).toEqual([])

    writeFileSync(join(project, 'b.ts'), 'export const b = 2\nexport const c = 3\n')
    await until(() => events.some((event) => event.stale === true))
    // 没开自动更新：不重新分析
    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(events.some((event) => event.progress !== null)).toBe(false)

    service.unwatch(id)
    events.length = 0
    writeFileSync(join(project, 'a.ts'), 'export const a = 1\n')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(events).toEqual([])
  })

  test('开了自动更新：改动停下后重新分析，记在项目列表里', { timeout: 30_000 }, async () => {
    const { project, data, service, id, events } = await setup()
    await service.watch(id, true, true)
    expect((await service.project(id)).autoRefresh).toBe(true)
    expect(JSON.parse(readFileSync(join(data, 'projects.json'), 'utf8')).projects[0].autoRefresh).toBe(true)
    writeFileSync(join(project, 'c.ts'), "import { a } from './a'\nexport const c = a\n")
    await until(() => events.some((event) => event.outcome === 'done'), 15_000)
    const analysis = await service.analysis(id)
    expect(analysis?.files.map((file) => file.path)).toContain('c.ts')
    expect(await service.stale(id)).toBe(false)
  })
})
