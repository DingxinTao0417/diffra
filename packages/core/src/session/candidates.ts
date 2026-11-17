import { readFile, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { SessionUpdate, StopReason, ToolCallUpdate } from '@agentclientprotocol/sdk'
import {
  AGENT_META_KEY,
  type AgentCardMeta,
  type AgentTag,
  CANDIDATES_CARD_TITLE,
  CANDIDATES_META_KEY,
  type CandidateRunView,
  type CandidateSpec,
  type CandidateView,
  MAX_CANDIDATES,
  MODEL_SILENCE_META_KEY,
  PARENT_TOOL_CALL_META_KEY,
  TURN_OUTCOME_META_KEY,
  type TurnOutcome,
} from '../protocol.js'
import { AGENT_COLORS } from './agents.js'
import { notice, publishTaskState, runTurn, takeCheckpoint, taskStateUpdate, type TurnIO } from './loop.js'
import type { Session } from './session.js'
import type { CandidateRun } from './store.js'
import { applyPatch, captureBaseline, checkApply, createWorktree, diffStats, diffText, patchOf, removeWorktree, treeOf, WorktreeError } from './worktrees.js'

const LETTERS = ['a', 'b', 'c'] as const
const SUMMARY_CHARS = 2000
// 应用时给每个改动的文件出一张改动卡片：最多这么多个，太大的文件不读全文
const MAX_EDIT_CARDS = 50
const MAX_EDIT_CARD_BYTES = 200_000

// 候选在哪里跑：worktree 放在哪个目录；在 worktree 里起一个只跑一轮的会话（和主会话同样的模型、规则、权限模式，自己的检查点）
export interface CandidateHost {
  worktreesDir: string
  child(cwd: string, checkpointDir: string, readOnlyPaths: string[]): Promise<Session>
}

export function runView(run: CandidateRun): CandidateRunView {
  return { turnId: run.turnId, status: run.status, appliedId: run.appliedId, ...(run.conflicts ? { conflicts: run.conflicts } : {}), candidates: run.candidates }
}

const cardId = (turnId: string) => `candidates-${turnId}`

// 「候选方案」卡片：文字给旧版和读屏看，界面按 _meta 画成可以比较、应用的卡片
export function runCardUpdate(run: CandidateRun, first: boolean): SessionUpdate {
  const lines = run.candidates.map((candidate) => {
    const stats = candidate.stats ? `${candidate.stats.files} 个文件 +${candidate.stats.added} −${candidate.stats.removed}` : ''
    return `- ${candidate.name}（${candidate.status}）${stats ? `：${stats}` : ''}`
  })
  return {
    sessionUpdate: first ? 'tool_call' : 'tool_call_update',
    toolCallId: cardId(run.turnId),
    title: CANDIDATES_CARD_TITLE,
    kind: 'think',
    status: run.status === 'running' ? 'in_progress' : run.status === 'failed' || run.status === 'cancelled' ? 'failed' : 'completed',
    content: [{ type: 'content', content: { type: 'text', text: lines.join('\n') } }],
    _meta: { diffra: { [CANDIDATES_META_KEY]: runView(run) } },
  }
}

// 候选自己的过程：工具调用挂在它的卡片下面（和子智能体一样），文字只留最后一段当总结；
// 它的任务状态、结论、提示不进主任务，结论记下来；几个候选同时要确认时排队，一个一个问
interface CandidateState {
  // 正在说的这一段；last 是上一段说完的
  text: string
  last: string
  outcome: TurnOutcome | null
  error: string | null
}

function candidateIO(io: TurnIO, tag: AgentTag, card: string, state: CandidateState, permissions: { chain: Promise<unknown> }): TurnIO {
  const tagged = <T extends { _meta?: { [key: string]: unknown } | null }>(value: T): T => {
    const meta = value._meta ?? {}
    const diffra = typeof meta.diffra === 'object' && meta.diffra !== null ? (meta.diffra as Record<string, unknown>) : {}
    return { ...value, _meta: { ...meta, diffra: { ...diffra, [PARENT_TOOL_CALL_META_KEY]: card, [AGENT_META_KEY]: tag } } }
  }
  const uiId = (id: string) => `${tag.id}/${id}`
  return {
    update: async (update) => {
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (update.content.type === 'text') state.text = (state.text + update.content.text).slice(-SUMMARY_CHARS * 2)
        return
      }
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        // 一段话说完、开始调工具：记下这一段，总结取最后一段
        if (update.sessionUpdate === 'tool_call' && state.text.trim()) {
          state.last = state.text
          state.text = ''
        }
        await io.update(tagged({ ...update, toolCallId: uiId(update.toolCallId) }))
        return
      }
      if (update.sessionUpdate === 'session_info_update') {
        const diffra = update._meta?.diffra as Record<string, unknown> | undefined
        if (diffra && TURN_OUTCOME_META_KEY in diffra) state.outcome = diffra[TURN_OUTCOME_META_KEY] as TurnOutcome
        if (diffra && MODEL_SILENCE_META_KEY in diffra) await io.update(tagged({ sessionUpdate: 'session_info_update', _meta: { diffra: { [MODEL_SILENCE_META_KEY]: diffra[MODEL_SILENCE_META_KEY] } } }))
        return
      }
      if (update.sessionUpdate === 'notice' && update.severity === 'error') state.error = [update.title, update.description].filter(Boolean).join('：')
    },
    requestPermission: (toolCall: ToolCallUpdate, options) => {
      const asked = permissions.chain.then(() => io.requestPermission(tagged({ ...toolCall, toolCallId: uiId(toolCall.toolCallId) }), options))
      permissions.chain = asked.catch(() => null)
      return asked
    },
    ...(io.requestAnswers
      ? {
          requestAnswers: (toolCall: ToolCallUpdate, options) => {
            const asked = permissions.chain.then(() => io.requestAnswers!(tagged({ ...toolCall, toolCallId: uiId(toolCall.toolCallId) }), options))
            permissions.chain = asked.catch(() => null)
            return asked
          },
        }
      : {}),
    recordUsage: (call) => io.recordUsage(call),
  }
}

