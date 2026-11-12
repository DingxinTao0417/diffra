// node-pty 在 Mac 上靠 spawn-helper 拉起 shell，但 npm 包里的这个文件没有执行权限，
// 装下来直接用会报「posix_spawnp failed」，底部终端、开发服务器、远程终端都打不开。
// pnpm install 后补上执行权限；打包时 electron-builder 照原样拷贝，安装包里的也就对了。只在 Mac 上做，Windows 不碰
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

if (process.platform === 'darwin') {
  const root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  const candidates = [join(root, 'build', 'Release', 'spawn-helper')]
  const prebuilds = join(root, 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) if (dir.startsWith('darwin-')) candidates.push(join(prebuilds, dir, 'spawn-helper'))
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue
    if ((statSync(file).mode & 0o111) === 0o111) continue
    chmodSync(file, 0o755)
    console.log(`node-pty：给 ${file} 加上执行权限`)
  }
}
