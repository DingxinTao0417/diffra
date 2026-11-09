// 生成 src/renderer/src/lib/lobe-icon-table.ts：@lobehub/icons 里服务类、模型类的图标，加上模型匹配表（modelConfig）用到的图标
// 升级 @lobehub/icons 后重跑：node scripts/gen-lobe-icons.ts
// 只导入 Mono、Color 两个变体：品牌入口还会带上 Text、Combine、Avatar，体积差不多翻倍
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toc } from '@lobehub/icons/es/toc'

const esDir = dirname(fileURLToPath(import.meta.resolve('@lobehub/icons/es/toc')))
const target = resolve(import.meta.dirname, '../src/renderer/src/lib/lobe-icon-table.ts')

const modelConfig = readFileSync(join(esDir, 'features/modelConfig.mjs'), 'utf8')
const mapped = new Set([...modelConfig.matchAll(/from "\.\.\/(\w+)\/index\.mjs"/g)].map((match) => match[1]))
// lobe-icons.tsx 按 Mono 组件的引用反查模型匹配表里的图标，品牌入口导出的不是 Mono 就会全部反查失败
for (const id of mapped) {
  const index = readFileSync(join(esDir, id, 'index.mjs'), 'utf8')
  const exported = index.match(/^const Icons = ([\w$]+);$/m)?.[1]
  if (!exported || !index.includes(`import ${exported} from "./components/Mono.mjs"`)) throw new Error(`${id} 的品牌入口导出的不是 Mono 组件，模型匹配表反查不到它`)
}
const ids = toc.filter((item) => item.group === 'provider' || item.group === 'model' || mapped.has(item.id)).map((item) => item.id)

const imports: string[] = []
const entries: string[] = []
for (const id of ids) {
  if (!/^[A-Za-z]\w*$/.test(id)) throw new Error(`图标 id 不能直接当变量名：${id}`)
  imports.push(`import ${id}Mono from '@lobehub/icons/es/${id}/components/Mono'`)
  if (existsSync(join(esDir, id, 'components/Color.mjs'))) {
    imports.push(`import ${id}Color from '@lobehub/icons/es/${id}/components/Color'`)
    entries.push(`  ${id}: { Mono: ${id}Mono, Color: ${id}Color },`)
  } else {
    entries.push(`  ${id}: { Mono: ${id}Mono },`)
  }
}

const source = [
  '// 由 scripts/gen-lobe-icons.ts 生成，不要手改',
  "import type { IconType } from '@lobehub/icons'",
  ...imports,
  '',
  'export const LOBE_ICONS: Record<string, { Mono: IconType; Color?: IconType }> = {',
  ...entries,
  '}',
  '',
].join('\n')
writeFileSync(target, source)
console.log(`${ids.length} 个图标 → ${target}`)
