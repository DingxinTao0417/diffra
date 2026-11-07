import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Configuration } from 'electron-builder'

// 更新地址会写进已安装客户端的 resources/app-update.yml，发布后就不能再改。
// DIFFRA_UPDATE_URL 只在本地验证更新流程时使用，指向临时更新源；正式构建不要设置它。
const updateUrl = process.env.DIFFRA_UPDATE_URL || 'https://update.diffra.dev/win/'

// rg 二进制随 core 的依赖 @vscode/ripgrep 按平台下载；打包时拷到 resources，主进程通过 DIFFRA_RG_PATH 告诉 core
const requireFromCore = createRequire(fileURLToPath(new URL('../core/package.json', import.meta.url)))
const { rgPath } = requireFromCore('@vscode/ripgrep') as { rgPath: string }

const config: Configuration = {
  appId: 'dev.diffra.desktop',
  // 每用户安装的目录名（%LOCALAPPDATA%\Programs\diffra）和更新缓存目录名都取自包名，
  // workspace 包名 @diffra/desktop 会变成 @diffradesktop。和 appId 一样，发布后不能改。
  extraMetadata: { name: 'diffra' },
  directories: { output: 'release' },
  files: ['out/**/*'],
  // 唯一的原生依赖 node-pty 自带 N-API 预编译文件，Electron 直接能用；重编要装 VS 编译工具，而且会失败
  npmRebuild: false,
  extraResources: [{ from: rgPath, to: 'rg.exe' }],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    artifactName: 'Diffra-Setup-${version}.${ext}',
  },
  publish: [{ provider: 'generic', url: updateUrl }],
}

export default config
