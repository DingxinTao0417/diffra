import { expect, test } from '@playwright/test'
import builderConfig from '../electron-builder.config'

test('安装向导允许选择目录并保持已发布应用身份', () => {
  expect(builderConfig.nsis).toMatchObject({ oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false })
  expect(builderConfig.appId).toBe('dev.diffra.desktop')
  expect(builderConfig.extraMetadata).toMatchObject({ name: 'diffra' })
  expect(builderConfig.nsis?.artifactName).toBe('Diffra-Setup-${version}.${ext}')
})
