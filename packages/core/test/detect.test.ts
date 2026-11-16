import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgent } from '../src/agent.js'
import { connectToCore, detectProjectChecks, handshake, runProjectCheck } from '../src/client.js'
import { detectChecks, hasFrontend } from '../src/project/detect.js'

let project: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'diffra-detect-'))
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

function write(path: string, content: string | object = ''): void {
  const target = join(project, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content))
}

describe('识别检查命令', () => {
  test('pnpm 项目用现成的脚本；vitest 加 --run，免得进入监听模式', async () => {
    write('pnpm-lock.yaml')
    write('package.json', { scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest' }, devDependencies: { vitest: '^3' } })
    const result = await detectChecks(project)
    expect(result.afterEdit).toBe('pnpm run typecheck && pnpm run lint')
    expect(result.beforeFinish).toBe('pnpm run typecheck && pnpm run lint && pnpm run test --run')
    expect(result.checks.map((item) => item.script)).toEqual(['tsc --noEmit', 'eslint .', 'vitest'])
  })

  test('会改文件的 lint 脚本、npm 的占位 test 不选；没有 typecheck 脚本时用项目里装的 tsc', async () => {
    write('package-lock.json')
    write('tsconfig.json', '{}')
    write('package.json', {
      scripts: { lint: 'eslint . --fix', test: 'echo "Error: no test specified" && exit 1' },
      devDependencies: { typescript: '^5' },
    })
    const result = await detectChecks(project)
    expect(result.afterEdit).toBe('npx --no-install tsc --noEmit')
    expect(result.beforeFinish).toBeNull()
    expect(result.notes.join('\n')).toContain('lint 会改文件')
    expect(result.notes.join('\n')).toContain('占位')
  })

  test('yarn 的 Vue 项目：vue-tsc、有配置的 eslint、jest', async () => {
    write('yarn.lock')
    write('eslint.config.js', 'export default []')
    write('package.json', { devDependencies: { 'vue-tsc': '^2', eslint: '^9', jest: '^29' } })
    const result = await detectChecks(project)
    expect(result.checks.map((item) => item.command)).toEqual(['yarn vue-tsc --noEmit', 'yarn eslint .', 'yarn jest'])
  })

  test('监听模式的测试脚本不选；packageManager 字段优先于锁文件', async () => {
    write('package-lock.json')
    write('package.json', { packageManager: 'pnpm@11.0.0', scripts: { typecheck: 'tsc', test: 'react-scripts test' } })
    const result = await detectChecks(project)
    expect(result.afterEdit).toBe('pnpm run typecheck')
    expect(result.beforeFinish).toBeNull()
    expect(result.notes.join('\n')).toContain('监听模式')
  })

  test('Python 项目用虚拟环境里的解释器；配了但没装进虚拟环境的工具不选', async () => {
    write('pyproject.toml', '[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[dependency-groups]\ndev = ["mypy", "pytest"]\n')
    write('tests/test_app.py', 'def test_ok():\n    assert True\n')
    write('.venv/Scripts/python.exe')
    mkdirSync(join(project, '.venv/Lib/site-packages/ruff'), { recursive: true })
    mkdirSync(join(project, '.venv/Lib/site-packages/pytest'), { recursive: true })
    const result = await detectChecks(project)
    if (process.platform === 'win32') {
      expect(result.afterEdit).toBe('.venv/Scripts/python.exe -m ruff check .')
      expect(result.beforeFinish).toBe('.venv/Scripts/python.exe -m ruff check . && .venv/Scripts/python.exe -m pytest -q')
      expect(result.notes.join('\n')).toContain('配置了 mypy，但 .venv 里没装')
    }
  })

  test('没有可识别的配置时什么都不选', async () => {
    write('README.md', '# hi')
    expect(await detectChecks(project)).toEqual({ checks: [], afterEdit: null, beforeFinish: null, notes: [] })
  })
})

describe('识别检查命令：Java（v2 的 Java 适配器）', () => {
  // 不依赖本机装没装 JDK、Maven、Gradle：PATH 指到一个造出来的目录
  function fakeBin(...names: string[]): NodeJS.ProcessEnv {
    const bin = mkdtempSync(join(tmpdir(), 'diffra-detect-bin-'))
    for (const name of names) {
      const file = join(bin, process.platform === 'win32' ? `${name}.cmd` : name)
      writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 })
    }
    // 常见安装位置也指到这里，不受本机用户目录里装的东西影响
    return { PATH: bin, PATHEXT: '.CMD;.EXE', HOME: bin, USERPROFILE: bin, APPDATA: bin, LOCALAPPDATA: bin, ProgramFiles: bin }
  }

  test('Maven：有 mvnw 用 mvnw；编译、配了的 PMD（带 p3c）和测试都选上；多模块写进说明', async () => {
    write('mvnw', '#!/bin/sh\n')
    write(
      'pom.xml',
      `<project><modules><module>shop-api</module><module>shop-service</module></modules>
      <build><plugins><plugin><artifactId>maven-pmd-plugin</artifactId><dependencies><dependency><groupId>com.alibaba.p3c</groupId><artifactId>p3c-pmd</artifactId></dependency></dependencies></plugin></plugins></build>
      <dependencies><dependency><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>`,
    )
    const result = await detectChecks(project, fakeBin('java'))
    expect(result.checks.map((item) => [item.kind, item.command])).toEqual([
      ['typecheck', './mvnw -q -B -DskipTests test-compile'],
      ['lint', './mvnw -q -B pmd:check'],
      ['test', './mvnw -q -B test'],
    ])
    expect(result.checks[1]!.source).toContain('p3c-pmd')
    expect(result.afterEdit).toBe('./mvnw -q -B -DskipTests test-compile && ./mvnw -q -B pmd:check')
    expect(result.notes).toContain('Maven 多模块项目：shop-api、shop-service')
    expect(result.notes.join('\n')).not.toContain('p3c-pmd（阿里巴巴 Java 开发手册的规则）没有配置')
  })

  test('Maven 没配 p3c：不拿它当检查，说明怎么加；没装 mvn、java 时说明，不报错', async () => {
    write('pom.xml', '<project><artifactId>demo</artifactId></project>')
    write('src/test/java/demo/AppTest.java', 'class AppTest {}')
    const result = await detectChecks(project, fakeBin())
    expect(result.checks.map((item) => item.command)).toEqual(['mvn -q -B -DskipTests test-compile', 'mvn -q -B test'])
    const notes = result.notes.join('\n')
    expect(notes).toContain('没找到 java（JDK）')
    expect(notes).toContain('没找到 mvn，项目里也没有 mvnw')
    expect(notes).toContain('可选：p3c-pmd')
  })

  test('Gradle（Kotlin DSL）多模块：用 gradlew，checkstyle 插件选上，没有测试时不选 test', async () => {
    write('gradlew', '#!/bin/sh\n')
    write('settings.gradle.kts', 'rootProject.name = "shop"\ninclude("api", ":service")\n')
    write('build.gradle.kts', 'plugins {\n  java\n  id("checkstyle")\n}\n')
    const result = await detectChecks(project, fakeBin('java'))
    expect(result.checks.map((item) => [item.kind, item.command])).toEqual([
      ['typecheck', './gradlew -q testClasses'],
      ['lint', './gradlew -q checkstyleMain'],
    ])
    expect(result.notes).toContain('Gradle 多模块项目：api、service')
    expect(result.notes.join('\n')).toContain('没有选用 gradle test')
    expect(result.notes.join('\n')).toContain('可选：p3c-pmd')
  })

  test('Groovy 的 apply plugin 写法也认；配了 p3c 的 pmd 插件选上 pmdMain', async () => {
    write('build.gradle', "apply plugin: 'java'\napply plugin: 'pmd'\ndependencies {\n  pmd 'com.alibaba.p3c:p3c-pmd:2.1.1'\n  testImplementation 'junit:junit:4.13'\n}\n")
    const result = await detectChecks(project, fakeBin('java', 'gradle'))
    expect(result.checks.map((item) => item.command)).toEqual(['gradle -q testClasses', 'gradle -q pmdMain', 'gradle -q test'])
    expect(result.notes.join('\n')).not.toContain('没找到')
  })
})

