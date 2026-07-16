import { describe, expect, it } from 'vitest';
import { isBenignCodexStdinNotice, isCodexInputTooLargeError, isCodexModelUnavailableError, isFatalSpawnError, isRecoverableThreadResumeError } from './exec-error-classifier';
import { CliSpawnCwdError, directoryExists, enrichSpawnError } from '../base-cli-adapter-utils';
import { tmpdir } from 'os';
import { join } from 'path';

function errnoError(message: string, code: string, syscall?: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  if (syscall) err.syscall = syscall;
  return err;
}

describe('isFatalSpawnError', () => {
  it('matches errno-shaped spawn errors for every fatal code', () => {
    for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']) {
      expect(isFatalSpawnError(errnoError(`spawn codex ${code}`, code, 'spawn codex'))).toBe(true);
    }
  });

  it('matches the bare "spawn" syscall variant', () => {
    expect(isFatalSpawnError(errnoError('spawn ENOENT', 'ENOENT', 'spawn'))).toBe(true);
  });

  it('matches message-only errors that lost their errno shape through wrapping', () => {
    expect(isFatalSpawnError(new Error('Codex failed: spawn codex ENOENT'))).toBe(true);
    expect(isFatalSpawnError(new Error('spawn claude EACCES'))).toBe(true);
  });

  it('matches CliSpawnCwdError from the spawnProcess guard', () => {
    expect(isFatalSpawnError(new CliSpawnCwdError('codex', '/missing/dir'))).toBe(true);
  });

  it('does NOT match errno codes from non-spawn syscalls', () => {
    // e.g. a tool reading a missing file — retryable circumstances differ.
    expect(isFatalSpawnError(errnoError('ENOENT: no such file or directory, open /tmp/x', 'ENOENT', 'open'))).toBe(false);
  });

  it('does NOT match plain "file not found" tool errors', () => {
    expect(isFatalSpawnError(new Error('file not found'))).toBe(false);
    expect(isFatalSpawnError(new Error('config not found'))).toBe(false);
  });

  it('does NOT match thread/session resume errors', () => {
    expect(isFatalSpawnError(new Error('thread not found: thread-abc'))).toBe(false);
    expect(isFatalSpawnError(new Error('thread/resume failed: no rollout found for thread id abc'))).toBe(false);
    expect(isFatalSpawnError(new Error('session expired'))).toBe(false);
  });

  it('does NOT match transient network/backend errors', () => {
    expect(isFatalSpawnError(new Error('http 500 Internal Server Error'))).toBe(false);
    expect(isFatalSpawnError(new Error('connection reset by peer'))).toBe(false);
  });

  it('handles non-Error inputs without throwing', () => {
    expect(isFatalSpawnError(undefined)).toBe(false);
    expect(isFatalSpawnError(null)).toBe(false);
    expect(isFatalSpawnError('spawn codex ENOENT')).toBe(true);
  });
});

describe('spawn errors vs other codex classifiers (cross-checks)', () => {
  const isRecoverableResume = (msg: string): boolean =>
    isRecoverableThreadResumeError(new Error(msg));

  it('spawn codex ENOENT does NOT satisfy isRecoverableThreadResumeError', () => {
    expect(isRecoverableResume('spawn codex ENOENT')).toBe(false);
  });

  it('spawn errors are not model-unavailable errors', () => {
    expect(isCodexModelUnavailableError(new Error('spawn codex ENOENT'))).toBe(false);
  });

  it('spawn errors are not benign stdin notices', () => {
    expect(isBenignCodexStdinNotice('spawn codex ENOENT')).toBe(false);
  });
});

