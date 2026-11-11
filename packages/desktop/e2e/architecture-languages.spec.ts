import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { answerOpenDialog } from './flows'
import { launchApp, makeUserDataDir } from './launch'

// 七种语言里要动态加载解析器的 Python、Go、Rust、Java，加上 TS：都能解析、依赖对得上。
// 打包后解析器文件要从 asar 里解出来，这个用例在 packaged 项目里跑才有意义
const FILES: Record<string, string> = {
  'web/package.json': JSON.stringify({ name: 'web' }),
  'web/src/index.ts': "import { format } from './format'\nexport const title = format('x')\n",
  'web/src/format.ts': 'export function format(value: string) {\n  return value\n}\n',
  'goapp/go.mod': 'module example.com/goapp\n\ngo 1.22\n',
  'goapp/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/goapp/store"\n)\n\nfunc main() { fmt.Println(store.Open()) }\n',
  'goapp/store/store.go': 'package store\n\nfunc Open() string { return "" }\n',
  'rs/Cargo.toml': '[package]\nname = "rs-core"\nversion = "0.1.0"\n',
  'rs/src/lib.rs': 'mod util;\nuse std::collections::HashMap;\npub fn run() -> HashMap<String, String> { util::helper(); HashMap::new() }\n',
  'rs/src/util.rs': 'pub fn helper() {}\n',
  'java/pom.xml': '<project><artifactId>jsvc</artifactId></project>',
  'java/src/main/java/com/acme/App.java': 'package com.acme;\n\nimport com.acme.data.Repo;\nimport java.util.List;\n\npublic class App {\n  public static void main(String[] args) { new Repo(); }\n}\n',
  'java/src/main/java/com/acme/data/Repo.java': 'package com.acme.data;\n\npublic class Repo {}\n',
  'py/pyproject.toml': '[project]\nname = "pysvc"\n',
  'py/src/pysvc/__init__.py': '',
  'py/src/pysvc/cli.py': 'import os\nfrom .db import connect\n\ndef main():\n    connect()\n',
  'py/src/pysvc/db.py': 'def connect():\n    return None\n',
}

test('架构：Python、Go、Rust、Java、TS 都能深度解析，依赖和语言自带的库对得上', async () => {
  test.setTimeout(120_000)
  const userDataDir = makeUserDataDir()
  const project = mkdtempSync(join(tmpdir(), 'diffra-e2e-arch-lang-'))
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(project, path)), { recursive: true })
    writeFileSync(join(project, path), content)
  }
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.getByTestId('sidebar').getByRole('button', { name: '架构', exact: true }).click()
    await answerOpenDialog(app, project)
    await window.getByRole('button', { name: '选择文件夹', exact: true }).click()
    const card = window.getByTestId('architecture-card')
    await expect(card.getByText('循环依赖')).toBeVisible({ timeout: 60_000 })
    await card.click()

    // 11 个代码文件全部深度解析；每种语言里的项目内依赖都对上了
    await window.getByRole('radio', { name: '概览', exact: true }).click()
    await expect(window.getByTestId('architecture-overview')).toContainText('深度解析了 11 个文件')
    await expect(window.getByTestId('architecture-stats')).toContainText('5文件之间的依赖')
    await expect(window.getByTestId('architecture-stats')).toContainText('0没对上的导入')

    // 技术架构图的最底层：五种语言和它们自带的库
    await window.getByRole('radio', { name: '架构图', exact: true }).click()
    await window.getByRole('radio', { name: '技术架构', exact: true }).click()
    const diagram = window.getByTestId('block-diagram')
    for (const name of ['Go', 'Rust', 'Java', 'Python', 'TypeScript', 'Go 标准库', 'Rust 标准库', 'Java 标准库', 'Python 标准库']) {
      await expect(diagram.getByTestId('diagram-block').filter({ has: window.getByText(name, { exact: true }) })).toHaveCount(1)
    }
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
