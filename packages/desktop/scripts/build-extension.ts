// 打包 Diffra 浏览器扩展。
//   node scripts/build-extension.ts           开发版：out/browser-extension，清单带固定 key，加载解压的扩展时 ID 不变
//   node scripts/build-extension.ts --store   商店版：out/browser-extension-store，去掉 key（商店不收），再打成 release/ 下的 zip
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const source = join(root, 'browser-extension')
const store = process.argv.includes('--store')
const outDir = join(root, 'out', store ? 'browser-extension-store' : 'browser-extension')

rmSync(outDir, { recursive: true, force: true })
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    modulePreload: false,
    rolldownOptions: {
      input: { background: join(source, 'src', 'background.ts'), popup: join(source, 'src', 'popup.ts') },
      output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name].js' },
    },
  },
})

const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as Record<string, unknown>
if (!store) manifest.key = readFileSync(join(source, 'development-key.txt'), 'utf8').trim()
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
cpSync(join(source, 'popup.html'), join(outDir, 'popup.html'))
cpSync(join(source, 'icons'), join(outDir, 'icons'), { recursive: true })

if (store) {
  const release = join(root, 'release')
  mkdirSync(release, { recursive: true })
  const zip = join(release, `diffra-browser-extension-${String(manifest.version)}.zip`)
  rmSync(zip, { force: true })
  // Windows 10 起自带的 bsdtar：-a 按扩展名打成 zip；文件直接放在 zip 根目录，商店要求清单在根目录。
  // 写全路径：Git Bash 里 PATH 上的 tar 是 GNU tar，会把 D: 当成远程主机
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, ['-a', '-cf', zip, ...readdirSync(outDir)], { cwd: outDir, stdio: 'inherit' })
  console.log(`扩展商店包：${zip}`)
} else {
  console.log(`扩展（开发版，加载解压的扩展选这个文件夹）：${outDir}`)
}
