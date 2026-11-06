/** Phone status words and colours come from the desktop's shared presenter. */
import {
  isInstanceStatus,
  liveActivityStatusKey,
  presentInstanceStatus,
} from '../../../../../src/shared/attention/instance-status-presentation';

function presentation(status: string) {
  return presentInstanceStatus(isInstanceStatus(status) ? status : 'busy');
}

export function statusColor(status: string): string {
  return presentation(status).color;
}

export function statusTone(status: string): string {
  return presentation(status).tone;
}

export function statusLabel(status: string): string {
  return presentation(status).label;
}

/** What the desktop shows for a looping session beside its status ("Loop running · Working"). */
export const LOOP_RUNNING_LABEL = 'Loop running';

const LOOP_STATUS_COLOR = '#a78bfa';

const ACTIVE_SESSION_STATUSES = new Set<string>([
  'initializing',
  'ready',
  'idle',
  'busy',
  'processing',
  'thinking_deeply',
  'waiting_for_input',
  'waiting_for_permission',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'respawning',
  'hibernating',
  'hibernated',
  'waking',
  'degraded',
]);

interface SessionStatusView {
  status?: string;
  isLooping?: boolean;
}

/**
 * Broad live/current "Active" filter. Based on the desktop project rail's set,
 * but deliberately also includes `hibernated`: a hibernated session is still a
 * resumable live session, and the phone should list it under Active.
 */
export function isActiveSessionStatus(status: string): boolean {
  return ACTIVE_SESSION_STATUSES.has(status);
}

export function needsAttention(status: string): boolean {
  return status === 'waiting_for_permission' || status === 'waiting_for_input';
}

/**
 * The session is already settling an interrupt. A *second* interrupt from here
 * escalates on the host and cancels the session outright
 * (instance/lifecycle/interrupt-respawn-handler.ts), so the UI must not let a
 * second tap happen by accident.
 */
export function isInterruptRecovery(status: string): boolean {
  return (
    status === 'respawning' ||
    status === 'interrupting' ||
    status === 'cancelling' ||
    status === 'interrupt-escalating'
  );
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

/** The words for a session, which put a question or an approval ahead of a running loop. */
export function displayStatusLabel(session: SessionStatusView | null | undefined): string {
  const status = session?.status ?? 'idle';
  if (needsAttention(status)) return statusLabel(status);
  if (session?.isLooping === true) return LOOP_RUNNING_LABEL;
  return statusLabel(status);
}

export function displayStatusTone(session: SessionStatusView | null | undefined): string {
  if (session?.isLooping === true && !needsAttention(session.status ?? 'idle')) return 'loop';
  return statusTone(session?.status ?? 'idle');
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

/**
 * The key the lock-screen widget colours by. Phones built earlier know exactly
 * these keys, and the Mac sends the same ones (`mobile-gateway-push.ts`): a
 * question is `waiting`, and only a permission prompt is `needs approval`. A
 * widget that only knows the key turns it into the shared words ("Needs your
 * answer"). The exact words travel beside it as `displayLabel`
 * (`displayStatusLabel`), so "Thinking" or "Restarting" is not flattened to
 * "Working" on a rebuilt widget.
 */
export function liveActivityStatusLabel(session: SessionStatusView): string {
  const status = session.status ?? 'idle';
  if (status === 'waiting_for_input') return 'waiting';
  if (status === 'waiting_for_permission') return 'needs approval';
  if (session.isLooping === true) return 'looping';
  return liveActivityStatusKey(isInstanceStatus(status) ? status : 'busy');
}

/**
 * Loop run status → plain words, mirroring the desktop `loopStatusLabel`
 * (`src/renderer/app/features/loop/loop-formatters.util.ts`) so the phone
 * and desktop name the same state the same way.
 */
export function loopStatusLabel(status: string): string {
  switch (status) {
    case 'completed': return 'completed';
    case 'completed-needs-review': return 'ended, see notes';
    case 'attempt-failed': return 'stopped: a step failed';
    case 'cancelled': return 'cancelled';
    case 'failed': return 'failed';
    case 'cap-reached': return 'cap';
    case 'error': return 'error';
    case 'no-progress': return 'no-progress';
    case 'provider-limit': return 'provider limit';
    case 'cost-exceeded': return 'cost exceeded';
    case 'needs-human-arbitration': return 'needs arbitration';
    case 'reviewer-unreliable': return 'reviewer unreliable';
    case 'reviewer-unavailable': return 'reviewer unavailable';
    case 'builder-unreliable': return 'builder unreliable';
    case 'paused': return 'paused';
    case 'running': return 'running';
    default: return status;
  }
}

/** Loop question kind → the words the question list shows. */
export function loopQuestionKindLabel(kind: string): string {
  switch (kind) {
    case 'needs-human': return 'Waiting for you';
    case 'decision-applied': return 'Decision applied, tell me if wrong';
    case 'open-question': return 'Open question';
    default: return 'For information';
  }
}

/** Loop question status → words for the question list. */
export function loopQuestionStatusLabel(status: string): string {
  switch (status) {
    case 'open': return 'Open';
    case 'resolved': return 'Resolved';
    case 'dismissed': return 'Dismissed';
    default: return status;
  }
}
