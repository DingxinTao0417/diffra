import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeepScanResult } from './deep-scan.ts'
import type { TaskResult } from './run-task.ts'

const CATEGORY_LABELS: Record<TaskResult['category'], string> = {
  feature: '功能',
  bugfix: '修 bug',
  'multi-file': '多文件',
  refactor: '重构',
  security: '安全',
  protection: '保护',
  gate: '门禁',
  rules: '规范',
  delegation: '委派',
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} 秒`
const tokens = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value))
const average = (values: number[]) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

// 每次运行写两份：results.json 给程序读，report.md 给人看
export function writeReport(outDir: string, meta: { startedAt: string; models: string[]; reviewer: string | null }, tasks: TaskResult[], scans: DeepScanResult[]): string {
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ ...meta, tasks, deepScans: scans }, null, 2))
  const lines: string[] = [`# Diffra 评测报告`, '', `- 开始时间：${meta.startedAt}`, `- 模型：${meta.models.join('、')}`, `- 评审模型：${meta.reviewer ?? '同被评测的模型'}`, '']

  for (const model of meta.models) {
    const results = tasks.filter((item) => item.model === model)
    if (results.length === 0) continue
    const passed = results.filter((item) => item.passed).length
    lines.push(`## ${model}`, '')
    lines.push(
      `通过 ${passed}/${results.length}（${Math.round((passed / results.length) * 100)}%）；` +
        `平均每题 ${tokens(average(results.map((item) => item.usage.inputTokens + item.usage.outputTokens)))} token、` +
        `${Math.round(average(results.map((item) => item.usage.calls)))} 次模型调用、${seconds(average(results.map((item) => item.durationMs)))}`,
      '',
    )
    const categories = [...new Set(results.map((item) => item.category))]
    lines.push(`按类别：${categories.map((category) => {
      const group = results.filter((item) => item.category === category)
      return `${CATEGORY_LABELS[category]} ${group.filter((item) => item.passed).length}/${group.length}`
    }).join('，')}`, '')
    // 该派和不该派子智能体的题各派了几道；token 里子智能体用掉的单独列出来
    const expected = results.filter((item) => item.delegate === 'expected')
    const unexpected = results.filter((item) => item.delegate === 'unexpected')
    if (expected.length + unexpected.length > 0) {
      const delegated = (group: TaskResult[]) => `${group.filter((item) => item.delegations > 0).length}/${group.length}`
      lines.push(`子智能体：该派的题派了 ${delegated(expected)}，不该派的题派了 ${delegated(unexpected)}；子智能体共用 ${tokens(results.reduce((sum, item) => sum + item.usage.subagentTokens, 0))} token`, '')
    }
    lines.push('| 题目 | 类别 | 结果 | 工具调用 | 模型调用 | token | 用时 | 门禁打回 | 检查失败 | 安全发现 | 子智能体 | 提问 | 备注 |')
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const item of results) {
      const notes = [
        item.error ? `出错：${item.error.split('\n')[0]}` : null,
        item.stopReason && item.stopReason !== 'end_turn' ? `结束原因 ${item.stopReason}` : null,
        item.hiddenPassed ? null : '隐藏测试没过',
        item.changedProtectedFiles.length > 0 ? `改了受保护的文件 ${item.changedProtectedFiles.join('、')}` : null,
        item.leakedSecrets.length > 0 ? '密钥进了对话' : null,
      ].filter(Boolean)
      const findings = item.findings.filter((finding) => finding.level !== '已放行')
      lines.push(
        `| ${item.id} ${cell(item.title)} | ${CATEGORY_LABELS[item.category]} | ${item.passed ? '通过' : '失败'} | ${item.toolCalls} | ${item.usage.calls} | ${tokens(item.usage.inputTokens + item.usage.outputTokens)} | ${seconds(item.durationMs)} | ${item.gateRejections} | ${item.checkFailures} | ${findings.map((finding) => `${finding.card}:${finding.level} ${finding.ruleId}`).join('、') || '—'} | ${item.delegations > 0 ? `${item.delegations} 个，${item.workerToolCalls} 次调用` : '—'} | ${item.questions || '—'} | ${cell(notes.join('；')) || '—'} |`,
      )
    }
    lines.push('')
    const failed = results.filter((item) => !item.passed)
    if (failed.length > 0) {
      lines.push('### 失败的题', '')
      for (const item of failed) {
        lines.push(`#### ${item.id} ${item.title}`, '', `项目目录：\`${item.workDir}\``, '', '```', item.error ?? item.hiddenOutput.slice(-1500), '```', '')
      }
    }
  }

  if (scans.length > 0) {
    lines.push('## 深度扫描准确率', '', '| 样例 | 模型 | 查出 | 漏掉 | 误报 | 模型调用 | token | 用时 |', '|---|---|---|---|---|---|---|---|')
    for (const scan of scans) {
      lines.push(
        `| ${scan.id} | ${scan.model} | ${scan.matched.length}/${scan.answers} | ${scan.missed.length} | ${scan.falsePositives.length} | ${scan.usage.calls} | ${tokens(scan.usage.inputTokens + scan.usage.outputTokens)} | ${seconds(scan.durationMs)} |`,
      )
    }
    lines.push('')
    for (const scan of scans) {
      lines.push(`### ${scan.id}（${scan.model}）`, '')
      if (scan.error) lines.push(`出错：${scan.error}`, '')
      for (const item of scan.missed) lines.push(`- 漏掉：${item}`)
      for (const item of scan.falsePositives) lines.push(`- 误报：${item}`)
      lines.push('')
    }
  }
  const path = join(outDir, 'report.md')
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}
