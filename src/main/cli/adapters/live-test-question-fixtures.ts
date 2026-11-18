/**
 * The folders that belong to live-test question sessions.
 *
 * Every spawn path (first start, respawn, wake) reaches the adapter factory
 * with only a working directory, so the folder is what marks a session as a
 * question fixture. Same shape as `signal-fence-scoping.ts`, but a session is
 * only ever added here by the live-test handler, which makes the folder first.
 * In memory only: after a restart a restored session is an ordinary one.
 */

import { resolve } from 'node:path';
import { isHarnessLiveTest } from '../../app/live-test-context';

/** More than this at once is a leak, not a test. */
export const MAX_LIVE_TEST_QUESTION_SESSIONS = 8;

const folders = new Set<string>();

/** Returns false when the limit is reached; the caller must not create the session. */
export function claimLiveTestQuestionFolder(folder: string): boolean {
  const key = resolve(folder);
  if (folders.has(key)) return true;
  if (folders.size >= MAX_LIVE_TEST_QUESTION_SESSIONS) return false;
  folders.add(key);
  return true;
}

/** False outside a live-test app, whatever was claimed. */
export function isLiveTestQuestionFolder(folder: string | undefined): boolean {
  return isHarnessLiveTest() && folder !== undefined && folders.has(resolve(folder));
}

export function releaseLiveTestQuestionFolder(folder: string): void {
  folders.delete(resolve(folder));
}

export function _resetLiveTestQuestionFoldersForTesting(): void {
  folders.clear();
}
