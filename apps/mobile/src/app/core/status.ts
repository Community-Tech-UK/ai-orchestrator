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

