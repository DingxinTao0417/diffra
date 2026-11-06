import type { Configuration } from 'electron-builder'

// 更新地址会写进已安装客户端的 resources/app-update.yml，发布后就不能再改。
// DIFFRA_UPDATE_URL 只在本地验证更新流程时使用，指向临时更新源；正式构建不要设置它。
const updateUrl = process.env.DIFFRA_UPDATE_URL || 'https://update.diffra.net/win/'

const config: Configuration = {
  appId: 'dev.diffra.desktop',
  // 每用户安装的目录名（%LOCALAPPDATA%\Programs\diffra）和更新缓存目录名都取自包名，
  // workspace 包名 @diffra/desktop 会变成 @diffradesktop。和 appId 一样，发布后不能改。
  extraMetadata: { name: 'diffra' },
  directories: { output: 'release' },
  files: ['out/**/*'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    artifactName: 'Diffra-Setup-${version}.${ext}',
  },
  publish: [{ provider: 'generic', url: updateUrl }],
}

export default config
