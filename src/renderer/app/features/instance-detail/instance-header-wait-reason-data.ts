import type { InstanceWaitReason } from '../../../../shared/types/instance-wait-reason.types';

/** Format runtime values; the header owns all words shown around them. */
export function formatWaitReasonData(wr: InstanceWaitReason | undefined): {
  time?: string;
  sessionId?: string;
  staleSeconds?: number;
} {
  switch (wr?.kind) {
    case 'backoff':
      return { time: new Date(wr.retryAt).toLocaleTimeString() };
    case 'quota-park':
      return { time: new Date(wr.resumeAt).toLocaleTimeString() };
    case 'auth-required':
      return { time: new Date(wr.since).toLocaleTimeString() };
    case 'resume-proof':
      return { sessionId: wr.sessionId?.slice(0, 8) };
    case 'remote-heartbeat':
      return { staleSeconds: Math.round(wr.staleForMs / 1000) };
    default:
      return {};
  }
}
