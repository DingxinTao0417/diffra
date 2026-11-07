import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionUpdate } from '@diffra/core/types'
import type { EvalModel } from './config.ts'
import { core, sessionConfig, startCore } from './core.ts'
import { type Finding, turnMetrics, type UsageTotals, usageTotals } from './metrics.ts'
import type { DeepScanSample } from './tasks.ts'

// 报告里的问题和答案表对得上：同一个文件、同一个规则号、行号相差不超过这么多
const LINE_TOLERANCE = 3

export interface DeepScanResult {
  id: string
  model: string
  answers: number
  matched: Array<{ answer: string; finding: string }>
  missed: string[]
  falsePositives: string[]
  stopReason: string | null
  error: string | null
  durationMs: number
  usage: UsageTotals
}

type Answer = DeepScanSample['answers'][number]

const sameProblem = (finding: Finding, answer: Answer) =>
  finding.ruleId === answer.ruleId &&
  [answer, ...answer.alternatives].some((location) => finding.path === location.path && Math.abs(finding.line - location.line) <= LINE_TOLERANCE)

export function scoreFindings(answers: Answer[], findings: Finding[]) {
  const used = new Set<number>()
  const matched: DeepScanResult['matched'] = []
  const missed: string[] = []
  for (const answer of answers) {
    const index = findings.findIndex((finding, position) => !used.has(position) && sameProblem(finding, answer))
    const label = `${answer.ruleId} ${answer.path}:${answer.line}（${answer.note}）`
    if (index < 0) {
      missed.push(label)
      continue
    }
    used.add(index)
    const finding = findings[index]
    matched.push({ answer: label, finding: `${finding?.ruleId} ${finding?.path}:${finding?.line} ${finding?.message}` })
  }
  // 同一个问题报了两遍不算误报
  const falsePositives = findings.flatMap((finding, index) =>
    used.has(index) || answers.some((answer) => sameProblem(finding, answer)) ? [] : [`${finding.ruleId} ${finding.path}:${finding.line} ${finding.message}`],
  )
  return { matched, missed, falsePositives }
}

// 对样例项目跑「扫描整个项目」，和答案表比对
export async function runDeepScanSample(sample: DeepScanSample, model: EvalModel, reviewer: EvalModel | null, runDir: string): Promise<DeepScanResult> {
  const base = join(runDir, `deep-scan-${sample.id}`)
  const workDir = join(base, 'project')
  const dataDir = join(base, 'data')
  mkdirSync(dataDir, { recursive: true })
  cpSync(join(sample.dir, 'repo'), workDir, { recursive: true })
  const updates: SessionUpdate[] = []
  const started = Date.now()
  let stopReason: string | null = null
  let error: string | null = null
  const coreProcess = await startCore(dataDir, {
    onSessionUpdate: (notification) => updates.push(notification.update),
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
  })
  try {
    const { sessionId } = await core.createSession(
      coreProcess.connection,
      workDir,
      sessionConfig(model, reviewer, {
        checks: { afterEdit: null, beforeFinish: null },
        readOnlyPaths: [],
        security: { staticCheck: false, lightScan: false },
        review: false,
        checkpointDir: join(dataDir, 'checkpoints'),
      }),
    )
    stopReason = (await core.deepScan(coreProcess.connection, sessionId, randomUUID(), 'project')).stopReason
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    coreProcess.stop()
  }
  const findings = turnMetrics(updates).findings.filter((item) => item.card === '深度扫描报告')
  return {
    id: sample.id,
    model: model.name,
    answers: sample.answers.length,
    ...scoreFindings(sample.answers, findings),
    stopReason,
    error,
    durationMs: Date.now() - started,
    usage: usageTotals(join(dataDir, 'usage')),
  }
}
