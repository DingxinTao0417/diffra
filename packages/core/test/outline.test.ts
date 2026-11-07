import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { findRipgrep } from '../src/environment.js'
import { outlineTool } from '../src/tools/outline.js'
import type { ToolContext } from '../src/tools/types.js'

let project: string
let context: ToolContext

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), 'diffra-outline-'))
  context = {
    cwd: project,
    rgPath: await findRipgrep(),
    bashPath: null,
    signal: new AbortController().signal,
    readHashes: new Map(),
    trustedCommands: [],
    readOnlyPaths: [],
    requestCommandPermission: async () => ({ allowed: true }),
  }
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

const TS_SOURCE = [
  "import { readFile } from 'node:fs/promises'",
  '',
  'export interface User {',
  '  id: string',
  '}',
  '',
  "export type Role = 'admin' | 'member'",
  '',
  'const MAX_USERS = 100',
  '',
  'export const findUser = async (id: string): Promise<User | null> => {',
  '  return null',
  '}',
  '',
  'export class UserService {',
  '  private readonly users = new Map<string, User>()',
  '',
  '  constructor(private readonly path: string) {}',
  '',
  '  async load(): Promise<void> {',
  "    await readFile(this.path, 'utf8')",
  '  }',
  '}',
  '',
  'export default function main(argv: string[]): number {',
  '  return argv.length',
  '}',
  '',
].join('\n')

const PY_SOURCE = [
  'import os',
  '',
  "DATA_DIR = os.environ.get('DATA_DIR', 'data')",
  '',
  '',
  'def load_users(path=DATA_DIR) -> list[dict]:',
  '    return []',
  '',
  '',
  'class Importer(Base):',
  '    def __init__(self, rows):',
  '        self.rows = rows',
  '',
  '    @property',
  '    def count(self) -> int:',
  '        return len(self.rows)',
  '',
  '',
  '@app.get("/users")',
  'async def list_users():',
  '    return []',
  '',
].join('\n')

describe('代码大纲', () => {
  test('TS 文件：接口、类型、常量、函数、类和方法，带行号，不带函数体', async () => {
    writeFileSync(join(project, 'users.ts'), TS_SOURCE)
    const result = await outlineTool(context, { path: 'users.ts' })
    expect(result.text).toBe(
      [
        'users.ts',
        '  3: export interface User',
        "  7: export type Role = 'admin' | 'member'",
        '  9: const MAX_USERS',
        '  11: export const findUser = async (id: string): Promise<User | null> =>',
        '  15: export class UserService',
        '  18:   constructor(private readonly path: string)',
        '  20:   async load(): Promise<void>',
        '  25: export default function main(argv: string[]): number',
      ].join('\n'),
    )
    expect(result.title).toBe('大纲 users.ts')
  })

  test('Python 文件：模块级变量、函数、类和方法，装饰过的也算', async () => {
    writeFileSync(join(project, 'importer.py'), PY_SOURCE)
    const result = await outlineTool(context, { path: 'importer.py' })
    expect(result.text).toBe(
      [
        'importer.py',
        '  3: DATA_DIR',
        '  6: def load_users(path=DATA_DIR) -> list[dict]',
        '  10: class Importer(Base)',
        '  11:   def __init__(self, rows)',
        '  15:   def count(self) -> int',
        '  20: async def list_users()',
      ].join('\n'),
    )
  })

  test('Vue 单文件组件按 <script> 在文件里的行号列出', async () => {
    writeFileSync(join(project, 'Card.vue'), ['<template>', '  <div />', '</template>', '', '<script setup lang="ts">', 'function toggle(open: boolean) {', '  return !open', '}', '</script>', ''].join('\n'))
    const result = await outlineTool(context, { path: 'Card.vue' })
    expect(result.text).toBe(['Card.vue', '  6: function toggle(open: boolean)'].join('\n'))
  })

  test('目录：只列源文件，跳过忽略的文件和密钥文件；不支持的文件给出提示', async () => {
    // 和 list_files 一样，git 仓库里才按 .gitignore 跳过
    execFileSync('git', ['init', '-q'], { cwd: project })
    mkdirSync(join(project, 'src'))
    mkdirSync(join(project, 'node_modules', 'lib'), { recursive: true })
    writeFileSync(join(project, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(project, 'src', 'a.ts'), 'export function a() {}\n')
    writeFileSync(join(project, 'src', 'b.py'), 'def b():\n    pass\n')
    writeFileSync(join(project, 'src', 'notes.md'), '# notes\n')
    writeFileSync(join(project, 'src', '.env.ts'), 'export const key = "x"\n')
    writeFileSync(join(project, 'node_modules', 'lib', 'index.js'), 'function hidden() {}\n')

    const result = await outlineTool(context, { path: '.' })
    expect(result.text).toBe(['src/a.ts', '  1: export function a()', 'src/b.py', '  1: def b()'].join('\n'))
    await expect(outlineTool(context, { path: 'src/notes.md' })).rejects.toThrow('Use read_file')
    await expect(outlineTool(context, { path: 'src/.env.ts' })).rejects.toThrow('protected')
  })
})
