import type { EventEmitter } from 'events';
import { IPC_CHANNELS } from '@contracts/channels';
import type { InboxChangedEvent } from '@contracts/schemas/observability';
import type { RepoJobRecord } from '../../shared/types/repo-job.types';
import { registerCleanup } from '../util/cleanup-registry';

/** App-lifetime subscriptions, alongside the existing instance/observer forwarding. */
export function bindInboxChangeForwarding(
  proposals: Pick<EventEmitter, 'on' | 'removeListener'>,
  jobs: Pick<EventEmitter, 'on' | 'removeListener'>,
  publish: (channel: string, event: InboxChangedEvent) => void,
  observeJob: (job: RepoJobRecord) => void,
): void {
  let stopped = false;
  const cleanups: (() => void)[] = [];
  const bind = (source: Pick<EventEmitter, 'on' | 'removeListener'>, events: readonly string[], channel: string): void => {
    let lastSentAt = -Infinity;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const send = (): void => {
      pending = undefined;
      if (stopped) return;
      lastSentAt = Date.now();
      publish(channel, { changedAt: lastSentAt });
    };
    const changed = (): void => {
      if (stopped || pending) return;
      const remaining = 1000 - (Date.now() - lastSentAt);
      if (remaining <= 0) send();
      else {
        pending = setTimeout(send, remaining);
        pending.unref();
      }
    };
    for (const event of events) source.on(event, changed);
    cleanups.push(() => {
      if (pending) clearTimeout(pending);
      pending = undefined;
      for (const event of events) source.removeListener(event, changed);
    });
  };
  bind(proposals, ['proposal:created', 'proposal:reinforced', 'proposal:decided'], IPC_CHANNELS.MEMORY_REVIEW_CHANGED);
  const jobEvents = [
    'repo-job:submitted', 'repo-job:started', 'repo-job:progress',
    'repo-job:completed', 'repo-job:failed', 'repo-job:cancelled',
  ];
  bind(jobs, jobEvents, IPC_CHANNELS.REPO_JOB_CHANGED);
  const forwardJob = (job: RepoJobRecord): void => { if (!stopped) observeJob(job); };
  for (const event of jobEvents) jobs.on(event, forwardJob);
  registerCleanup(() => {
    stopped = true;
    for (const cleanup of cleanups) cleanup();
    for (const event of jobEvents) jobs.removeListener(event, forwardJob);
  });
}
