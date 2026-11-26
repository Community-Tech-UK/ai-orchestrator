import { describe, expect, it } from 'vitest';
import { WorktreeCapacityError } from '../workspace/git/worktree-manager';
import { classifyQueuePreparationError, failureOwner, normaliseFailure } from './plan-queue-failure-class';

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

describe('classifyQueuePreparationError', () => {
  it('goes by error type first, even when the wording is unrecognisable, and sees a type held as the cause', () => {
    expect(classifyQueuePreparationError(new WorktreeCapacityError('no room'))).toBe('transient-capacity');
    expect(classifyQueuePreparationError(new Error('Could not prepare', { cause: new WorktreeCapacityError('no room') }))).toBe('transient-capacity');
  });

  it.each(['EAGAIN', 'EMFILE', 'ENFILE', 'EBUSY'])('goes by the error code %s before any wording', (code) => {
    expect(classifyQueuePreparationError(Object.assign(new Error('spawn failed'), { code }))).toBe('transient-capacity');
  });

  // The wording is only a fallback, for errors Harness throws as plain `Error`s. These strings pin it.
  it.each([
    'Maximum concurrent worktrees (5) reached',
    'Instance creation is paused by the resource governor (instance-limit).',
    'The load gate is closed: the machine is too busy to start another job',
    'Provider codex is at capacity',
    'provider claude concurrency limit reached',
    'too many concurrent sessions',
  ])('treats "%s" as capacity that frees up by itself', (message) => {
    expect(classifyQueuePreparationError(new Error(message))).toBe('transient-capacity');
  });

  it.each([
    new Error('The document has no acceptance criteria'),
    new Error('git worktree add failed: fatal: invalid reference: main'),
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    'a thrown string',
    null,
  ])('leaves %s with the job', (error) => {
    expect(classifyQueuePreparationError(error)).toBe('this-job');
  });
});
