import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkArtifactFreshness,
  evaluateLoopArtifactFreshness,
  MAX_FRESHNESS_RETRIES,
  resolveBuildOutputDir,
  shouldBlockOnStaleArtifacts,
  type FreshnessResult,
} from './loop-artifact-freshness';

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Write a file with an explicit mtime so the test does not race the clock. */
function writeAt(absPath: string, contents: string, epochSeconds: number): void {
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, contents);
  utimesSync(absPath, epochSeconds, epochSeconds);
}

const T0 = 1_700_000_000;

describe('checkArtifactFreshness (L7)', () => {
  it('reports stale when a source file is newer than every build output', async () => {
    const ws = workspace();
    writeAt(join(ws, 'dist', 'main.js'), 'old', T0);
    writeAt(join(ws, 'src', 'app.ts'), 'new', T0 + 600);

    const result = await checkArtifactFreshness({ workspaceCwd: ws, outputDir: 'dist' });

    expect(result.verdict).toBe('stale');
    expect(result.staleAgainst).toBe('src/app.ts');
    expect(result.reason).toContain('does not include the current source');
  });

  it('reports fresh when the build output is newer', async () => {
    const ws = workspace();
    writeAt(join(ws, 'src', 'app.ts'), 'src', T0);
    writeAt(join(ws, 'dist', 'main.js'), 'built', T0 + 600);

    expect((await checkArtifactFreshness({ workspaceCwd: ws, outputDir: 'dist' })).verdict).toBe('fresh');
  });

  // Same-operation writes can land a second apart on some filesystems.
  it('tolerates a sub-threshold difference rather than crying stale', async () => {
    const ws = workspace();
    writeAt(join(ws, 'dist', 'main.js'), 'built', T0);
    writeAt(join(ws, 'src', 'app.ts'), 'src', T0 + 1);

    expect((await checkArtifactFreshness({ workspaceCwd: ws, outputDir: 'dist' })).verdict).toBe('fresh');
  });

  // The fail-open contract. Each of these must be `unknown`, never `stale`.
  it('is unknown when there is no build output at all', async () => {
    const ws = workspace();
    writeAt(join(ws, 'src', 'app.ts'), 'src', T0);

    const result = await checkArtifactFreshness({ workspaceCwd: ws, outputDir: 'dist' });

    expect(result.verdict).toBe('unknown');
    expect(result.reason).toContain('no build output');
  });

  it('is unknown when no source file matches the predicate', async () => {
    const ws = workspace();
    writeAt(join(ws, 'dist', 'main.js'), 'built', T0);

    const result = await checkArtifactFreshness({
      workspaceCwd: ws,
      outputDir: 'dist',
      isSource: () => false,
    });

    expect(result.verdict).toBe('unknown');
  });

  it('ignores node_modules and dot-directories', async () => {
    const ws = workspace();
    writeAt(join(ws, 'dist', 'main.js'), 'built', T0);
    writeAt(join(ws, 'node_modules', 'pkg', 'index.js'), 'dep', T0 + 9_000);
    writeAt(join(ws, '.cache', 'thing.ts'), 'cache', T0 + 9_000);
    writeAt(join(ws, 'src', 'app.ts'), 'src', T0 - 100);

    expect((await checkArtifactFreshness({ workspaceCwd: ws, outputDir: 'dist' })).verdict).toBe('fresh');
  });

  it('never treats the output directory itself as a source', async () => {
    const ws = workspace();
    writeAt(join(ws, 'src', 'app.ts'), 'src', T0);
    writeAt(join(ws, 'dist', 'main.js'), 'built', T0 + 600);

    expect((await checkArtifactFreshness({ workspaceCwd: ws, outputDir: 'dist' })).verdict).toBe('fresh');
  });
});

