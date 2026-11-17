import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { basename, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ModelRef, Role, Settings } from '../src/shared/settings.ts'

// 主进程由 Vite 解析省略的扩展名，core 源码则以 .js 引用 .ts；这里只为 Node 测试补齐同样的解析。
const desktopSource = new URL('../src/', import.meta.url).href
const coreSource = new URL('../../core/src/', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? ''
    if (parent.startsWith(desktopSource) && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    if (parent.startsWith(coreSource) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
const { SettingsStore } = await import('../src/main/settings-store.ts')
const { ROLES } = await import('../src/shared/settings.ts')
hooks.deregister()

const modelRef = (modelId: string): ModelRef => ({ providerId: 'provider', modelId, reasoningEffort: 'high' })
const legacyRoles = () => ({ coder: modelRef('coder'), planner: modelRef('planner'), reviewer: modelRef('reviewer'), fallback: null })
const collaborationRoles = ['explorer', 'implementer', 'reviewer', 'tester'] as const satisfies readonly Role[]

async function workspace(context: TestContext): Promise<string> {
  const root = await realpath(import.meta.dirname)
  const directory = await mkdtemp(join(root, '.settings-store-test-'))
  context.after(async () => {
    assert.equal((await lstat(directory)).isSymbolicLink(), false)
    assert.equal(await realpath(directory), directory)
    assert.ok(basename(directory).startsWith('.settings-store-test-'))
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

async function legacyStore(context: TestContext) {
  const directory = await workspace(context)
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ version: 1, providers: [], roles: legacyRoles() }))
  return { directory, store: await SettingsStore.open(directory) }
}

test('新设置包含全部协作角色，默认不指定独立模型', async (context) => {
  const store = await SettingsStore.open(await workspace(context))
  assert.equal(store.loadError, null)
  assert.deepEqual(ROLES, ['coder', 'planner', 'explorer', 'implementer', 'reviewer', 'tester', 'fallback'])
  assert.deepEqual(store.get().roles, { coder: null, planner: null, explorer: null, implementer: null, reviewer: null, tester: null, fallback: null })
})

test('旧设置缺少探索、实现和测试时补 null，原角色及思考强度保持', async (context) => {
  const { store } = await legacyStore(context)
  assert.equal(store.loadError, null)
  assert.deepEqual(store.get().roles, { ...legacyRoles(), explorer: null, implementer: null, tester: null })
})

test('保存所有协作角色后重新读取不丢配置，也不改动其他角色', async (context) => {
  const { directory, store } = await legacyStore(context)
  for (const role of collaborationRoles) {
    await store.update((current) => ({ ...current, roles: { ...current.roles, [role]: modelRef(role) } }))
  }
  const expected = { ...legacyRoles(), explorer: modelRef('explorer'), implementer: modelRef('implementer'), tester: modelRef('tester') }
  const reopened = await SettingsStore.open(directory)
  assert.equal(reopened.loadError, null)
  assert.deepEqual(store.get().roles, expected)
  assert.deepEqual(reopened.get().roles, expected)
})

test('旧设置保存其他偏好后，新角色默认值会落盘且原角色保留', async (context) => {
  const { directory, store } = await legacyStore(context)
  await store.update((current) => ({ ...current, lastSeenVersion: 'test-version' }))
  const saved: unknown = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
  assert.ok(typeof saved === 'object' && saved !== null && 'roles' in saved)
  assert.deepEqual(saved.roles, { ...legacyRoles(), explorer: null, implementer: null, tester: null })
  const reopened = await SettingsStore.open(directory)
  assert.equal(reopened.loadError, null)
  assert.equal(reopened.get().lastSeenVersion, 'test-version')
  assert.deepEqual(reopened.get().roles, store.get().roles)
})

test('并发保存不同角色经队列合并，清空单个角色不会丢掉其他选择', async (context) => {
  const directory = await workspace(context)
  const store = await SettingsStore.open(directory)
  await Promise.all(collaborationRoles.map((role) => store.update((current) => ({ ...current, roles: { ...current.roles, [role]: modelRef(role) } }))))
  for (const role of collaborationRoles) assert.deepEqual(store.get().roles[role], modelRef(role))
  await store.update((current) => ({ ...current, roles: { ...current.roles, explorer: null } }))
  const reopened = await SettingsStore.open(directory)
  assert.equal(reopened.get().roles.explorer, null)
  for (const role of ['implementer', 'reviewer', 'tester'] as const) assert.deepEqual(reopened.get().roles[role], modelRef(role))
})

test('新角色配置校验失败时不覆盖已保存的选择', async (context) => {
  const directory = await workspace(context)
  const store = await SettingsStore.open(directory)
  const assign = (current: Settings, role: Role, ref: ModelRef): Settings => ({ ...current, roles: { ...current.roles, [role]: ref } })
  await store.update((current) => assign(current, 'implementer', modelRef('implementer')))
  for (const role of ['explorer', 'implementer', 'tester'] as const) {
    await assert.rejects(store.update((current) => assign(current, role, { providerId: '', modelId: role })), /providerId/)
    await assert.rejects(store.update((current) => assign(current, role, { providerId: 'provider', modelId: '' })), /modelId/)
  }
  const reopened = await SettingsStore.open(directory)
  assert.equal(reopened.loadError, null)
  assert.deepEqual(reopened.get().roles, store.get().roles)
  assert.deepEqual(reopened.get().roles.implementer, modelRef('implementer'))
})
