/** Who has to act on a failure. Only `job` is worth another worker round. */
import { WorktreeCapacityError } from '../workspace/git/worktree-manager';

export type FailureOwner = 'job' | 'computer' | 'provider' | 'person';

export function classifyQueuePreparationError(error: unknown): 'transient-capacity' | 'this-job' {
  if (error instanceof WorktreeCapacityError || error instanceof Error && error.cause instanceof WorktreeCapacityError) return 'transient-capacity';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return ['EAGAIN', 'EMFILE', 'ENFILE', 'EBUSY'].includes(code)
    || /Maximum concurrent worktrees|resource governor|load gate|provider.*(?:at capacity|concurrency)|too many concurrent/i.test(message)
    ? 'transient-capacity' : 'this-job';
}

/**
 * A worker turn that failed for a reason that passes by itself, so it is retried in the same session
 * before the item parks. The wording is what the queue's own records show workers parking with: a Codex
 * turn that stalled or went silent (900000 ms) and a model at capacity. (A resource governor pause arrives
 * when the worker starts, not mid-turn, and is already deferred by `PlanQueuePreparationErrors`.)
 * A sign-in expiry is not here: it needs James.
 */
export function isTransientQueueTurnFailure(reason: string): boolean {
  return /transport closed|provider (?:returned )?5\d\d|adapter not spawned|timed out waiting for the turn to accept|model is at capacity|codex turn stalled|codex went silent for/i.test(reason);
}

/** Wording from real stored failures. Anything unrecognised stays with the job, as it always has. */
export function failureOwner(message: string): FailureOwner {
  if (/oauth|failed to authenticate|not signed in|sign(?:ed)?[- ]in|log(?:ged)?[- ]?in|credential|unauthori[sz]ed/i.test(message)) return 'person';
  if (isTransientQueueTurnFailure(message) || /usage limit|rate limit|overloaded|routing discovery failed|network error/i.test(message)) return 'provider';
  if (/command not found|no space left|ENOSPC|EMFILE|ENFILE|EACCES|resource governor|load gate|cannot allocate memory/i.test(message)) return 'computer';
  return 'job';
}

/** The same fault reads differently per job, so paths, ids, hashes and numbers are removed before comparing. */
export function normaliseFailure(message: string): string {
  return message.replace(/\s+/g, ' ').trim()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\bqueue\/[^\s'"`:,)]+/g, '<branch>')
    .replace(/(?:~|\.{0,2})?\/[^\s'"`:,)]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .slice(0, 300);
}
