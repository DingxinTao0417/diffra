import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Configuration } from 'electron-builder'
import { type ChangelogRelease, formatNotes } from './src/shared/changelog.ts'

// 更新地址会写进已安装客户端的 resources/app-update.yml，发布后就不能再改。
// DIFFRA_UPDATE_URL 只在本地验证更新流程时使用，指向临时更新源；正式构建不要设置它。
const updateUrl = process.env.DIFFRA_UPDATE_URL || 'https://update.diffra.dev/win/'
// Mac 版的更新源单独一个目录（latest-mac.yml 和 zip 包），同样发布后不能改。现在 Mac 版还不自动更新（见 updater.ts）
const macUpdateUrl = process.env.DIFFRA_UPDATE_URL || 'https://update.diffra.dev/mac/'
// 有 Developer ID 证书时用证书签名并公证：CI 里用 CSC_LINK（p12），本机用 CSC_NAME 指定，或者钥匙串里装了 Developer ID Application 证书就直接用。
// 没有就临时签名（ad-hoc）：Apple 芯片要求程序至少有签名才能运行；临时签名的包只能自己用，发给别人会被 Gatekeeper 拦。
// DIFFRA_MAC_ADHOC=1 强制临时签名（本机试打包、跑打包版 e2e 时不用等公证）
function keychainHasDeveloperId(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    return execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).includes('"Developer ID Application:')
  } catch {
    return false
  }
}
const macCertificate = process.env.DIFFRA_MAC_ADHOC !== '1' && (Boolean(process.env.CSC_LINK || process.env.CSC_NAME) || keychainHasDeveloperId())
// 公证凭据：CI 用 APPLE_API_KEY、APPLE_API_KEY_ID、APPLE_API_ISSUER；本机用 notarytool store-credentials 存进钥匙串的 diffra-notary。
// electron-builder 找不到凭据时只警告、不公证，悄悄打出发给别人会被拦的包；默认指向 diffra-notary，钥匙串里没有这份凭据时公证直接失败
const MAC_NOTARY_PROFILE = 'diffra-notary'
if (macCertificate && process.platform === 'darwin' && !process.env.APPLE_API_KEY && !process.env.APPLE_ID) {
  process.env.APPLE_KEYCHAIN_PROFILE ??= MAC_NOTARY_PROFILE
}

// rg 二进制随 core 的依赖 @vscode/ripgrep 按平台下载；打包时拷到 resources，主进程通过 DIFFRA_RG_PATH 告诉 core
const requireFromCore = createRequire(fileURLToPath(new URL('../core/package.json', import.meta.url)))
const { rgPath } = requireFromCore('@vscode/ripgrep') as { rgPath: string }

// 这一版的更新日志写进 latest.yml 的 releaseNotes，旧客户端下载好新版时能看到改了什么。
// out/changelog.json 由 package 脚本在打包前生成；单独读这个配置（publish-release.ts）时没有也没关系
function releaseNotes(): string | null {
  const file = fileURLToPath(new URL('./out/changelog.json', import.meta.url))
  if (!existsSync(file)) return null
  const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as { version: string }
  const release = (JSON.parse(readFileSync(file, 'utf8')) as ChangelogRelease[]).find((item) => item.version === version)
  return release ? formatNotes(release) || null : null
}

const config: Configuration = {
  appId: 'dev.diffra.desktop',
  // 每用户安装的目录名（%LOCALAPPDATA%\Programs\diffra）和更新缓存目录名都取自包名，
  // workspace 包名 @diffra/desktop 会变成 @diffradesktop。和 appId 一样，发布后不能改。
  // macDeveloperId：Mac 上用 Developer ID 签名的包才自动更新（见 updater.ts）；Windows 打包时没有这一项，和原来一样
  extraMetadata: { name: 'diffra', ...(process.platform === 'darwin' && macCertificate ? { macDeveloperId: true } : {}) },
  directories: { output: 'release' },
  files: ['out/**/*'],
  // 唯一的原生依赖 node-pty 自带 N-API 预编译文件，Electron 直接能用；重编要装 VS 编译工具，而且会失败
  npmRebuild: false,
  // 内置 Skill 要是真实文件：模型按索引里的路径用 read_file 读，主进程通过 DIFFRA_SKILLS_DIR 告诉 core。
  // ripgrep 按平台各放一份（win、mac 里的 extraResources，和这里的合在一起）
  extraResources: [
    { from: '../core/skills', to: 'skills' },
    // 设计模式打进去的第三方组件（OpenPencil 等）的出处和许可
    { from: 'NOTICE.md', to: 'NOTICE.md' },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    extraResources: [{ from: rgPath, to: 'rg.exe' }],
  },
  // Mac：dmg 给人下载安装，zip 给自动更新用（electron-updater 在 Mac 上只认 zip）。先只出 Apple 芯片（arm64）：
  // ripgrep、ast-grep 的原生文件按本机架构装，Intel 版要在 Intel 机器或 CI 上另打
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    artifactName: 'Diffra-${version}-${arch}.${ext}',
    icon: 'build/icon.icns',
    category: 'public.app-category.developer-tools',
    extraResources: [{ from: rgPath, to: 'rg' }],
    // 公证要求开启 hardened runtime；Electron 要 JIT，原生模块（node-pty、ast-grep）的签名和主程序不是同一个团队时要关掉库校验
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    identity: macCertificate ? undefined : '-',
    // 公证要 Apple 账号的凭据（见上面 MAC_NOTARY_PROFILE），没有证书时也没法公证
    notarize: macCertificate,
    publish: [{ provider: 'generic', url: macUpdateUrl }],
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
  releaseInfo: { releaseNotes: releaseNotes() },
}

export default config