describe('shouldBlockOnStaleArtifacts (L7)', () => {
  const stale: FreshnessResult = { verdict: 'stale', reason: 'x' };
  const unknown: FreshnessResult = { verdict: 'unknown', reason: 'x' };
  const fresh: FreshnessResult = { verdict: 'fresh', reason: 'x' };

  it('blocks a positively-established stale build while retries remain', () => {
    expect(shouldBlockOnStaleArtifacts(stale, 0)).toBe(true);
    expect(shouldBlockOnStaleArtifacts(stale, MAX_FRESHNESS_RETRIES - 1)).toBe(true);
  });

  // A build that will not refresh is a problem for a human, not a reason to spin.
  it('gives up once the retries are spent and lets the loop proceed', () => {
    expect(shouldBlockOnStaleArtifacts(stale, MAX_FRESHNESS_RETRIES)).toBe(false);
  });

  // The single most important behaviour: unestablished staleness never blocks.
  it('never blocks on an unknown verdict', () => {
    expect(shouldBlockOnStaleArtifacts(unknown, 0)).toBe(false);
  });

  it('never blocks on a fresh verdict', () => {
    expect(shouldBlockOnStaleArtifacts(fresh, 0)).toBe(false);
  });
});

/**
 * L7 wiring — the decision the coordinator actually calls. Every path that
 * cannot establish staleness must return `null` ("carry on").
 */
describe('evaluateLoopArtifactFreshness (L7 wiring)', () => {
  function stateFor(workspaceCwd: string, rejections = 0) {
    return { config: { workspaceCwd }, staleArtifactRejections: rejections };
  }

  it('returns null for a workspace with no build output directory', async () => {
    const ws = workspace();
    writeAt(join(ws, 'src', 'app.ts'), 'src', T0);

    expect(await evaluateLoopArtifactFreshness(stateFor(ws))).toBeNull();
  });

  it('blocks with an actionable intervention when the build is genuinely stale', async () => {
    const ws = workspace();
    writeAt(join(ws, 'dist', 'main.js'), 'old', T0);
    writeAt(join(ws, 'src', 'app.ts'), 'new', T0 + 600);

    const result = await evaluateLoopArtifactFreshness(stateFor(ws));

    expect(result).not.toBeNull();
    expect(result!.intervention).toContain('Rebuild');
    expect(result!.intervention).toContain('dist/');
    expect(result!.reason).toContain('src/app.ts');
  });

  it('stops blocking once the retries are spent', async () => {
    const ws = workspace();
    writeAt(join(ws, 'dist', 'main.js'), 'old', T0);
    writeAt(join(ws, 'src', 'app.ts'), 'new', T0 + 600);

    expect(await evaluateLoopArtifactFreshness(stateFor(ws, MAX_FRESHNESS_RETRIES))).toBeNull();
  });

  it('prefers the execution cwd, so an isolated loop grades its own worktree', async () => {
    const repoRoot = workspace();
    const worktree = workspace();
    // The repo root looks stale; the worktree the agent actually used is fine.
    writeAt(join(repoRoot, 'dist', 'main.js'), 'old', T0);
    writeAt(join(repoRoot, 'src', 'app.ts'), 'new', T0 + 600);
    writeAt(join(worktree, 'src', 'app.ts'), 'src', T0);
    writeAt(join(worktree, 'dist', 'main.js'), 'built', T0 + 600);

    const state = { config: { workspaceCwd: repoRoot, executionCwd: worktree } };
    expect(await evaluateLoopArtifactFreshness(state)).toBeNull();
  });

  it('finds a build directory under any conventional name', async () => {
    for (const dir of ['dist', 'build', 'out', 'lib']) {
      const ws = workspace();
      writeAt(join(ws, dir, 'main.js'), 'built', T0);
      expect(await resolveBuildOutputDir(ws), dir).toBe(dir);
    }
  });

  it('returns null when the workspace has no conventional build directory', async () => {
    expect(await resolveBuildOutputDir(workspace())).toBeNull();
  });
});