function candidatePrompt(request: string, plan: string | null, spec: CandidateSpec): string {
  return [
    request.trim(),
    ...(plan ? ['', '计划：', plan.trim()] : []),
    '',
    `[Diffra] 候选方案「${spec.name}」：${spec.approach.trim()}`,
    'You are one of several candidates, each working in its own copy of the project. The user will compare the candidates and pick one to merge back. Implement the task following the approach above. Do not commit, push, or start long-running servers.',
  ].join('\n')
}

// 清掉一组候选的全部 worktree（和它们的检查点）；删不掉的记日志，不挡着别的
export async function cleanupRun(run: CandidateRun): Promise<void> {
  for (const worktree of run.worktrees) {
    try {
      await removeWorktree(run.repoRoot, worktree)
      await rm(`${worktree.dir}.cp`, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      console.error(`[candidates] 清理 worktree ${worktree.dir} 失败`, error)
    }
  }
  run.worktrees = []
}

// 生成候选方案：一轮（记成 plan），每个候选一个 worktree、一个只跑这一轮的会话，并行跑完后出一张可以比较、应用的卡片。
// 项目本身不改；中途停止、全部失败时清掉 worktree
export async function runCandidates(session: Session, host: CandidateHost, turn: { id: string; request: string; plan: string | null; specs: CandidateSpec[] }, io: TurnIO): Promise<StopReason> {
  if (session.running) throw new Error('上一个任务还没结束')
  if (turn.specs.length < 2 || turn.specs.length > MAX_CANDIDATES) throw new Error(`候选方案要 2 到 ${MAX_CANDIDATES} 个`)
  const controller = session.activateTurn()
  const { signal } = controller
  let run: CandidateRun | null = null
  try {
    await takeCheckpoint(session, turn.id, io)
    await io.update(taskStateUpdate(session))
    let baseline: Awaited<ReturnType<typeof captureBaseline>>
    try {
      baseline = await captureBaseline(session.cwd)
    } catch (error) {
      await notice(io, 'error', '生成不了候选方案', error instanceof Error ? error.message : String(error))
      return 'end_turn'
    }
    const created: CandidateRun = {
      turnId: turn.id,
      status: 'running',
      appliedId: null,
      candidates: turn.specs.map((spec, index) => ({ id: LETTERS[index]!, name: spec.name, approach: spec.approach, status: 'running', summary: null, error: null, stats: null, paths: [] })),
      repoRoot: baseline.repoRoot,
      subdir: baseline.subdir,
      baseTree: null,
      worktrees: [],
    }
    run = created
    session.candidateRuns.push(created)
    await io.update(runCardUpdate(created, true))

    // worktree 一个一个建（同时 git worktree add 会抢仓库的锁）；建好就记进会话记录，应用崩了下次打开也清得掉
    const root = join(host.worktreesDir, `${session.id.slice(0, 8)}-${turn.id.slice(0, 8)}`)
    for (const candidate of created.candidates) {
      if (signal.aborted) break
      const worktree = await createWorktree(baseline, join(root, candidate.id))
      created.worktrees.push({ id: candidate.id, dir: worktree.dir, links: worktree.links, tree: null })
      created.baseTree ??= worktree.baseTree
    }
    await io.update(taskStateUpdate(session))

    const permissions = { chain: Promise.resolve<unknown>(null) }
    await Promise.all(
      created.candidates.map(async (candidate, index) => {
        const worktree = created.worktrees.find((item) => item.id === candidate.id)
        if (!worktree || signal.aborted) {
          candidate.status = 'cancelled'
          return
        }
        const tag: AgentTag = { id: `candidate-${candidate.id}`, name: candidate.name, color: AGENT_COLORS[index % AGENT_COLORS.length]! }
        const card = `${cardId(turn.id)}-${candidate.id}`
        const startedAt = Date.now()
        const meta = (extra: Partial<AgentCardMeta> = {}): AgentCardMeta => ({ ...tag, task: candidate.approach, files: [], nodes: [], startedAt, ...extra })
        await io.update({ sessionUpdate: 'tool_call', toolCallId: card, title: `候选方案 ${candidate.name}`, kind: 'other', status: 'in_progress', _meta: { diffra: { [AGENT_META_KEY]: meta() } } })
        const state: CandidateState = { text: '', last: '', outcome: null, error: null }
        const cwd = baseline.subdir ? join(worktree.dir, baseline.subdir) : worktree.dir
        // 链进来的依赖目录在候选里禁写，相对候选的任务目录
        const readOnly = worktree.links.map((link) => relative(cwd, join(worktree.dir, link)).split('\\').join('/')).filter((path) => !path.startsWith('..'))
        let child: Session | null = null
        const stop = () => child?.cancel()
        signal.addEventListener('abort', stop)
        try {
          child = await host.child(cwd, `${worktree.dir}.cp`, readOnly)
          const childTurn = `${turn.id}-${candidate.id}`
          const prompt = candidatePrompt(turn.request, turn.plan, candidate)
          child.turnRequested()
          child.startTurn(childTurn, prompt)
          const stopReason = await runTurn(child, { id: childTurn, text: prompt }, candidateIO(io, tag, card, state, permissions))
          if (signal.aborted || stopReason === 'cancelled') candidate.status = 'cancelled'
          else {
            const outcome = state.outcome
            candidate.status = outcome?.stop ? 'failed' : 'done'
            if (candidate.status === 'failed') candidate.error = state.error ?? `停在了 ${outcome?.stop}`
          }
        } catch (error) {
          candidate.status = signal.aborted ? 'cancelled' : 'failed'
          candidate.error = error instanceof Error ? error.message : String(error)
          if (!signal.aborted) console.error(`[candidates] 候选 ${candidate.name} 出错`, error)
        } finally {
          signal.removeEventListener('abort', stop)
          child?.execSessions.killAll()
        }
        candidate.summary = (state.text.trim() || state.last.trim()).slice(-SUMMARY_CHARS) || null
        try {
          worktree.tree = await treeOf(worktree.dir, worktree.links)
          const stats = await diffStats(worktree.dir, created.baseTree!, worktree.tree)
          candidate.stats = { files: stats.files, added: stats.added, removed: stats.removed }
          candidate.paths = stats.paths
        } catch (error) {
          if (candidate.status === 'done') candidate.status = 'failed'
          candidate.error ??= `读不出改动：${error instanceof Error ? error.message : String(error)}`
        }
        await io.update({
          sessionUpdate: 'tool_call_update',
          toolCallId: card,
          status: candidate.status === 'done' ? 'completed' : 'failed',
          content: [{ type: 'content', content: { type: 'text', text: candidate.error ?? candidate.summary ?? (candidate.status === 'cancelled' ? '已停止' : '做完了') } }],
          _meta: { diffra: { [AGENT_META_KEY]: meta({ endedAt: Date.now(), edited: candidate.paths }) } },
        })
        await io.update(runCardUpdate(created, false))
      }),
    )
    if (signal.aborted) created.status = 'cancelled'
    else created.status = created.candidates.some((candidate) => candidate.status === 'done' && (candidate.stats?.files ?? 0) > 0) ? 'ready' : 'failed'
    if (created.status === 'failed') await notice(io, 'warning', '没有能用的候选方案', '每个候选都没做出改动或者出错了，worktree 已清掉。可以改一下需求或计划再生成。')
    return signal.aborted ? 'cancelled' : 'end_turn'
  } catch (error) {
    if (!signal.aborted) {
      console.error('[candidates] 生成候选方案失败', error)
      await notice(io, 'error', '生成候选方案失败', error instanceof WorktreeError || error instanceof Error ? error.message : String(error))
      if (run) run.status = 'failed'
    } else if (run) run.status = 'cancelled'
    return signal.aborted ? 'cancelled' : 'end_turn'
  } finally {
    if (run && run.status === 'running') run.status = signal.aborted ? 'cancelled' : 'failed'
    if (run && run.status !== 'ready') await cleanupRun(run)
    if (run) await io.update(runCardUpdate(run, false)).catch(() => {})
    session.activeTurn = null
  }
}

export function candidateRunOf(session: Session, runTurnId: string): CandidateRun {
  const run = session.candidateRuns.find((item) => item.turnId === runTurnId)
  if (!run) throw new Error('没有这组候选方案')
  return run
}

function readyCandidate(run: CandidateRun, candidateId: string) {
  if (run.status !== 'ready') throw new Error('这组候选方案已经不能用了（已应用、已放弃或已清理）')
  const candidate = run.candidates.find((item) => item.id === candidateId)
  const worktree = run.worktrees.find((item) => item.id === candidateId)
  if (!candidate || !worktree?.tree || !run.baseTree) throw new Error('没有这个候选，或者它没做完')
  return { candidate, worktree, baseTree: run.baseTree }
}

// 给人看的改动：候选从起点到做完
export async function candidateDiff(run: CandidateRun, candidateId: string): Promise<string> {
  const { worktree, baseTree } = readyCandidate(run, candidateId)
  return diffText(worktree.dir, baseTree, worktree.tree!)
}

// 应用一个候选（一轮 apply）：先打检查点（能撤销）、检查冲突；对得上就合回项目，出改动卡片，告诉模型文件变了，清掉这组的 worktree。
// 冲突时什么都不改，卡片上列出冲突的文件，候选留着
export async function applyCandidate(session: Session, applyTurnId: string, run: CandidateRun, candidateId: string, io: TurnIO): Promise<StopReason> {
  if (session.running) throw new Error('上一个任务还没结束')
  const { candidate, worktree, baseTree } = readyCandidate(run, candidateId)
  session.activateTurn()
  try {
    await takeCheckpoint(session, applyTurnId, io)
    const patch = await patchOf(worktree.dir, baseTree, worktree.tree!)
    if (patch.length === 0) {
      await notice(io, 'warning', `候选方案「${candidate.name}」没有改动，没什么可应用的`)
      return 'end_turn'
    }
    const check = await checkApply(run.repoRoot, patch)
    if (!check.ok) {
      run.conflicts = check.conflicts.length > 0 ? check.conflicts : ['（git 没说是哪个文件）']
      await notice(io, 'error', `候选方案「${candidate.name}」和项目现在的文件合不上，什么都没改`, `生成候选之后项目里这些文件又改过：${run.conflicts.join('、')}。可以先撤销那些改动，或者重新生成候选。\n\n${check.message}`)
      return 'end_turn'
    }
    delete run.conflicts
    const files = candidate.paths.slice(0, MAX_EDIT_CARDS)
    const readText = async (path: string) => {
      const content = await readFile(resolve(run.repoRoot, path)).catch(() => null)
      if (!content || content.length > MAX_EDIT_CARD_BYTES || content.includes(0)) return content ? undefined : null
      return content.toString('utf8')
    }
    const before = await Promise.all(files.map(readText))
    await applyPatch(run.repoRoot, patch)
    const after = await Promise.all(files.map(readText))
    for (const [index, path] of files.entries()) {
      const oldText = before[index]
      const newText = after[index]
      // 二进制和很大的文件不出全文
      if (oldText === undefined || newText === undefined) continue
      await io.update({
        sessionUpdate: 'tool_call',
        toolCallId: `apply-${run.turnId}-${candidate.id}-${index}`,
        title: `应用候选方案「${candidate.name}」：${path}`,
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path: resolve(run.repoRoot, path), oldText, newText: newText ?? '' }],
      })
    }
    session.messages.push({
      role: 'user',
      content: `[Note from Diffra] The user applied candidate "${candidate.name}" (${candidate.approach}). It was built in a separate copy of the project and merged into the project files. Changed files: ${candidate.paths.join(', ')}. Read them again before editing further.`,
    })
    session.taskState = { ...session.taskState, status: 'blocked', reason: '应用了候选方案，还没在项目里跑检查。' }
    run.status = 'applied'
    run.appliedId = candidate.id
    await cleanupRun(run)
    await publishTaskState(session, io)
    return 'end_turn'
  } finally {
    session.activeTurn = null
  }
}

// 全部放弃：清掉 worktree，项目不动
export async function discardCandidates(run: CandidateRun): Promise<void> {
  if (run.status !== 'ready') return
  run.status = 'discarded'
  delete run.conflicts
  await cleanupRun(run)
}

// 打开旧任务：上次生成到一半应用就退出了（还是 running）的，worktree 清掉、记成停止；等着选的留着
export async function recoverRuns(session: Session): Promise<boolean> {
  let changed = false
  for (const run of session.candidateRuns) {
    if (run.status !== 'running') continue
    run.status = 'cancelled'
    for (const candidate of run.candidates) if (candidate.status === 'running') candidate.status = 'cancelled'
    await cleanupRun(run)
    changed = true
  }
  return changed
}
