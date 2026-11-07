import { access, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { CheckDetection, DetectedCheck } from '../protocol.js'

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

export interface PackageJson {
  packageManager?: unknown
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
}

const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check-types', 'tsc']
// 会改文件或进入监听模式的脚本不能当检查命令
const MODIFIES_FILES = /--fix\b|--write\b|\bprettier\b.*\s-w\b/
const WATCH_MODE = /--watch\b|\breact-scripts test\b|\bng test\b/
// npm init 生成的占位 test 脚本
const PLACEHOLDER_TEST = /no test specified/

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// 只读项目文件，不执行任何命令；识别结果要用户确认后才会保存成检查命令
export async function detectChecks(cwd: string): Promise<CheckDetection> {
  const checks: DetectedCheck[] = []
  const notes: string[] = []
  await detectNode(cwd, checks, notes)
  await detectPython(cwd, checks, notes)
  const chain = (items: DetectedCheck[]) => (items.length > 0 ? items.map((item) => item.command).join(' && ') : null)
  const quick = checks.filter((item) => item.kind !== 'test')
  const tests = checks.filter((item) => item.kind === 'test')
  return {
    checks,
    afterEdit: chain(quick),
    // 只有快速检查时完成检查留空，运行时会用快速检查
    beforeFinish: tests.length > 0 ? chain([...quick, ...tests]) : null,
    notes,
  }
}

async function detectNode(cwd: string, checks: DetectedCheck[], notes: string[]): Promise<void> {
  const raw = await readText(join(cwd, 'package.json'))
  if (raw === null) return
  let pkg: PackageJson
  try {
    pkg = JSON.parse(raw) as PackageJson
  } catch {
    notes.push('package.json 不是合法的 JSON，跳过了 JS/TS 的检查')
    return
  }
  const pm = await packageManagerOf(cwd, pkg)
  const scripts = Object.fromEntries(
    Object.entries(pkg.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
  const usable = (name: string): string | null => {
    const body = scripts[name]
    if (body === undefined) return null
    if (MODIFIES_FILES.test(body)) {
      notes.push(`脚本 ${name} 会改文件（${body}），没有选用`)
      return null
    }
    if (WATCH_MODE.test(body)) {
      notes.push(`脚本 ${name} 会进入监听模式（${body}），没有选用`)
      return null
    }
    return body
  }

  const typecheckScript = TYPECHECK_SCRIPTS.find((name) => usable(name) !== null)
  if (typecheckScript) {
    checks.push({ kind: 'typecheck', command: runScript(pm, typecheckScript), source: `package.json 的 ${typecheckScript} 脚本`, script: scripts[typecheckScript] ?? null })
  } else if (deps.has('vue-tsc')) {
    checks.push({ kind: 'typecheck', command: execBin(pm, 'vue-tsc --noEmit'), source: '项目依赖里有 vue-tsc', script: null })
  } else if (deps.has('typescript') && (await exists(join(cwd, 'tsconfig.json')))) {
    checks.push({ kind: 'typecheck', command: execBin(pm, 'tsc --noEmit'), source: '项目依赖里有 typescript，并且有 tsconfig.json', script: null })
  }

  if (usable('lint') !== null) {
    checks.push({ kind: 'lint', command: runScript(pm, 'lint'), source: 'package.json 的 lint 脚本', script: scripts.lint ?? null })
  } else if (scripts.lint === undefined && deps.has('eslint') && (await hasEslintConfig(cwd, raw))) {
    checks.push({ kind: 'lint', command: execBin(pm, 'eslint .'), source: '项目依赖里有 eslint，并且有 eslint 配置', script: null })
  }

  const testBody = scripts.test
  if (testBody !== undefined && PLACEHOLDER_TEST.test(testBody)) {
    notes.push('test 脚本是 npm 生成的占位命令，没有选用')
  } else if (usable('test') !== null && testBody !== undefined) {
    // vitest 在不是终端的环境里默认只跑一次，显式加 --run 更稳。参数传给脚本时 npm 要先加 --，pnpm、yarn、bun 直接跟在后面
    const command = /\bvitest\b(?!\s+run)/.test(testBody) ? `${runScript(pm, 'test')}${pm === 'npm' ? ' --' : ''} --run` : runScript(pm, 'test')
    checks.push({ kind: 'test', command, source: 'package.json 的 test 脚本', script: testBody })
  } else if (testBody === undefined && deps.has('vitest')) {
    checks.push({ kind: 'test', command: execBin(pm, 'vitest run'), source: '项目依赖里有 vitest', script: null })
  } else if (testBody === undefined && deps.has('jest')) {
    checks.push({ kind: 'test', command: execBin(pm, 'jest'), source: '项目依赖里有 jest', script: null })
  }
}

// 开发服务器的启动命令：package.json 里的 dev、start 或 serve 脚本
export async function detectDevCommand(cwd: string): Promise<string | null> {
  const raw = await readText(join(cwd, 'package.json'))
  if (raw === null) return null
  let pkg: PackageJson
  try {
    pkg = JSON.parse(raw) as PackageJson
  } catch {
    return null
  }
  const script = ['dev', 'start', 'serve'].find((name) => typeof pkg.scripts?.[name] === 'string')
  return script ? runScript(await packageManagerOf(cwd, pkg), script) : null
}

// 有界面代码的项目：组件、页面模板或样式文件。系统提示词据此加上前端的做法
const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html', '.htm', '.css', '.scss', '.sass', '.less'])

export function hasFrontend(files: string[]): boolean {
  return files.some((file) => UI_EXTENSIONS.has(extname(file).toLowerCase()))
}

export async function packageManagerOf(cwd: string, pkg: PackageJson): Promise<PackageManager> {
  if (typeof pkg.packageManager === 'string') {
    const name = pkg.packageManager.split('@')[0]
    if (name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun') return name
  }
  if (await exists(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(join(cwd, 'yarn.lock'))) return 'yarn'
  if ((await exists(join(cwd, 'bun.lockb'))) || (await exists(join(cwd, 'bun.lock')))) return 'bun'
  return 'npm'
}

function runScript(pm: PackageManager, name: string): string {
  return pm === 'yarn' ? `yarn ${name}` : `${pm} run ${name}`
}

// 运行项目里已经装好的命令行工具；npx 加 --no-install，没装时不会去下载
function execBin(pm: PackageManager, command: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm exec ${command}`
    case 'yarn':
      return `yarn ${command}`
    case 'bun':
      return `bunx --no-install ${command}`
    case 'npm':
      return `npx --no-install ${command}`
  }
}

const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
]

async function hasEslintConfig(cwd: string, packageJson: string): Promise<boolean> {
  if (packageJson.includes('"eslintConfig"')) return true
  for (const name of ESLINT_CONFIGS) if (await exists(join(cwd, name))) return true
  return false
}

const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'setup.py', 'setup.cfg']

async function detectPython(cwd: string, checks: DetectedCheck[], notes: string[]): Promise<void> {
  const present = await Promise.all(PYTHON_MARKERS.map((name) => exists(join(cwd, name))))
  if (!present.some(Boolean)) return
  // 所有相关配置拼在一起，按工具名查有没有用到
  const texts = await Promise.all(
    [...PYTHON_MARKERS, 'requirements/dev.txt', 'ruff.toml', '.ruff.toml', 'mypy.ini', 'pytest.ini', 'pyrightconfig.json', 'tox.ini'].map(async (name) => ({
      name,
      text: await readText(join(cwd, name)),
    })),
  )
  const found = new Set(texts.filter((item) => item.text !== null).map((item) => item.name))
  const config = texts.map((item) => item.text ?? '').join('\n')
  const mentions = (tool: string) => new RegExp(`(^|[^\\w-])${tool}([^\\w-]|$)`, 'm').test(config)

  const venv = (await firstExisting(cwd, ['.venv', 'venv'])) ?? null
  const python = venv ? await venvPython(cwd, venv) : null
  const run = (module: string) => `${python ?? 'python'} -m ${module}`
  // 有虚拟环境时，配了但没装进去的工具不选，免得检查一直失败
  const installed = async (pkg: string) => !venv || process.platform !== 'win32' || exists(join(cwd, venv, 'Lib', 'site-packages', pkg))

  const pick = async (kind: DetectedCheck['kind'], tool: string, args: string, configured: boolean): Promise<boolean> => {
    if (!configured) return false
    if (!(await installed(tool))) {
      notes.push(`配置了 ${tool}，但 ${venv} 里没装，没有选用`)
      return false
    }
    checks.push({ kind, command: run(`${tool} ${args}`.trim()), source: `项目配置里用到了 ${tool}`, script: null })
    return true
  }
  await pick('lint', 'ruff', 'check .', mentions('ruff') || found.has('ruff.toml') || found.has('.ruff.toml'))
  if (!(await pick('typecheck', 'mypy', '.', mentions('mypy') || found.has('mypy.ini')))) {
    await pick('typecheck', 'pyright', '', mentions('pyright') || found.has('pyrightconfig.json'))
  }
  const hasTests = (await exists(join(cwd, 'tests'))) || (await exists(join(cwd, 'test')))
  if (hasTests) await pick('test', 'pytest', '-q', mentions('pytest') || found.has('pytest.ini'))
  if (!python && checks.some((item) => item.command.startsWith('python '))) {
    notes.push('没找到项目的虚拟环境（.venv 或 venv），检查命令用的是系统的 python')
  }
}

// 项目虚拟环境里的 python（相对项目根目录、正斜杠），没有虚拟环境时为 null
export async function projectPython(cwd: string): Promise<string | null> {
  const venv = await firstExisting(cwd, ['.venv', 'venv'])
  return venv ? venvPython(cwd, venv) : null
}

async function firstExisting(cwd: string, names: string[]): Promise<string | null> {
  for (const name of names) if (await exists(join(cwd, name))) return name
  return null
}

// 检查命令在 Git Bash 里跑，路径用正斜杠
async function venvPython(cwd: string, venv: string): Promise<string | null> {
  for (const relative of [`${venv}/Scripts/python.exe`, `${venv}/bin/python`]) {
    if (await exists(join(cwd, relative))) return relative
  }
  return null
}
