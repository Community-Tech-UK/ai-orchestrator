import type { LoopStatus } from '../../shared/types/loop.types';
import type { CampaignNodeStatus } from './campaign.types';

export type CampaignLoopStatusSnapshot = { status: LoopStatus; endedAt: number | null };
export type CampaignLoopStatusReaderResult = LoopStatus | CampaignLoopStatusSnapshot | null;

const LOOP_TERMINAL_STATUSES = new Set<LoopStatus>([
  'completed',
  'completed-needs-review',
  'cancelled',
  'failed',
  'error',
  'no-progress',
  'cap-reached',
  'cost-exceeded',
  'needs-human-arbitration',
  'reviewer-unreliable',
  'reviewer-unavailable',
  'builder-unreliable',
]);

export function normalizeLoopStatusSnapshot(
  value: CampaignLoopStatusReaderResult,
): CampaignLoopStatusSnapshot | null {
  if (!value) return null;
  if (typeof value === 'string') {
    return { status: value, endedAt: null };
  }
  return value;
}

export function isLoopTerminal(snapshot: CampaignLoopStatusSnapshot): boolean {
  if (snapshot.status === 'provider-limit') {
    return snapshot.endedAt != null;
  }
  return LOOP_TERMINAL_STATUSES.has(snapshot.status);
}

export function isLoopProviderLimited(snapshot: CampaignLoopStatusSnapshot): boolean {
  return snapshot.status === 'provider-limit' && snapshot.endedAt == null;
}

export function isActiveCampaignNodeStatus(status: CampaignNodeStatus): boolean {
  return status === 'running' || status === 'provider-limit';
}

export function loopStatusToNodeStatus(
  status: LoopStatus,
  endedAt: number | null = null,
): CampaignNodeStatus {
  switch (status) {
    case 'completed': return 'completed';
    case 'completed-needs-review': return 'completed-needs-review';
    case 'failed':
    case 'error':
    case 'no-progress':
    case 'cap-reached':
    case 'cost-exceeded':
    case 'needs-human-arbitration':
    case 'reviewer-unreliable':
    case 'reviewer-unavailable':
    case 'builder-unreliable': return 'failed';
    case 'provider-limit': return endedAt == null ? 'provider-limit' : 'failed';
    case 'cancelled': return 'operator-halted';
    default: return 'failed';
  }
}