describe('识别前端项目', () => {
  test('有组件、页面模板或样式文件就算，扩展名不分大小写', () => {
    expect(hasFrontend(['src/App.tsx'])).toBe(true)
    expect(hasFrontend(['web/src/Home.vue'])).toBe(true)
    expect(hasFrontend(['app/templates/index.html'])).toBe(true)
    expect(hasFrontend(['static/Site.CSS'])).toBe(true)
    expect(hasFrontend(['src/main.ts', 'server.py', 'README.md'])).toBe(false)
    expect(hasFrontend([])).toBe(false)
  })
})

describe('经过 agent 识别和试运行', () => {
  test('识别结果和试运行的通过、失败', async () => {
    write('package.json', { scripts: { lint: 'eslint .' } })
    const toAgent = new PassThrough()
    const toClient = new PassThrough()
    createAgent().connect(acp.ndJsonStream(Writable.toWeb(toClient), Readable.toWeb(toAgent)))
    const connection = connectToCore(toAgent, toClient)
    await handshake(connection, 5000)

    expect((await detectProjectChecks(connection, project)).afterEdit).toBe('npm run lint')
    expect(await runProjectCheck(connection, project, 'echo check-ok')).toEqual({ passed: true, summary: expect.stringContaining('check-ok') })
    expect((await runProjectCheck(connection, project, 'exit 3')).passed).toBe(false)
    await expect(detectProjectChecks(connection, join(project, 'missing'))).rejects.toThrow('项目目录不存在')
  })
})
