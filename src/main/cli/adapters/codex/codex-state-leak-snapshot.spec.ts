import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOwnedAioRolloutPath, persistentRolloutPathFor } from './codex-state-leak-snapshot';

describe('isOwnedAioRolloutPath', () => {
  const tempRoots = ['/tmp', 'C:/Temp', '/private/var/folders/x/T'];

  it('matches every disposable AIO temp-home prefix under a temp root', () => {
    expect(isOwnedAioRolloutPath('/tmp/codex-browser-mcp-abc/sessions/2026/07/10/rollout.jsonl', tempRoots)).toBe(true);
    expect(isOwnedAioRolloutPath('C:\\Temp\\codex-nomcp-def\\sessions\\rollout.jsonl', tempRoots)).toBe(true);
    expect(isOwnedAioRolloutPath('/tmp/codex-aio-ghi/sessions/rollout.jsonl', tempRoots)).toBe(true);
  });

  it('matches the canonical /private realpath temp root', () => {
    expect(isOwnedAioRolloutPath(
      '/private/var/folders/x/T/codex-browser-mcp-abc/sessions/2026/07/11/rollout.jsonl',
      tempRoots,
    )).toBe(true);
  });

  it('rejects paths outside any temp root', () => {
    expect(isOwnedAioRolloutPath('/Users/example/.codex/sessions/rollout.jsonl', tempRoots)).toBe(false);
    expect(isOwnedAioRolloutPath('/Users/example/codex-aio-personal/sessions/rollout.jsonl', tempRoots)).toBe(false);
  });

  it('rejects prefix look-alikes and bare prefixes', () => {
    // Bare prefix with no unique suffix.
    expect(isOwnedAioRolloutPath('/tmp/codex-browser-mcp-/sessions/rollout.jsonl', tempRoots)).toBe(false);
    // Prefix not terminated by the hyphen boundary.
    expect(isOwnedAioRolloutPath('/tmp/codex-browser-mcpish/sessions/rollout.jsonl', tempRoots)).toBe(false);
  });

  it('rejects temp-home paths that are not session rollouts', () => {
    expect(isOwnedAioRolloutPath('/tmp/codex-aio-ghi/rollouts/rollout.jsonl', tempRoots)).toBe(false);
    expect(isOwnedAioRolloutPath('/tmp/codex-aio-ghi/sessions', tempRoots)).toBe(false);
  });
});

describe('persistentRolloutPathFor', () => {
  const sessionsDir = join('/aio', 'sessions');

  it('re-roots the post-/sessions/ suffix under the persistent store', () => {
    expect(persistentRolloutPathFor('/tmp/codex-browser-mcp-abc/sessions/2026/07/10/rollout-browser.jsonl', sessionsDir))
      .toBe(join(sessionsDir, '2026', '07', '10', 'rollout-browser.jsonl'));
  });

  it('normalizes backslash temp paths before re-rooting', () => {
    expect(persistentRolloutPathFor('C:\\Temp\\codex-nomcp-def\\sessions\\rollout-exec.jsonl', sessionsDir))
      .toBe(`${sessionsDir}${sep}rollout-exec.jsonl`);
  });

  it('returns null when there is no /sessions/ segment', () => {
    expect(persistentRolloutPathFor('/tmp/codex-aio-ghi/rollouts/rollout.jsonl', sessionsDir)).toBeNull();
  });
});
