import { describe, expect, it } from 'vitest';
import { failureOwner, normaliseFailure } from './plan-queue-failure-class';

describe('failureOwner, using wording from real stored failures', () => {
  it.each([
    ['Failed to authenticate: OAuth session expired and could not be refreshed', 'person'],
    ["You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits", 'provider'],
    ['Selected model is at capacity. Please try a different model.', 'provider'],
    ['Codex turn stalled: no notifications received for 900000ms', 'provider'],
    ['workspace routing discovery failed - [codex_error_info: other]', 'provider'],
    ['Command failed: npm ci\n/bin/sh: npm: command not found', 'computer'],
    ['Instance creation is paused by the resource governor (instance-limit)', 'computer'],
    ['ENOSPC: no space left on device', 'computer'],
    ['The document has no acceptance criteria', 'job'],
    ['instance exited with code 1', 'job'],
  ] as const)('%s', (message, owner) => {
    expect(failureOwner(message)).toBe(owner);
  });
});

describe('normaliseFailure', () => {
  it('treats one fault as the same across jobs, whatever path, branch or id each message carries', () => {
    const one = normaliseFailure('Could not prepare the worktree: Command failed: git worktree add -b queue/2026-10-27-mimo-eda0b0 /Users/suas/work/repo/.worktrees/queue/a');
    const two = normaliseFailure('Could not prepare the worktree: Command failed: git worktree add -b queue/2026-10-30-other-1f2c3d /Users/suas/work/repo/.worktrees/queue/b');
    expect(one).toBe(two);
  });

  it('sees through ids and branch names', () => {
    expect(normaliseFailure('job 550e8400-e29b-41d4-a716-446655440000 failed')).toBe(normaliseFailure('job 7c9e6679-7425-40de-944b-e07fc1f90ae7 failed'));
    expect(normaliseFailure('job 550e8400-e29b-41d4-a716-446655440000 failed')).toBe('job <id> failed');
    expect(normaliseFailure('could not delete queue/2026-11-04-pq-a1-33944a')).toBe('could not delete <branch>');
  });

  it('keeps different faults apart', () => {
    expect(normaliseFailure('disk unavailable')).not.toBe(normaliseFailure('network unavailable'));
  });
});
