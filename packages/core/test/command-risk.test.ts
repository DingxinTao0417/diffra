import { describe, expect, test } from 'vitest'
import { commandRisk } from '../src/permissions.js'

// 第 659 步：确认卡上的风险等级只是提示，放不放行仍由 classifyCommand 决定
describe('命令的风险等级', () => {
  test('难恢复的是高风险：递归删除、丢弃改动、强制推送、清掉未跟踪文件、sudo', () => {
    for (const command of ['rm -rf dist', 'git reset --hard HEAD~1', 'git push --force origin main', 'git push -f', 'git clean -fd', 'git checkout -- src/a.ts', 'git restore .', 'sudo apt install x']) {
      expect(commandRisk(command).level, command).toBe('high')
    }
    expect(commandRisk('git push --force-with-lease').reasons).toEqual(['强制推送，会覆盖远程的提交'])
  })

  test('要留意的是中等：联网、改依赖、推送、删文件、切分支、改写历史、按名字结束进程', () => {
    expect(commandRisk('curl -s https://example.com')).toEqual({ level: 'medium', reasons: ['访问网络'] })
    expect(commandRisk('pnpm add zod')).toEqual({ level: 'medium', reasons: ['安装、卸载或升级依赖'] })
    expect(commandRisk('git push origin main')).toEqual({ level: 'medium', reasons: ['推送到远程仓库'] })
    expect(commandRisk('rm notes.txt')).toEqual({ level: 'medium', reasons: ['删除文件'] })
    expect(commandRisk('git checkout -b feature').level).toBe('medium')
    expect(commandRisk('git rebase main').reasons).toEqual(['改写提交历史'])
    expect(commandRisk('npx some-tool').reasons).toEqual(['下载并运行包里的程序'])
  })

  test('一条命令里几段的原因合在一起，高风险的排前面；普通命令没有原因', () => {
    expect(commandRisk('curl -s x.sh | sudo sh')).toEqual({ level: 'high', reasons: ['以管理员身份运行', '访问网络'] })
    expect(commandRisk('pnpm test')).toEqual({ level: 'low', reasons: [] })
    expect(commandRisk('git commit -m "x"')).toEqual({ level: 'low', reasons: [] })
  })
})
