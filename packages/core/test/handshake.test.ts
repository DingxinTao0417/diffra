import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { expect, test } from 'vitest'
import { connectToCore, handshake } from '../src/client.js'
import { CORE_VERSION } from '../src/version.js'

test('命令行启动 core 后能完成 ACP 握手', async () => {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] })
  try {
    await expect(handshake(connectToCore(child.stdin, child.stdout), 10_000)).resolves.toEqual({
      agentName: 'diffra-core',
      agentVersion: CORE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    })
  } finally {
    child.kill()
  }
})
