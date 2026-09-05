import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildOutputFingerprint,
  computeVerifyTreeHash,
  MAX_BUILD_OUTPUT_ENTRIES,
  LoopVerifyReplayCache,
  renderReplayNotice,
  VERIFY_REPLAY_MAX_AGE_MS,
  type VerifyReplayKey,
  type VerifyReplayRecord,
} from './loop-verify-replay';
import type { GitRunner } from './loop-diff';

let workspace: string | null = null;
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function fakeRunner(responses: {
  insideRepo?: boolean;
  head?: string;
  trackedDiff?: string;
  untracked?: string;
  trackedStatus?: number | null;
}): GitRunner {
  return (args) => {
    if (args.includes('--is-inside-work-tree')) {
      return responses.insideRepo === false
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: 'true\n' };
    }
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${responses.head ?? 'abc123'}\n` };
    if (args[0] === 'ls-files') return { status: 0, stdout: responses.untracked ?? '' };
    return { status: responses.trackedStatus ?? 0, stdout: responses.trackedDiff ?? '' };
  };
}

describe('computeVerifyTreeHash', () => {
  it('returns null outside a git worktree so callers fail open', () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    expect(computeVerifyTreeHash(workspace, fakeRunner({ insideRepo: false }))).toBeNull();
  });

  it('returns null when git cannot produce the tracked diff', () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    expect(computeVerifyTreeHash(workspace, fakeRunner({ trackedStatus: 128 }))).toBeNull();
  });

  it('is stable for an identical tree and changes with the tracked diff', () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const a = computeVerifyTreeHash(workspace, fakeRunner({ trackedDiff: 'diff one' }));
    const b = computeVerifyTreeHash(workspace, fakeRunner({ trackedDiff: 'diff one' }));
    const c = computeVerifyTreeHash(workspace, fakeRunner({ trackedDiff: 'diff two' }));

    expect(a).toBeTruthy();
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('changes when HEAD moves even though the diff text is identical', () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const a = computeVerifyTreeHash(workspace, fakeRunner({ head: 'aaa', trackedDiff: 'd' }));
    const b = computeVerifyTreeHash(workspace, fakeRunner({ head: 'bbb', trackedDiff: 'd' }));
    expect(a).not.toBe(b);
  });

  it('changes when an untracked file changes content', () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    writeFileSync(join(workspace, 'new.ts'), 'const a = 1;');
    const runner = fakeRunner({ untracked: 'new.ts\n' });
    const before = computeVerifyTreeHash(workspace, runner);
    writeFileSync(join(workspace, 'new.ts'), 'const a = 2;');
    const after = computeVerifyTreeHash(workspace, runner);

    expect(before).toBeTruthy();
    expect(after).not.toBe(before);
  });

  // Build output is gitignored, so `ls-files --others --exclude-standard`
  // never sees a rebuild. Without folding it in, a freshly rebuilt tree hashes
  // identically to the stale one and replays a red the rebuild may have fixed.
  it('changes when the build output is rebuilt, even with identical sources', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const { mkdirSync, utimesSync } = await import('node:fs');
    mkdirSync(join(workspace, 'dist'), { recursive: true });
    writeFileSync(join(workspace, 'dist', 'main.js'), 'built');
    const runner = fakeRunner({ trackedDiff: 'unchanged sources' });
    const before = computeVerifyTreeHash(workspace, runner);

    // A rebuild moves the artefact's mtime FORWARD. Using a timestamp older
    // than the directory's own mtime would be masked by the `Math.max` and
    // would test nothing.
    const rebuiltAt = Date.now() / 1000 + 900;
    utimesSync(join(workspace, 'dist', 'main.js'), rebuiltAt, rebuiltAt);
    const after = computeVerifyTreeHash(workspace, runner);

    expect(before).toBeTruthy();
    expect(after).not.toBe(before);
  });

  // The shape that matters for THIS repo: compiled output lives at
  // `dist/main/**`, and recompiling a file in place changes neither `dist`'s
  // own mtime nor `dist/main`'s. A one-level scan sees nothing and replays a
  // red the rebuild may have fixed.
  it('changes when a NESTED build artefact is recompiled in place', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const { mkdirSync, utimesSync } = await import('node:fs');
    mkdirSync(join(workspace, 'dist', 'main', 'orchestration'), { recursive: true });
    const nested = join(workspace, 'dist', 'main', 'orchestration', 'thing.js');
    writeFileSync(nested, 'compiled');
    const runner = fakeRunner({ trackedDiff: 'unchanged sources' });
    const before = computeVerifyTreeHash(workspace, runner);

    const rebuiltAt = Date.now() / 1000 + 900;
    utimesSync(nested, rebuiltAt, rebuiltAt);
    const after = computeVerifyTreeHash(workspace, runner);

    expect(before).toBeTruthy();
    expect(after).not.toBe(before);
  });

  // An added or removed artefact must register even if surviving files keep
  // their timestamps — hence the entry count in the fingerprint.
  it('changes when a build artefact is added or removed', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const { mkdirSync, rmSync: removeSync } = await import('node:fs');
    mkdirSync(join(workspace, 'dist', 'main'), { recursive: true });
    writeFileSync(join(workspace, 'dist', 'main', 'a.js'), 'a');
    const runner = fakeRunner({ trackedDiff: 'unchanged sources' });
    const before = computeVerifyTreeHash(workspace, runner);

    writeFileSync(join(workspace, 'dist', 'main', 'b.js'), 'b');
    const added = computeVerifyTreeHash(workspace, runner);
    expect(added).not.toBe(before);

    removeSync(join(workspace, 'dist', 'main', 'b.js'));
    expect(computeVerifyTreeHash(workspace, runner)).toBe(before);
  });

  // The defect a 4,000-entry cap produced on the real repo: the walk was
  // exhausted inside `dist/main` before ever reaching `dist/renderer`, so
  // touching a renderer artefact left the hash byte-identical. A DEEP file
  // beyond the first directory read must register.
  it('detects a rebuild deep in the tree, past the first output subdirectory', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const { mkdirSync, utimesSync } = await import('node:fs');
    // Two sibling trees; the one we touch is NOT the first read.
    mkdirSync(join(workspace, 'dist', 'aaa-main', 'deep', 'nested'), { recursive: true });
    mkdirSync(join(workspace, 'dist', 'zzz-renderer', 'browser'), { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      writeFileSync(join(workspace, 'dist', 'aaa-main', 'deep', 'nested', `chunk-${i}.js`), 'x');
    }
    const deep = join(workspace, 'dist', 'zzz-renderer', 'browser', 'routes.json');
    writeFileSync(deep, '{}');
    const runner = fakeRunner({ trackedDiff: 'unchanged sources' });
    const before = computeVerifyTreeHash(workspace, runner);

    const rebuiltAt = Date.now() / 1000 + 900;
    utimesSync(deep, rebuiltAt, rebuiltAt);

    expect(computeVerifyTreeHash(workspace, runner)).not.toBe(before);
  });

  // A partial fingerprint is stable and BLIND — it silently disables the very
  // detection it exists to provide. Overflow must fail open instead.
  //
  // The cap is injectable purely so this can exercise the REAL branch: the
  // previous version of this test wrote one file and asserted the constant was
  // big, which proves nothing about the boundary and would have passed with the
  // overflow branch deleted.
  it('fails open rather than truncating when the build tree is too large', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(workspace, 'dist'), { recursive: true });
    for (let i = 0; i < 5; i += 1) writeFileSync(join(workspace, 'dist', `f-${i}.js`), 'x');

    // Exactly at the cap is still a complete view; one over is not.
    expect(buildOutputFingerprint(workspace, 5)).toBeTruthy();
    expect(buildOutputFingerprint(workspace, 4)).toBeNull();
    // And the shipped cap is comfortably above this repo's real dist/ size.
    expect(MAX_BUILD_OUTPUT_ENTRIES).toBeGreaterThan(25_000);
  });

  // A symlink is neither isFile() nor isDirectory() to `Dirent`, so it fell
  // through both branches and was skipped in silence.
  it('fails open when the build output contains a symlink', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const { mkdirSync, symlinkSync } = await import('node:fs');
    mkdirSync(join(workspace, 'dist'), { recursive: true });
    writeFileSync(join(workspace, 'dist', 'real.js'), 'a');
    expect(buildOutputFingerprint(workspace)).toBeTruthy();

    symlinkSync(join(workspace, 'dist', 'real.js'), join(workspace, 'dist', 'link.js'));
    expect(buildOutputFingerprint(workspace)).toBeNull();
  });

  // `chmod 000` on `dist` itself does NOT make statSync(dist) fail — stat needs
  // permission on the ANCESTOR, not the target. Only an unreadable parent hits
  // the non-ENOENT branch, which is why this is easy to leave untested.
  it('fails open when a build root cannot be stat-ed for a reason other than absence', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'verify-replay-outer-'));
    const inner = join(outer, 'ws');
    const { mkdirSync, chmodSync, statSync } = await import('node:fs');
    mkdirSync(join(inner, 'dist'), { recursive: true });
    writeFileSync(join(inner, 'dist', 'a.js'), 'a');
    expect(buildOutputFingerprint(inner)).toBeTruthy();

    chmodSync(outer, 0o000);
    try {
      let denied = false;
      try {
        statSync(join(inner, 'dist'));
      } catch {
        denied = true;
      }
      // Root ignores the permission bit; assert only if the OS really refused.
      if (denied) expect(buildOutputFingerprint(inner)).toBeNull();
    } finally {
      chmodSync(outer, 0o755);
      rmSync(outer, { recursive: true, force: true });
    }
  });

  // Gate finding: the walk swallowed a `readdirSync` failure and carried on as
  // if the directory were EMPTY. The hash then stayed byte-identical while an
  // arbitrary amount of rebuilt output sat unread underneath it — the same
  // "confident answer from a partial view" failure as the truncation bug, only
  // triggered by permissions instead of size.
  it('fails open when a build subdirectory cannot be read', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const { mkdirSync, chmodSync, readdirSync } = await import('node:fs');
    const locked = join(workspace, 'dist', 'main', 'sub');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'a.js'), 'a');
    const runner = fakeRunner({ trackedDiff: 'unchanged sources' });
    expect(computeVerifyTreeHash(workspace, runner)).toBeTruthy();

    chmodSync(locked, 0o000);
    try {
      let unreadable = false;
      try {
        readdirSync(locked);
      } catch {
        unreadable = true;
      }
      // Running as root defeats the permission bit entirely; assert only when
      // the OS actually denied us, rather than passing on a vacuous setup.
      if (unreadable) expect(computeVerifyTreeHash(workspace, runner)).toBeNull();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('is unaffected by a workspace with no build output at all', () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    const runner = fakeRunner({ trackedDiff: 'd' });
    expect(computeVerifyTreeHash(workspace, runner)).toBe(computeVerifyTreeHash(workspace, runner));
  });

  it('fails open when an untracked path cannot be read', () => {
    workspace = mkdtempSync(join(tmpdir(), 'verify-replay-'));
    writeFileSync(join(workspace, 'new.ts'), 'const a = 1;');
    const hash = computeVerifyTreeHash(
      workspace,
      fakeRunner({ untracked: 'new.ts\n' }),
      () => { throw new Error('EACCES'); },
    );
    expect(hash).toBeNull();
  });
});

describe('LoopVerifyReplayCache', () => {
  const key: VerifyReplayKey = {
    kind: 'verify',
    command: 'npm run verify',
    cwd: '/repo',
    treeHash: 'tree-a',
  };
  const record: VerifyReplayRecord = {
    treeHash: 'tree-a',
    command: 'npm run verify',
    exitCode: 1,
    output: 'boom',
    durationMs: 10,
    failureKind: 'command',
    recordedAt: 1_000,
  };

  it('returns a recorded red for the same key', () => {
    const cache = new LoopVerifyReplayCache();
    cache.record('loop-1', key, record);
    expect(cache.lookup('loop-1', key, 2_000)).toEqual(record);
  });

  it('does not leak across loop runs', () => {
    const cache = new LoopVerifyReplayCache();
    cache.record('loop-1', key, record);
    expect(cache.lookup('loop-2', key, 2_000)).toBeNull();
  });

  it('expires an entry older than the max age', () => {
    const cache = new LoopVerifyReplayCache();
    cache.record('loop-1', key, record);
    expect(cache.lookup('loop-1', key, 1_000 + VERIFY_REPLAY_MAX_AGE_MS + 1)).toBeNull();
  });

  it('clears one loop without touching the others', () => {
    const cache = new LoopVerifyReplayCache();
    cache.record('loop-1', key, record);
    cache.record('loop-2', key, record);
    cache.clear('loop-1');

    expect(cache.lookup('loop-1', key, 1_500)).toBeNull();
    expect(cache.lookup('loop-2', key, 1_500)).toEqual(record);
  });

  it('bounds entries per loop run', () => {
    const cache = new LoopVerifyReplayCache();
    for (let i = 0; i < 12; i += 1) {
      cache.record('loop-1', { ...key, treeHash: `tree-${i}` }, { ...record, treeHash: `tree-${i}` });
    }
    expect(cache.lookup('loop-1', { ...key, treeHash: 'tree-0' }, 1_500)).toBeNull();
    expect(cache.lookup('loop-1', { ...key, treeHash: 'tree-11' }, 1_500)).not.toBeNull();
  });
});

describe('renderReplayNotice', () => {
  it('says the run was skipped and how to force a fresh one', () => {
    const notice = renderReplayNotice(
      {
        treeHash: 'tree-a',
        command: 'npm run verify',
        exitCode: 1,
        output: 'boom',
        durationMs: 10,
        failureKind: 'command',
        recordedAt: 1_000,
      },
      61_000,
    );
    expect(notice).toContain('Verify was NOT re-run');
    expect(notice).toContain('npm run verify');
    expect(notice).toContain('60s ago');
    expect(notice).toContain('exit 1');
  });
});
