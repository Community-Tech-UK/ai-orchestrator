import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { isGitCommitCommand, parseTranscript, resumeRestarts } from '../lib/claude-transcripts.mjs';
import { summariseResumeCache } from '../context-ceiling-replay.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

interface Block { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

function request(id: string, offsetMs: number, cacheRead: number, content?: Block[]): string {
  return JSON.stringify({
    type: 'assistant', timestamp: iso(offsetMs), entrypoint: 'cli',
    message: { id, model: 'test-model', role: 'assistant', ...(content ? { content } : {}),
      usage: { input_tokens: 0, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: 5 } },
  });
}
const tool = (name: string, input: Record<string, unknown> = {}): Block => ({ type: 'tool_use', id: `tu-${name}`, name, input });
const costState = (added?: number, removed?: number) =>
  JSON.stringify({ type: 'cost-state', sessionId: 's', ...(added === undefined ? {} : { totalLinesAdded: added, totalLinesRemoved: removed ?? 0 }) });
const compact = (offsetMs: number) =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: iso(offsetMs), compactMetadata: { preTokens: 100_000, postTokens: 10_000 } });

async function restartsOf(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'resume-restarts-'));
  tempDirs.push(dir);
  const path = join(dir, 's.jsonl');
  writeFileSync(path, lines.join('\n'));
  const parsed = await parseTranscript(path);
  return { parsed, restarts: resumeRestarts(parsed) };
}

describe('resume restarts from process-end records', () => {
  it('counts an edited restart within 55 minutes that kept 95% as kept', async () => {
    const { restarts } = await restartsOf([
      request('a', 0, 100_000, [tool('Edit')]), costState(0, 0), request('b', 10 * MIN, 95_000)]);
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toMatchObject({ category: 'edited', kept: true });
    expect(restarts[0].keptCacheShare).toBeCloseTo(0.95, 9);
  });

  it('counts an edited restart that kept 50% as not kept', async () => {
    const { restarts } = await restartsOf([
      request('a', 0, 100_000, [tool('Write')]), costState(), request('b', 10 * MIN, 50_000)]);
    expect(restarts[0]).toMatchObject({ category: 'edited', kept: false });
  });

  it('excludes a 6-minute idle gap with no edits and a gap over 55 minutes', async () => {
    const noEdits = await restartsOf([request('a', 0, 100_000), costState(0, 0), request('b', 6 * MIN, 95_000)]);
    expect(noEdits.restarts[0].category).toBe('no-edits');
    const cold = await restartsOf([request('a', 0, 100_000, [tool('Edit')]), costState(1, 0), request('b', 56 * MIN, 0)]);
    expect(cold.restarts[0].category).toBe('cold');
  });

  it('does not treat a gap without a process end as a restart', async () => {
    const { restarts } = await restartsOf([request('a', 0, 100_000, [tool('Edit')]), request('b', 10 * MIN, 0)]);
    expect(restarts).toEqual([]);
  });

  it('reads edits from a streamed duplicate message id, git commit, and growth in recorded lines', async () => {
    const streamed = await restartsOf([
      request('a', 0, 100_000), request('a', 1_000, 100_000, [tool('MultiEdit')]), costState(0, 0), request('b', 5 * MIN, 90_000)]);
    expect(streamed.restarts[0]).toMatchObject({ category: 'edited', kept: true });
    const commit = await restartsOf([
      request('a', 0, 100_000, [tool('Bash', { command: 'git -C /repo commit -m x' })]), costState(0, 0), request('b', 5 * MIN, 90_000)]);
    expect(commit.restarts[0].category).toBe('edited');
    const lines = await restartsOf([request('a', 0, 100_000), costState(12, 3), request('b', 5 * MIN, 90_000)]);
    expect(lines.restarts[0].category).toBe('edited');
    const readOnly = await restartsOf([
      request('a', 0, 100_000, [tool('Bash', { command: 'git status && git log' }), tool('Read')]), costState(0, 0), request('b', 5 * MIN, 90_000)]);
    expect(readOnly.restarts[0].category).toBe('no-edits');
  });

  it('only counts line growth since the previous process end', async () => {
    const { restarts } = await restartsOf([
      request('a', 0, 100_000), costState(40, 5), request('b', 5 * MIN, 95_000),
      request('c', 6 * MIN, 100_000), costState(40, 5), request('d', 12 * MIN, 95_000)]);
    expect(restarts.map((r) => r.category)).toEqual(['edited', 'no-edits']);
  });

  it('reports unknown when the transcript cannot establish an element', async () => {
    // No edit tool_use and no recorded line totals: whether it edited is unknowable.
    const edits = await restartsOf([request('a', 0, 100_000), costState(), request('b', 10 * MIN, 95_000)]);
    expect(edits.restarts[0]).toMatchObject({ category: 'unknown', unknownReason: 'edits', kept: null });
    // The prior request carried no context at all.
    const context = await restartsOf([request('a', 0, 0, [tool('Edit')]), costState(1, 0), request('b', 10 * MIN, 0)]);
    expect(context.restarts[0]).toMatchObject({ category: 'unknown', unknownReason: 'context' });
    // A compaction in the gap changes the context legitimately.
    const compacted = await restartsOf([request('a', 0, 100_000, [tool('Edit')]), compact(MIN), costState(1, 0), request('b', 10 * MIN, 10_000)]);
    expect(compacted.restarts[0]).toMatchObject({ category: 'unknown', unknownReason: 'compaction' });
  });

  it('treats adjacent process-end records as one end and ignores one with no following request', async () => {
    const { restarts } = await restartsOf([
      request('a', 0, 100_000, [tool('Edit')]), costState(1, 0), costState(1, 0), request('b', 10 * MIN, 95_000), costState(1, 0)]);
    expect(restarts).toHaveLength(1);
    expect(restarts[0].category).toBe('edited');
  });
});

