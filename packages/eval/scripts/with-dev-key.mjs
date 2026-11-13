// 用 Electron 跑：从桌面端数据目录取一个服务的密钥，只放进子进程的环境变量里再跑后面的命令，密钥不打印、不落盘。
// 用法：electron scripts/with-dev-key.mjs <数据目录> <服务 id> <环境变量名> -- <命令> [参数...]
// 密钥是 safeStorage 加密的，只有 Electron 解得开。桌面端的数据目录只读：把 Local State 复制到 eval 自己的目录里，
// 让 Electron 在那里起（它运行时占着自己的数据目录，删不掉，所以用固定位置、每次覆盖，不删）
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, safeStorage } from 'electron'

const args = process.argv.slice(2)
const split = args.indexOf('--')
const [dataDir, providerId, envName] = split < 0 ? [] : args.slice(0, split)
const command = split < 0 ? [] : args.slice(split + 1)
if (!dataDir || !providerId || !envName || command.length === 0) {
  console.error('用法：electron scripts/with-dev-key.mjs <数据目录> <服务 id> <环境变量名> -- <命令> [参数...]')
  process.exit(2)
}

// 放在 eval 包里（已被 .gitignore 忽略的 results/ 下），和评测结果一起在 D 盘
const userData = join(dirname(fileURLToPath(import.meta.url)), '..', 'results', '.dev-key-userdata')
mkdirSync(userData, { recursive: true })
copyFileSync(join(dataDir, 'Local State'), join(userData, 'Local State'))
app.setPath('userData', userData)

const fail = (message) => {
  console.error(message)
  app.exit(1)
}

app.whenReady().then(async () => {
  let key
  try {
    const secrets = JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf8'))
    const encrypted = secrets.keys?.[providerId]
    if (!encrypted) return fail(`数据目录里没有服务 ${providerId} 的密钥`)
    key = (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result
  } catch (error) {
    return fail(`取密钥失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const env = { ...process.env, [envName]: key }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env, windowsHide: true })
  child.on('error', (error) => fail(`跑不起来：${error.message}`))
  child.on('exit', (code) => app.exit(code ?? 1))
})