describe('isCodexInputTooLargeError', () => {
  it('matches the codex per-turn char-cap error (with and without leading "Input")', () => {
    expect(isCodexInputTooLargeError(new Error('Input exceeds the maximum length of 1048576 characters.'))).toBe(true);
    expect(isCodexInputTooLargeError(new Error('Codex error: exceeds the maximum length of 1048576 characters'))).toBe(true);
  });

  it('is case-insensitive and tolerates thousands separators', () => {
    expect(isCodexInputTooLargeError(new Error('input exceeds the maximum length of 1,048,576 characters'))).toBe(true);
  });

  it('matches string inputs, not just Error objects', () => {
    expect(isCodexInputTooLargeError('Input exceeds the maximum length of 1048576 characters')).toBe(true);
  });

  it('does NOT match token-based context overflow (handled by ptl-retry token path)', () => {
    expect(isCodexInputTooLargeError(new Error('The input token count (1,048,577) exceeds the maximum number of tokens allowed (1,048,576).'))).toBe(false);
    expect(isCodexInputTooLargeError(new Error('ran out of room in the context window'))).toBe(false);
  });

  it('does NOT match unrelated errors', () => {
    expect(isCodexInputTooLargeError(new Error('thread not found'))).toBe(false);
    expect(isCodexInputTooLargeError(new Error('http 500'))).toBe(false);
    expect(isCodexInputTooLargeError(undefined)).toBe(false);
    expect(isCodexInputTooLargeError(null)).toBe(false);
  });
});

describe('isRecoverableThreadResumeError', () => {
  it('matches Codex interrupted-rollout diagnostics for a missing custom tool output', () => {
    expect(isRecoverableThreadResumeError(
      new Error('Custom tool call output is missing for call id: call_GrCZFAKplJVcTMQRC9S6s0iE'),
    )).toBe(true);
  });

  it('does not broaden recovery to unrelated missing tool output errors', () => {
    expect(isRecoverableThreadResumeError(new Error('Tool output is missing'))).toBe(false);
    expect(isRecoverableThreadResumeError(new Error('Custom tool call failed for call id: call_123'))).toBe(false);
    expect(isRecoverableThreadResumeError(new Error('Custom tool call output is missing'))).toBe(false);
  });
});

describe('enrichSpawnError', () => {
  const original = errnoError('spawn codex ENOENT', 'ENOENT', 'spawn codex');

  it('reports a missing working directory when the cwd does not exist', () => {
    const enriched = enrichSpawnError(original, 'codex', '/definitely/not/a/real/dir');
    expect(enriched.message).toContain('Working directory does not exist: /definitely/not/a/real/dir');
    expect(enriched.message).toContain('codex');
    expect(enriched.message).toContain('Original: spawn codex ENOENT');
  });

  it('reports a missing binary when the cwd exists', () => {
    const enriched = enrichSpawnError(original, 'codex', tmpdir());
    expect(enriched.message).toContain('CLI binary "codex" not found on PATH');
  });

  it('reports a missing binary when no cwd is configured', () => {
    const enriched = enrichSpawnError(original, 'codex', undefined);
    expect(enriched.message).toContain('CLI binary "codex" not found on PATH');
  });

  it('reports a non-executable binary for EACCES/EPERM', () => {
    const eacces = enrichSpawnError(errnoError('spawn codex EACCES', 'EACCES', 'spawn codex'), 'codex', tmpdir());
    expect(eacces.message).toContain('not executable (EACCES)');
  });

  it('passes an already-specific CliSpawnCwdError through unchanged', () => {
    const cwdError = new CliSpawnCwdError('codex', '/missing/dir');
    expect(enrichSpawnError(cwdError, 'codex', '/missing/dir')).toBe(cwdError);
  });
});

describe('directoryExists', () => {
  it('returns true for an existing directory', () => {
    expect(directoryExists(tmpdir())).toBe(true);
  });

  it('returns false for a missing path', () => {
    expect(directoryExists('/definitely/not/a/real/dir')).toBe(false);
  });

  it('returns false for a foreign-platform path', () => {
    expect(directoryExists('C:\\definitely\\not\\a\\real\\aio-dir')).toBe(false);
  });

  it('returns false for a plain file', () => {
    expect(directoryExists(join(process.cwd(), 'package.json'))).toBe(false);
  });
});
