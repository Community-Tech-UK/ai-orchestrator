/**
 * Reaction Engine Types
 *
 * Defines the reaction system that monitors CI/PR state and routes
 * feedback to active agent instances.
 */

export type ReactionEventType =
  | 'ci.passing'
  | 'ci.failing'
  | 'ci.fix_sent'
  | 'pr.created'
  | 'pr.updated'
  | 'pr.merged'
  | 'pr.closed'
  | 'review.pending'
  | 'review.approved'
  | 'review.changes_requested'
  | 'review.comments_sent'
  | 'merge.ready'
  | 'merge.conflicts'
  | 'merge.completed'
  | 'session.stuck'
  | 'session.needs_input'
  | 'session.errored'
  | 'session.exited';

export type ReactionEventPriority = 'urgent' | 'action' | 'warning' | 'info';

export interface ReactionEvent {
  id: string;
  type: ReactionEventType;
  priority: ReactionEventPriority;
  instanceId: string;
  sessionId?: string;
  timestamp: number;
  data: Record<string, unknown>;
  message?: string;
}

export type PRState = 'open' | 'closed' | 'merged' | 'draft';

export type CIStatus = 'pending' | 'passing' | 'failing' | 'unknown';

export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'none';

export interface CICheck {
  name: string;
  status: CIStatus;
  conclusion?: string;
  url?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface PREnrichmentData {
  owner: string;
  repo: string;
  number: number;
  url: string;
  state: PRState;
  ciStatus: CIStatus;
  ciChecks: CICheck[];
  reviewDecision: ReviewDecision;
  mergeable: boolean;
  hasConflicts: boolean;
  headBranch?: string;
  baseBranch?: string;
  updatedAt?: number;
  fetchedAt: number;
}

export type ReactionAction = 'send-to-agent' | 'notify' | 'auto-merge' | 'ignore';

export interface ReactionConfig {
  auto: boolean;
  action: ReactionAction;
  message?: string;
  priority?: ReactionEventPriority;
  retries?: number;
  escalateAfter?: number | string;
}

export interface ReactionResult {
  reactionType: string;
  success: boolean;
  action: string;
  message?: string;
  escalated: boolean;
}

export interface InstanceReactionState {
  instanceId: string;
  prUrl?: string;
  prData?: PREnrichmentData;
  lastPRStatus?: string;
  lastCIStatus?: CIStatus;
  lastReviewDecision?: ReviewDecision;
  lastReviewFingerprint?: string;
  lastCIFailureFingerprint?: string;
  reactionTrackers: Map<string, ReactionTracker>;
  startedAt: number;
  lastPolledAt?: number;
}

export interface ReactionTracker {
  attempts: number;
  firstTriggered: number;
  lastTriggered: number;
}

export type ReactionConfigMap = Partial<Record<string, ReactionConfig>>;

export interface ReactionEngineConfig {
  pollIntervalMs: number;
  enabled: boolean;
  reactions: ReactionConfigMap;
  notificationRouting: Partial<Record<ReactionEventPriority, string[]>>;
}

export const DEFAULT_REACTION_ENGINE_CONFIG: ReactionEngineConfig = {
  pollIntervalMs: 30_000,
  enabled: false,
  reactions: {
    'ci-failed': { auto: true, action: 'send-to-agent', retries: 2, escalateAfter: '30m' },
    'changes-requested': { auto: true, action: 'send-to-agent', retries: 2, escalateAfter: '30m' },
    'approved-and-green': { auto: false, action: 'notify', priority: 'action' },
    'merge-conflicts': { auto: true, action: 'send-to-agent', retries: 1, escalateAfter: '15m' },
    'agent-stuck': { auto: true, action: 'notify', priority: 'urgent', escalateAfter: '10m' },
    'agent-needs-input': { auto: true, action: 'notify', priority: 'urgent' },
    'agent-exited': { auto: true, action: 'notify', priority: 'warning' },
    'pr-merged': { auto: true, action: 'notify', priority: 'info' },
  },
  notificationRouting: {
    urgent: ['desktop'],
    action: ['desktop'],
    warning: ['desktop'],
    info: ['desktop'],
  },
};

export function eventToReactionKey(eventType: ReactionEventType): string | null {
  switch (eventType) {
    case 'ci.failing': return 'ci-failed';
    case 'ci.passing': return null;
    case 'ci.fix_sent': return null;
    case 'review.changes_requested': return 'changes-requested';
    case 'review.approved': return null;
    case 'merge.ready': return 'approved-and-green';
    case 'merge.conflicts': return 'merge-conflicts';
    case 'merge.completed': return 'pr-merged';
    case 'pr.merged': return 'pr-merged';
    case 'session.stuck': return 'agent-stuck';
    case 'session.needs_input': return 'agent-needs-input';
    case 'session.exited': return 'agent-exited';
    case 'session.errored': return 'agent-stuck';
    default: return null;
  }
}

export function inferReactionPriority(eventType: ReactionEventType): ReactionEventPriority {
  if (eventType.includes('stuck') || eventType.includes('needs_input') || eventType.includes('errored')) {
    return 'urgent';
  }
  if (eventType.includes('failing') || eventType.includes('changes_requested') || eventType.includes('conflicts')) {
    return 'warning';
  }
  if (eventType.includes('approved') || eventType.includes('ready') || eventType.includes('merged')) {
    return 'action';
  }
  return 'info';
}

export function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    default: return 0;
  }
}
