import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { app } from 'electron'

// 测试用的环境变量（连本机的中转、缩短邀请串有效期、扩展目录换成本机的假服务）：未打包时认（规则同 DIFFRA_UPDATE_URL）；
// 打包版只在 e2e 的临时数据目录（系统临时目录下的 diffra-e2e-*）里认，正式数据目录里设了也不管用
export function testOverridesAllowed(): boolean {
  if (!app.isPackaged) return true
  // 按真实路径比：Windows 的临时目录可能是 8.3 短名
  const real = (path: string) => {
    const resolved = realpathSync.native(path)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const dir = app.getPath('userData')
  try {
    return real(dirname(dir)) === real(tmpdir()) && basename(dir).startsWith('diffra-e2e-')
  } catch {
    return false
  }
}
