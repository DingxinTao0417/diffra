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
  // 内置 Skill 要是真实文件：模型按索引里的路径用 read_file 读，主进程通过 DIFFRA_SKILLS_DIR 告诉 core
  extraResources: [
    { from: rgPath, to: 'rg.exe' },
    { from: '../core/skills', to: 'skills' },
    // 设计模式打进去的第三方组件（OpenPencil 等）的出处和许可
    { from: 'NOTICE.md', to: 'NOTICE.md' },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    artifactName: 'Diffra-Setup-${version}.${ext}',
    // 非一键向导才会展示目录页；不改变 appId、包名及每用户安装身份。
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    // 卸载时删掉浏览器扩展本机宿主的注册表登记
    include: 'build/installer.nsh',
  },
  publish: [{ provider: 'generic', url: updateUrl }],
}

export default config
