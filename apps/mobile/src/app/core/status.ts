/**
 * Session status → colour/label, mirroring the desktop
 * status-indicator.component.ts mapping so phone and desktop agree.
 */

export function statusColor(status: string): string {
  switch (status) {
    case 'waiting_for_permission':
    case 'waiting_for_input':
      return 'var(--accent-attention)';
    case 'error':
    case 'failed':
    case 'degraded':
      return 'var(--accent-error)';
    case 'busy':
    case 'processing':
    case 'thinking_deeply':
    case 'initializing':
    case 'waking':
    case 'respawning':
    case 'interrupting':
      return 'var(--accent-action)';
    case 'idle':
    case 'ready':
      return 'var(--accent-online)';
    default:
      return 'var(--text-secondary)';
  }
}

export function statusLabel(status: string): string {
  return status.replace(/[_-]/g, ' ');
}

const LOOP_STATUS_COLOR = '#a78bfa';

interface SessionStatusView {
  status?: string;
  isLooping?: boolean;
}

export function needsAttention(status: string): boolean {
  return status === 'waiting_for_permission' || status === 'waiting_for_input';
}

/** True while the agent is actively doing work (drives the typing indicator). */
export function isWorking(status: string): boolean {
  switch (status) {
    case 'busy':
    case 'processing':
    case 'thinking_deeply':
    case 'initializing':
    case 'waking':
    case 'respawning':
    case 'interrupting':
      return true;
    default:
      return false;
  }
}

export function displayStatusLabel(session: SessionStatusView | null | undefined): string {
  const status = session?.status ?? 'idle';
  if (needsAttention(status)) return statusLabel(status);
  if (session?.isLooping === true) return 'loop';
  return statusLabel(status);
}

export function displayStatusColor(session: SessionStatusView | null | undefined): string {
  const status = session?.status ?? 'idle';
  if (needsAttention(status)) return statusColor(status);
  if (session?.isLooping === true) return LOOP_STATUS_COLOR;
  return statusColor(status);
}

export function isWorkingOrLooping(session: SessionStatusView | null | undefined): boolean {
  return session?.isLooping === true || isWorking(session?.status ?? 'idle');
}

export function isLiveActivityCandidate(session: SessionStatusView): boolean {
  return needsAttention(session.status ?? 'idle') || isWorkingOrLooping(session);
}

export function liveActivityStatusLabel(session: SessionStatusView): string {
  const status = session.status ?? 'idle';
  if (needsAttention(status)) return 'needs approval';
  if (session.isLooping === true) return 'looping';
  return 'working';
}
