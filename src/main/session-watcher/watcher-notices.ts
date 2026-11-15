import { getLogger } from '../logging/logger';
import type { WatcherFlag, WatcherOutcomeEvent } from './session-watcher';

const logger = getLogger('SessionWatcherNotices');

/**
 * The link between the session watcher and the two "finished" notice senders
 * (desktop and phone). Kept apart from the watcher itself so the senders do
 * not pull the judge and its provider code into their own module graphs.
 */
export interface WatcherNoticeSource {
  /** Undefined for a session the watcher does not look after; otherwise what became of its latest stop. */
  outcomeForIdle(instanceId: string): Promise<WatcherOutcomeEvent> | undefined;
}

let source: WatcherNoticeSource | undefined;

export function setWatcherNoticeSource(next: WatcherNoticeSource): void {
  source = next;
}

export function clearWatcherNoticeSource(current: WatcherNoticeSource): void {
  if (source === current) source = undefined;
}

/**
 * Sends the right notice for a session that has just gone from working to idle: nothing when the watcher told it
 * to carry on, `needsYou` when it flagged the session, and `finished` in every other case. A session the watcher
 * does not look after gets `finished` at once, exactly as before the watcher existed.
 */
export function routeFinishedNotice(instanceId: string, send: { finished(): void; needsYou(flag: WatcherFlag): void }): void {
  const pending = source?.outcomeForIdle(instanceId);
  if (!pending) { send.finished(); return; }
  void pending.then((outcome) => {
    if (outcome.outcome === 'not_sent') send.finished();
    else if (outcome.outcome === 'needs_you' && outcome.flag) send.needsYou(outcome.flag);
  }).catch((error: unknown) => {
    logger.warn('A session notice could not be sent', { instanceId, error: error instanceof Error ? error.name : 'unknown' });
  });
}
