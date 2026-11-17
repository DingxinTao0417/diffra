import type { ModelMessage } from 'ai'

export const COLLABORATION_ROLES = ['explorer', 'implementer', 'reviewer', 'tester'] as const
export type CollaborationRole = (typeof COLLABORATION_ROLES)[number]
export const COLLABORATION_PARALLELISM = 8
export const COLLABORATION_META_KEY = 'collaboration'

export interface CollaborationMessage {
  id: string
  sender: string
  recipient: string
  content: string
  createdAt: string
  status: 'pending' | 'delivered'
}

export interface CollaborationWorktree {
  repoRoot: string
  dir: string
  cwd: string
  links: string[]
  baseTree: string
  integratedTree: string | null
  currentTree?: string
}

export interface CollaborationCheck {
  command: string
  succeeded: boolean
  workdir?: string
}

export interface CollaborationWorker {
  id: string
  name: string
  color: string
  task: string
  role: CollaborationRole
  typeName: string | null
  readOnly: boolean
  context: 'fresh' | 'fork'
  files: string[]
  nodes: string[]
  cardId: string
  turnId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  activation: number
  messages: ModelMessage[]
  compaction?: { upTo: number; summary: string } | null
  summary: string | null
  issues: string | null
  verdict: 'passed' | 'changes_required' | 'blocked' | null
  checks: CollaborationCheck[]
  startedAt: number | null
  endedAt: number | null
  tokens: number
  edited: string[]
  worktree: CollaborationWorktree | null
  resultRevision: number
  notifiedRevision: number
}

export interface CollaborationTask {
  id: string
  revision: number
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  owner: string | null
  blockedBy: string[]
  writeScopes: string[]
}

export interface CollaborationAcceptance {
  status: 'pending' | 'reviewing' | 'testing' | 'passed' | 'blocked'
  fingerprint: string | null
  reviewerId: string | null
  testerId: string | null
  reason: string | null
}

export interface CollaborationState {
  version: 1
  requiresAcceptance?: boolean
  workers: CollaborationWorker[]
  messages: CollaborationMessage[]
  tasks: CollaborationTask[]
  nextTaskNumber: number
  acceptance: CollaborationAcceptance
}

export interface CollaborationView {
  parallelism: number
  workers: Array<Omit<CollaborationWorker, 'messages' | 'compaction' | 'worktree'> & { isolated: boolean; hasUnmergedChanges: boolean }>
  tasks: Array<CollaborationTask & { ready: boolean; writeScopeWarnings: string[] }>
  messages: CollaborationMessage[]
  acceptance: CollaborationAcceptance
}

export interface CollaborationSettings {
  enabled: boolean
  isolation: 'worktree'
  acceptance: 'required'
  maxParallel: 8
}

export interface CollaborationAction {
  action: 'message' | 'interrupt' | 'retry' | 'integrate'
  workerId: string
  message?: string
}

export const DEFAULT_COLLABORATION: CollaborationSettings = {
  enabled: true,
  isolation: 'worktree',
  acceptance: 'required',
  maxParallel: COLLABORATION_PARALLELISM,
}
