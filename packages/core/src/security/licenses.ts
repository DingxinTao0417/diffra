import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type PackageJson, projectPython } from '../project/detect.js'
import type { DependencyLicense, LicenseKind, LicenseReport } from '../protocol.js'

export type { DependencyLicense, LicenseKind, LicenseReport }

// 依赖的许可证（v2 · M10）：只读本机已经装好的依赖（node_modules、项目虚拟环境、Go 模块缓存），不联网。
// 按许可证对项目的约束分三类：宽松（MIT、BSD、Apache……）、弱传染（LGPL、MPL、EPL：改了这个库要开源它）、
// 强传染（GPL、AGPL、SSPL：用了它整个项目可能要按同样的许可证开源）；认不出的单列，要人看



const MAX_DEPENDENCIES = 3000

export function classifyLicense(raw: string | null): LicenseKind {
  if (!raw) return 'unknown'
  const text = raw.toUpperCase()
  // SPDX 表达式里有 OR 时取最宽松的那个（使用者可以选）；AND 时取最严的
  if (/\sOR\s/.test(text)) {
    const kinds = text.replace(/[()]/g, '').split(/\s+OR\s+/).map((part) => classifyLicense(part))
    return (['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown'] as LicenseKind[]).find((kind) => kinds.includes(kind)) ?? 'unknown'
  }
  if (/AGPL|SSPL|(^|[^L])GPL|GNU GENERAL PUBLIC|AFFERO|EUPL|OSL-|CC-BY-SA|CC-BY-NC/.test(text)) return 'strong-copyleft'
  if (/LGPL|LESSER GENERAL|MPL|MOZILLA|EPL|ECLIPSE|CDDL|CPL/.test(text)) return 'weak-copyleft'
  if (/MIT|BSD|APACHE|ISC|ZLIB|UNLICENSE|0BSD|CC0|PYTHON|PSF|WTFPL|BLUEOAK|ARTISTIC|BOOST|BSL-1\.0|X11|HPND|PUBLIC DOMAIN|MIT-0/.test(text)) return 'permissive'
  return 'unknown'
}

// LICENSE 文件正文认个大概：看开头几段里的许可证名字
function licenseFromText(text: string): string | null {
  const head = text.slice(0, 3000)
  const known: Array<[RegExp, string]> = [
    [/GNU AFFERO GENERAL PUBLIC LICENSE/i, 'AGPL-3.0'],
    [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL'],
    [/GNU GENERAL PUBLIC LICENSE/i, 'GPL'],
    [/Server Side Public License/i, 'SSPL-1.0'],
    [/Mozilla Public License/i, 'MPL-2.0'],
    [/Eclipse Public License/i, 'EPL'],
    [/Apache License/i, 'Apache-2.0'],
    [/Permission is hereby granted, free of charge/i, 'MIT'],
    [/Redistribution and use in source and binary forms/i, 'BSD'],
    [/Permission to use, copy, modify, and\/or distribute this software for any purpose/i, 'ISC'],
    [/This is free and unencumbered software released into the public domain/i, 'Unlicense'],
  ]
  return known.find(([pattern]) => pattern.test(head))?.[1] ?? null
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

async function licenseFile(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => [] as string[])
  const file = names.find((name) => /^(LICEN[CS]E|COPYING)(\.|$)/i.test(name))
  if (!file) return null
  const text = await readText(join(dir, file))
  return text ? licenseFromText(text) : null
}

function npmLicense(pkg: PackageJson & { license?: unknown; licenses?: unknown }): string | null {
  if (typeof pkg.license === 'string') return /^SEE LICEN[CS]E IN/i.test(pkg.license) ? null : pkg.license
  if (pkg.license && typeof pkg.license === 'object' && 'type' in pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.flatMap((item: unknown) => (item && typeof item === 'object' && 'type' in item && typeof item.type === 'string' ? [item.type] : []))
    if (types.length > 0) return types.join(' OR ')
  }
  return null
}

async function projectLicense(cwd: string): Promise<string | null> {
  const pkg = await readText(join(cwd, 'package.json'))
  if (pkg) {
    try {
      const license = npmLicense(JSON.parse(pkg) as PackageJson)
      if (license) return license
    } catch {
      // 清单写坏了就看 LICENSE 文件
    }
  }
  return licenseFile(cwd)
}

// package.json 里声明的直接依赖（根目录和 packages/*、apps/* 下的子包），到 node_modules 里读许可证
async function npmDependencies(cwd: string, report: LicenseReport, only: Set<string> | null): Promise<void> {
  const manifests = ['package.json']
  for (const group of ['packages', 'apps']) {
    for (const name of await readdir(join(cwd, group)).catch(() => [] as string[])) if (existsSync(join(cwd, group, name, 'package.json'))) manifests.push(`${group}/${name}/package.json`)
  }
  let missing = 0
  for (const manifest of manifests) {
    const text = await readText(join(cwd, manifest))
    if (!text) continue
    let pkg: PackageJson & { optionalDependencies?: Record<string, unknown> }
    try {
      pkg = JSON.parse(text) as PackageJson & { optionalDependencies?: Record<string, unknown> }
    } catch {
      report.notes.push(`${manifest} 不是有效的 JSON`)
      continue
    }
    const dir = manifest === 'package.json' ? cwd : join(cwd, manifest, '..')
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })) {
      if (only && !only.has(name)) continue
      if (report.dependencies.some((item) => item.ecosystem === 'npm' && item.name === name)) continue
      if (report.dependencies.length >= MAX_DEPENDENCIES) return
      const installed = [join(dir, 'node_modules', name, 'package.json'), join(cwd, 'node_modules', name, 'package.json')].find((path) => existsSync(path))
      if (!installed) {
        missing++
        continue
      }
      const meta = JSON.parse((await readText(installed)) ?? '{}') as PackageJson & { version?: string }
      const license = npmLicense(meta) ?? (await licenseFile(join(installed, '..')))
      report.dependencies.push({ name, version: meta.version ?? null, ecosystem: 'npm', license, kind: classifyLicense(license), declaredIn: manifest })
    }
  }
  if (missing > 0) report.notes.push(`${missing} 个 npm 依赖还没装（node_modules 里没有），装好后才能查许可证`)
}

