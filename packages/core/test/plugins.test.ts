import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { commandRoots, loadCommands } from '../src/commands.js'
import { hooksFingerprint, inspectPlugin, pluginBlocks, pluginHooks, pluginMcpServers, pluginServerName } from '../src/plugins.js'
import { buildSystemPrompt } from '../src/session/prompt.js'
import { loadAgentTypes } from '../src/subagents.js'

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

// 一个 Claude Code 格式的插件：清单、两个命令、一个 Skill、.mcp.json、三个子智能体（只读的、没写 tools 的、能跑命令的）和一个缺说明的，还有不支持的 output-styles
function makePlugin(dir: string, mcp: unknown) {
  write(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', version: '1.2.0', description: '测试插件', author: { name: 'me' } }))
  write(join(dir, 'commands', 'greet.md'), '---\ndescription: 打招呼\nargument-hint: <名字>\n---\n跟 $ARGUMENTS 打个招呼')
  write(join(dir, 'commands', 'git', 'sync.md'), '同步一下')
  write(join(dir, 'skills', 'kit-style', 'SKILL.md'), '---\nname: kit-style\ndescription: 插件里的 Skill\n---\n写短句')
  write(join(dir, 'agents', 'explorer.md'), '---\nname: explorer\ndescription: 读代码找答案\ntools: Glob, Grep, Read, WebFetch\nmodel: sonnet\n---\n只读不改')
  write(join(dir, 'agents', 'builder.md'), '---\nname: builder\ndescription: 动手实现\n---\n照计划改代码')
  write(join(dir, 'agents', 'runner.md'), '---\ndescription: 跑测试\ntools: Read, Bash\n---\n跑一遍测试')
  write(join(dir, 'agents', 'helper.md'), 'agent')
  write(join(dir, 'output-styles', 'terse.md'), 'terse')
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
      agents: ['kit:builder', 'kit:explorer', 'kit:runner'],
      hooks: [],
      hooksFingerprint: null,
      blocks: [],
      lspServers: [],
      unsupported: ['output-styles'],
    })
  })

  // 第 682 步：插件注册的富块
  test('富块：blocks/blocks.json 里的套用内置富块或插件里的模板；格式不对、模板不在插件里或太大的不收、写进不支持；同名只留先开的插件的；系统提示词里写明', async () => {
    const dir = join(root, 'ops')
    write(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ops' }))
    write(join(dir, 'templates', 'build.html'), '<div id="b"></div>')
    write(join(dir, 'templates', 'big.html'), 'x'.repeat(250_000))
    write(
      join(dir, 'blocks', 'blocks.json'),
      JSON.stringify({
        blocks: [
          { kind: 'deploy-status', title: '部署状态', description: '一个服务的部署状态', renders: 'keyvalue' },
          { kind: 'build-report', title: '构建报告', renders: 'template', template: 'templates/build.html' },
          { kind: 'nohyphen', title: '没有连字符', renders: 'table' },
          { kind: 'bad-renderer', title: '不认识的渲染', renders: 'video' },
          { kind: 'too-big', title: '太大', renders: 'template', template: 'templates/big.html' },
          { kind: 'escape-out', title: '跑出去', renders: 'template', template: '../secret.html' },
        ],
      }),
    )
    const info = await inspectPlugin(dir)
    expect(info.blocks).toEqual(['deploy-status', 'build-report'])
    expect(info.unsupported).toEqual(['富块 nohyphen（格式不对）', '富块 bad-renderer（格式不对）', '富块 too-big（模板不在插件里、不存在或超过 200 KB）', '富块 escape-out（模板不在插件里、不存在或超过 200 KB）'])

    const other = join(root, 'other')
    write(join(other, 'blocks', 'blocks.json'), JSON.stringify({ blocks: [{ kind: 'deploy-status', title: '另一个', renders: 'table' }] }))
    const blocks = await pluginBlocks([
      { name: 'ops', dir },
      { name: 'other', dir: other },
    ])
    expect(blocks).toEqual([
      { plugin: 'ops', kind: 'deploy-status', title: '部署状态', description: '一个服务的部署状态', renders: 'keyvalue' },
      { plugin: 'ops', kind: 'build-report', title: '构建报告', description: '', renders: 'template', template: '<div id="b"></div>' },
    ])
    const prompt = await buildSystemPrompt(null, { checks: { afterEdit: null, beforeFinish: null }, readOnlyPaths: [], rules: { packs: [] } }, [], { skills: [], frontend: null, blocks })
    expect(prompt).toContain("Blocks added by the user's plugins")
    expect(prompt).toContain('deploy-status: 部署状态 — 一个服务的部署状态 (same JSON as keyvalue)')
    expect(prompt).toContain('build-report: 构建报告 (JSON shaped as the description says)')
  })

  test('子智能体：名字带插件名；tools 里没有改文件、跑命令的工具才是只读；没写 tools 是全能；正文前说明它来自 Claude Code 插件', async () => {
    const dir = join(root, 'kit')
    makePlugin(dir, {})
    const project = join(root, 'project')
    mkdirSync(project)
    const types = (await loadAgentTypes(project, [{ name: 'kit', dir }])).filter((type) => type.name.startsWith('kit:'))
    expect(types.map(({ name, description, readOnly }) => ({ name, description, readOnly }))).toEqual([
      { name: 'kit:builder', description: '动手实现', readOnly: false },
      { name: 'kit:explorer', description: '读代码找答案', readOnly: true },
      { name: 'kit:runner', description: '跑测试', readOnly: false },
    ])
    expect(types[1]?.instructions).toMatch(/^This worker type comes from the plugin "kit", written for Claude Code\./)
    expect(types[1]?.instructions.endsWith('只读不改')).toBe(true)
    // 不带插件时没有
    expect((await loadAgentTypes(project)).some((type) => type.name.startsWith('kit:'))).toBe(false)
  })

  test('钩子：读 hooks/hooks.json 里支持的时机和命令，不支持的时机、类型列出来；允许时的指纹对得上才加载', async () => {
    const dir = join(root, 'hooky')
    write(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hooky' }))
    const hooksFile = (command: string) =>
      JSON.stringify({
        description: '测试钩子',
        hooks: {
          SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command, timeout: 5 }] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }, { type: 'prompt', prompt: '问问模型' }] }],
          Notification: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }],
        },
      })
    write(join(dir, 'hooks', 'hooks.json'), hooksFile('"${CLAUDE_PLUGIN_ROOT}/start.sh"'))
    const info = await inspectPlugin(dir)
    expect(info.hooks).toEqual([
      { event: 'SessionStart', matcher: 'startup|resume', command: '"${CLAUDE_PLUGIN_ROOT}/start.sh"', timeout: 5 },
      { event: 'PreToolUse', matcher: 'Bash', command: 'check.sh', timeout: null },
    ])
    expect(info.hooksFingerprint).toBe(hooksFingerprint(info.hooks))
    expect(info.unsupported).toEqual(['钩子 PreToolUse 的 prompt 类型', '钩子 Notification'])

    // 没允许不加载；允许时的指纹对得上才加载；钩子改了以后旧指纹对不上，不加载
    expect(await pluginHooks([{ name: 'hooky', dir }])).toEqual([])
    expect((await pluginHooks([{ name: 'hooky', dir, hooks: info.hooksFingerprint! }])).map((hook) => [hook.plugin, hook.event, hook.root])).toEqual([
      ['hooky', 'SessionStart', dir],
      ['hooky', 'PreToolUse', dir],
    ])
    write(join(dir, 'hooks', 'hooks.json'), hooksFile('echo changed'))
    expect(await pluginHooks([{ name: 'hooky', dir, hooks: info.hooksFingerprint! }])).toEqual([])

    // 只有钩子的文件夹也算插件；hooks.json 格式不对时说明
    const only = join(root, 'only-hooks')
    write(join(only, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }))
    expect((await inspectPlugin(only)).hooks).toHaveLength(1)
    write(join(only, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: 'nope' } }))
    await expect(inspectPlugin(only)).rejects.toThrow('hooks/hooks.json 格式不对')
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
