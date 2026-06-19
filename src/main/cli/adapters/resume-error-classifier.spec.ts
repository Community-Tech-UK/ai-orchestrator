/**
 * Tests for resume-error-classifier.ts
 *
 * Verifies the full phrase set from §5 Phase 1 item 6 of the
 * interrupt-resume-recovery plan, plus the structured classification result.
 */

import { describe, it, expect } from 'vitest';
import { classifyResumeError, isSessionNotFoundText } from './resume-error-classifier';

// ── isSessionNotFoundText — session / conversation not-found phrases ──────────

describe('isSessionNotFoundText — not-found phrases', () => {
  it.each([
    'no conversation found',
    'No conversation found for this session',
    'CONVERSATION NOT FOUND',
    'session not found',
    'Session Not Found',
    'SESSION NOT FOUND',
    'unknown session',
    'Unknown session id: abc123',
    'no such session',
    'No such session exists',
    'session does not exist',
    'The session does not exist',
    'missing session',
    'no matching session',
    'No matching session for id xyz',
  ])('returns true for: %s', (phrase) => {
    expect(isSessionNotFoundText(phrase)).toBe(true);
  });
});

describe('isSessionNotFoundText — thread not-found phrases (Codex)', () => {
  it.each([
    'thread not found',
    'Thread not found for id abc',
    'unknown thread',
    'Unknown thread: xyz',
    'no such thread',
    'thread does not exist',
    'The thread does not exist',
    'no rollout found',
    'No rollout found for thread abc',
    'missing rollout',
    'Missing rollout file',
  ])('returns true for: %s', (phrase) => {
    expect(isSessionNotFoundText(phrase)).toBe(true);
  });
});

describe('isSessionNotFoundText — expired phrases (Cursor)', () => {
  it.each([
    'session expired',
    'Session expired, please start a new one',
    'session has expired',
    'conversation expired',
  ])('returns true for: %s', (phrase) => {
    expect(isSessionNotFoundText(phrase)).toBe(true);
  });
});

describe('isSessionNotFoundText — invalid phrases', () => {
  it.each([
    'invalid session id',
    'Invalid session id: abc123',
    'invalid session',
    'Invalid session provided',
    'invalid thread',
    'Invalid thread: abc',
    'bad session',
    'Bad session id',
  ])('returns true for: %s', (phrase) => {
    expect(isSessionNotFoundText(phrase)).toBe(true);
  });
});

describe('isSessionNotFoundText — returns false for unrelated text', () => {
  it.each([
    'network timeout',
    'connection refused',
    'out of memory',
    '',
    'Hello from the assistant',
    'rate limit exceeded',
    'context length exceeded',
    'could not find file',
    'permission denied',
  ])('returns false for: %s', (phrase) => {
    expect(isSessionNotFoundText(phrase)).toBe(false);
  });
});

// ── classifyResumeError — structured classification ───────────────────────────

describe('classifyResumeError — kind discrimination', () => {
  it('classifies not-found as kind=not-found, definitive', () => {
    const result = classifyResumeError('session not found');
    expect(result.isResumeFailure).toBe(true);
    expect(result.kind).toBe('not-found');
    expect(result.isDefinitive).toBe(true);
  });

  it('classifies thread-not-found as kind=thread-not-found, definitive', () => {
    const result = classifyResumeError('thread not found');
    expect(result.isResumeFailure).toBe(true);
    expect(result.kind).toBe('thread-not-found');
    expect(result.isDefinitive).toBe(true);
  });

  it('classifies expired as kind=expired, definitive', () => {
    const result = classifyResumeError('session expired');
    expect(result.isResumeFailure).toBe(true);
    expect(result.kind).toBe('expired');
    expect(result.isDefinitive).toBe(true);
  });

  it('classifies invalid session id as kind=invalid, definitive', () => {
    const result = classifyResumeError('invalid session id');
    expect(result.isResumeFailure).toBe(true);
    expect(result.kind).toBe('invalid');
    expect(result.isDefinitive).toBe(true);
  });

  it('returns isResumeFailure=false for unrelated text', () => {
    const result = classifyResumeError('network timeout');
    expect(result.isResumeFailure).toBe(false);
    expect(result.kind).toBe('unknown');
    expect(result.isDefinitive).toBe(false);
  });

  it('prioritizes thread-not-found over not-found when both could match', () => {
    // "thread not found" matches thread-not-found, not the generic not-found
    const result = classifyResumeError('thread not found');
    expect(result.kind).toBe('thread-not-found');
  });

  it('is case-insensitive', () => {
    expect(classifyResumeError('SESSION NOT FOUND').isResumeFailure).toBe(true);
    expect(classifyResumeError('Session Expired').isResumeFailure).toBe(true);
    expect(classifyResumeError('INVALID SESSION ID').isResumeFailure).toBe(true);
    expect(classifyResumeError('THREAD NOT FOUND').isResumeFailure).toBe(true);
  });

  it('matches phrases embedded in longer messages', () => {
    expect(
      classifyResumeError('Error: session not found for id a1b2c3d4'),
    ).toMatchObject({ isResumeFailure: true, kind: 'not-found' });

    expect(
      classifyResumeError('Resuming previous conversation: no rollout found at ~/.codex/sessions/abc.jsonl'),
    ).toMatchObject({ isResumeFailure: true, kind: 'thread-not-found' });
  });
});
