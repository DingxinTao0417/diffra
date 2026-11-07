import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { commandRoots, loadCommands } from '../src/commands.js'
import { inspectPlugin, pluginMcpServers, pluginServerName } from '../src/plugins.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'diffra-plugins-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(path: string, content: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

// 一个 Claude Code 格式的插件：清单、两个命令、一个 Skill、.mcp.json，还有不支持的 agents
function makePlugin(dir: string, mcp: unknown) {
  write(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', version: '1.2.0', description: '测试插件', author: { name: 'me' } }))
  write(join(dir, 'commands', 'greet.md'), '---\ndescription: 打招呼\nargument-hint: <名字>\n---\n跟 $ARGUMENTS 打个招呼')
  write(join(dir, 'commands', 'git', 'sync.md'), '同步一下')
  write(join(dir, 'skills', 'kit-style', 'SKILL.md'), '---\nname: kit-style\ndescription: 插件里的 Skill\n---\n写短句')
  write(join(dir, 'agents', 'helper.md'), 'agent')
  write(join(dir, '.mcp.json'), JSON.stringify(mcp))
}

describe('自定义命令', () => {
  test('按优先级读：项目的排前面，子目录是命名空间，插件的命令带插件名', async () => {
    const project = join(root, 'project')
    const plugin = join(root, 'kit')
    write(join(project, '.diffra', 'commands', 'review.md'), '---\ndescription: 项目里的审查\n---\n审查 $ARGUMENTS')
    write(join(project, '.diffra', 'commands', 'nested', 'deep', 'too-deep.md'), '太深了不读')
    makePlugin(plugin, {})
    const commands = await loadCommands(commandRoots(project, [{ name: 'kit', dir: plugin }]).filter((item) => item.source !== 'claude' && item.source !== 'codex' && item.source !== 'user'))
    expect(commands).toEqual([
      { name: 'kit:git:sync', description: '', argumentHint: '', source: 'plugin', body: '同步一下' },
      { name: 'kit:greet', description: '打招呼', argumentHint: '<名字>', source: 'plugin', body: '跟 $ARGUMENTS 打个招呼' },
      { name: 'review', description: '项目里的审查', argumentHint: '', source: 'project', body: '审查 $ARGUMENTS' },
    ])
  })
})

describe('插件', () => {
  test('读清单和内容；列出不支持的部分', async () => {
    const dir = join(root, 'kit')
    makePlugin(dir, { mcpServers: { docs: { type: 'http', url: 'https://example.com/mcp' } } })
    expect(await inspectPlugin(dir)).toEqual({
      name: 'kit',
      version: '1.2.0',
      description: '测试插件',
      commands: ['kit:git:sync', 'kit:greet'],
      skills: ['kit-style'],
      mcpServers: ['kit-docs'],
      unsupported: ['agents'],
    })
  })

  test('没有清单时用文件夹名；什么都没有、清单不是 JSON 时说明原因', async () => {
    const bare = join(root, 'bare-plugin')
    write(join(bare, 'commands', 'hi.md'), 'hi')
    expect((await inspectPlugin(bare)).name).toBe('bare-plugin')

    const empty = join(root, 'empty')
    mkdirSync(empty)
    await expect(inspectPlugin(empty)).rejects.toThrow('这个文件夹不是插件')

    const broken = join(root, 'broken')
    write(join(broken, '.claude-plugin', 'plugin.json'), '{ not json')
    await expect(inspectPlugin(broken)).rejects.toThrow('不是合法的 JSON')
  })

  test('.mcp.json 两种写法都认；插件根目录和环境变量展开；服务器名带插件名', async () => {
    process.env.DIFFRA_PLUGIN_TEST_TOKEN = 'from-env'
    try {
      const first = join(root, 'first')
      makePlugin(first, {
        mcpServers: {
          local: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { TOKEN: '${DIFFRA_PLUGIN_TEST_TOKEN}', MISSING: '${DIFFRA_NO_SUCH_VAR}' } },
        },
      })
      const second = join(root, 'second')
      makePlugin(second, { remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }, bad: { nothing: true } })
      expect(
        await pluginMcpServers([
          { name: 'kit', dir: first },
          { name: 'other kit', dir: second },
          { name: 'gone', dir: join(root, 'missing') },
        ]),
      ).toEqual([
        {
          name: 'kit-local',
          command: 'node',
          args: [`${first}/server.js`],
          env: [
            { name: 'TOKEN', value: 'from-env' },
            { name: 'MISSING', value: '' },
          ],
        },
        { type: 'http', name: 'other-kit-remote', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
      ])
    } finally {
      delete process.env.DIFFRA_PLUGIN_TEST_TOKEN
    }
    expect(pluginServerName('我的插件', 'a.b')).toBe('-----a-b')
  })
})