// 项目虚拟环境里装的包：*.dist-info/METADATA 的 License-Expression、License 或分类里的许可证
async function pythonDependencies(cwd: string, report: LicenseReport, only: Set<string> | null): Promise<void> {
  const python = await projectPython(cwd)
  if (!python) return
  const venv = ['.venv', 'venv'].map((name) => join(cwd, name)).find((path) => existsSync(path))
  if (!venv) return
  const libs = process.platform === 'win32' ? [join(venv, 'Lib', 'site-packages')] : (await readdir(join(venv, 'lib')).catch(() => [] as string[])).map((name) => join(venv, 'lib', name, 'site-packages'))
  for (const site of libs) {
    for (const entry of await readdir(site).catch(() => [] as string[])) {
      if (!entry.endsWith('.dist-info')) continue
      const metadata = await readText(join(site, entry, 'METADATA'))
      if (!metadata) continue
      const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'mi').exec(metadata)?.[1]?.trim() ?? null
      const name = field('Name')
      if (!name || (only && !only.has(name.toLowerCase().replace(/[._]/g, '-')))) continue
      if (/^(pip|setuptools|wheel)$/i.test(name)) continue
      const classifiers = [...metadata.matchAll(/^Classifier:\s*License :: (?:OSI Approved :: )?(.+)$/gim)].map((match) => match[1]!.trim())
      const declared = field('License-Expression') ?? field('License')
      const license = declared && declared.length < 80 && !/^UNKNOWN$/i.test(declared) ? declared : classifiers.length > 0 ? classifiers.join(' OR ') : null
      report.dependencies.push({ name, version: field('Version'), ecosystem: 'python', license, kind: classifyLicense(license), declaredIn: 'venv' })
      if (report.dependencies.length >= MAX_DEPENDENCIES) return
    }
  }
}

// go.mod 的 require，到模块缓存里找 LICENSE 文件（模块路径里的大写字母在缓存里写成 !小写）
async function goDependencies(cwd: string, report: LicenseReport, only: Set<string> | null): Promise<void> {
  const gomod = await readText(join(cwd, 'go.mod'))
  if (!gomod) return
  const cache = process.env.GOMODCACHE || join(process.env.GOPATH || join(homedir(), 'go'), 'pkg', 'mod')
  const requires = [...gomod.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)].map((match) => ({ name: match[1]!, version: match[2]! }))
  let missing = 0
  for (const { name, version } of requires) {
    if (only && !only.has(name)) continue
    const dir = join(cache, `${name.replace(/[A-Z]/g, (char) => `!${char.toLowerCase()}`)}@${version}`)
    if (!existsSync(dir)) {
      missing++
      continue
    }
    const license = await licenseFile(dir)
    report.dependencies.push({ name, version, ecosystem: 'go', license, kind: classifyLicense(license), declaredIn: 'go.mod' })
  }
  if (missing > 0) report.notes.push(`${missing} 个 Go 模块不在本机的模块缓存里（先 go mod download），没查许可证`)
}

// only：只查这些依赖（完成前查本轮新加的）；名字按各生态的写法，Python 小写
export async function scanLicenses(cwd: string, only: Set<string> | null = null): Promise<LicenseReport> {
  const report: LicenseReport = { project: await projectLicense(cwd), dependencies: [], notes: [] }
  await npmDependencies(cwd, report, only)
  await pythonDependencies(cwd, report, only)
  await goDependencies(cwd, report, only)
  report.dependencies.sort((a, b) => kindRank(b.kind) - kindRank(a.kind) || a.name.localeCompare(b.name))
  return report
}

function kindRank(kind: LicenseKind): number {
  return { 'strong-copyleft': 3, unknown: 2, 'weak-copyleft': 1, permissive: 0 }[kind]
}

// 项目本身是 GPL/AGPL 这类时，依赖强传染的许可证不算问题
export function projectIsCopyleft(project: string | null): boolean {
  return classifyLicense(project) === 'strong-copyleft'
}