describe('the --resume-cache summary', () => {
  it('keeps unknowns out of the share and bounds it from below', () => {
    const restart = (category: string, kept: boolean | null = null, unknownReason: string | null = null) =>
      ({ at: 0, gapMs: 0, category, unknownReason, keptCacheShare: null, kept }) as never;
    const summary = summariseResumeCache([
      restart('edited', true), restart('edited', true), restart('edited', false), restart('unknown', null, 'edits'),
      restart('no-edits'), restart('cold')]);
    expect(summary).toMatchObject({ restarts: 6, returns: 3, kept: 2, unknown: 1, unknownReasons: { edits: 1 }, excludedNoEdits: 1, excludedCold: 1 });
    expect(summary.keptShare).toBeCloseTo(2 / 3, 9);
    expect(summary.keptShareLowerBound).toBeCloseTo(2 / 4, 9);
    expect(summariseResumeCache([]).keptShare).toBeNull();
  });
});

describe('git commit command detection (R5M6 W11)', () => {
  // Verbatim copy of the pattern that shipped before the linear rewrite. It is quadratic on many `git`
  // words with no `commit` (about 30s at 200 KB), so it only runs here on small inputs.
  const OLD_GIT_COMMIT_COMMAND = /\bgit\b[^\n;&|]*\bcommit\b/;

  it('matches the old pattern on hand-picked edge cases', () => {
    const cases = [
      '', 'git', 'commit', 'git commit', 'git commit -m "x"', 'git -C repo commit', 'git  commit', 'xgit commit', 'git commitx',
      'git xcommit', 'gitcommit', 'git-commit', 'git commit-tree', 'git\ncommit', 'git; commit', 'git && commit', 'git | commit',
      'git status && git commit -am x', 'git status; echo commit', 'commit git', 'git add . & git commit', 'GIT COMMIT',
      'git log --grep=commit', 'echo git commit', 'git\tcommit', 'git (commit)', 'git "commit"', 'git.commit', 'git/commit',
      'git git git commit', 'git git commit git', 'git\n\ngit commit', 'a;b;git commit', 'git add;\ngit commit', 'git ;commit',
      '\u00e9git commit', 'git\u00e9 commit', 'git commit\u00e9', 'git _commit', 'git commit_', 'git 1commit', '_git commit',
      'git commit commit', 'commit commit git', 'git commit\r\n', 'git||commit', 'git&commit', 'git|&commit',
    ];
    for (const command of cases) expect(isGitCommitCommand(command), JSON.stringify(command)).toBe(OLD_GIT_COMMIT_COMMAND.test(command));
  });

  it('matches the old pattern on every short string over a git, commit and separator alphabet', () => {
    const alphabet = ['git', 'commit', ' ', '\n', ';', '&', '|', '-', 'x', 'é'];
    let checked = 0;
    const walk = (prefix: string, depth: number) => {
      expect(isGitCommitCommand(prefix), JSON.stringify(prefix)).toBe(OLD_GIT_COMMIT_COMMAND.test(prefix));
      checked += 1;
      if (depth === 0) return;
      for (const piece of alphabet) walk(prefix + piece, depth - 1);
    };
    walk('', 5);
    expect(checked).toBeGreaterThan(100_000);
  }, 60_000);

  it('matches the old pattern on seeded random mixes', () => {
    let seed = 0x5eed;
    const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pieces = ['git', 'commit', 'Git', 'commit.', ' ', '  ', '\n', ';', '&&', '|', 'git-', '-m', '"msg"', 'x', '_', 'commits', 'a/b', '\t'];
    for (let run = 0; run < 3000; run++) {
      const length = 1 + Math.floor(next() * 14);
      let command = '';
      for (let index = 0; index < length; index++) command += pieces[Math.floor(next() * pieces.length)];
      expect(isGitCommitCommand(command), JSON.stringify(command)).toBe(OLD_GIT_COMMIT_COMMAND.test(command));
    }
  });

  it('stays linear on many git words with no commit, long separator runs and long commit-less segments', () => {
    const inputs = [
      'git '.repeat(50_000),
      'git '.repeat(50_000) + 'commit',
      `${'git '.repeat(50_000)};commit`,
      'git;'.repeat(50_000),
      `git ${' '.repeat(200_000)}`,
      'git'.repeat(70_000),
      `${'git '.repeat(50_000)}\ngit commit`,
    ];
    const expected = [false, true, false, false, false, false, true];
    const started = performance.now();
    inputs.forEach((input, index) => expect(isGitCommitCommand(input)).toBe(expected[index]));
    expect(performance.now() - started).toBeLessThan(1000);
  }, 30_000);

  it('still marks a restart as edited from a Bash git commit, and not from a commit-less Bash command', async () => {
    const bash = (command: string): Block => ({ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command } });
    const committed = await restartsOf([request('a', 0, 100_000, [bash('git add -A && git commit -m x')]), costState(), request('b', 10 * MIN, 95_000)]);
    expect(committed.restarts[0]!.category).toBe('edited');
    const plain = await restartsOf([request('a', 0, 100_000, [bash('git status')]), costState(), request('b', 10 * MIN, 95_000)]);
    expect(plain.restarts[0]!.category).not.toBe('edited');
  });
});
