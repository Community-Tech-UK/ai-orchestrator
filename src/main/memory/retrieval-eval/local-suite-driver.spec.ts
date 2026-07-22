import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LocalSuiteResult } from './local-suite';
import {
  LOCAL_CHILD_FLAG,
  LOCAL_FORCE_WASM_FLAG,
  LOCAL_RESULT_SENTINEL,
  buildLocalChildArgs,
  formatLocalChildResult,
  parseLocalChildStdout,
  planLocalDriver,
  resolveElectronBinaryPath,
} from './local-suite-driver';

const ELECTRON_BINARY = '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';

function sampleResult(): LocalSuiteResult {
  return {
    userDataRoot: '/data/harness',
    rlm: { status: 'ok', store: 'rlm', path: '/data/harness/rlm/rlm.db' },
    codemem: { status: 'ok', store: 'codemem', path: '/data/harness/codemem.sqlite' },
    queries: {
      status: 'ok',
      path: '/repo/benchmarks/retrieval/local-queries.jsonl',
      queryCount: 2,
      report: {
        queries: 2,
        r1: 0.5,
        r5: 1,
        r10: 1,
        ndcg10: 0.75,
        perType: { code: { queries: 2, r1: 0.5, r5: 1, r10: 1, ndcg10: 0.75 } },
      },
    },
  };
}

describe('planLocalDriver — which read-only driver a --local run uses', () => {
  it('delegates to a native Electron-as-Node child when an Electron binary is available', () => {
    const plan = planLocalDriver({ args: new Set(['--local']), electronBinaryPath: ELECTRON_BINARY });
    expect(plan.mode).toBe('native-child');
    expect(plan.reason).toContain('2 GiB');
  });

  it('runs natively in-process when it IS the child (never delegates again)', () => {
    const plan = planLocalDriver({
      args: new Set(['--local', LOCAL_CHILD_FLAG]),
      electronBinaryPath: ELECTRON_BINARY,
    });
    expect(plan.mode).toBe('native-in-process');
  });

  it('falls back to the WASM driver when no Electron binary is installed', () => {
    const plan = planLocalDriver({ args: new Set(['--local']), electronBinaryPath: undefined });
    expect(plan.mode).toBe('wasm-in-process');
    expect(plan.reason).toContain('no local Electron binary');
  });

  it('honours the explicit WASM escape hatch even when Electron is available', () => {
    const plan = planLocalDriver({
      args: new Set(['--local', LOCAL_FORCE_WASM_FLAG]),
      electronBinaryPath: ELECTRON_BINARY,
    });
    expect(plan.mode).toBe('wasm-in-process');
    expect(plan.reason).toContain(LOCAL_FORCE_WASM_FLAG);
  });

  it('treats the child marker as authoritative over the WASM escape hatch', () => {
    const plan = planLocalDriver({
      args: new Set([LOCAL_CHILD_FLAG, LOCAL_FORCE_WASM_FLAG]),
      electronBinaryPath: ELECTRON_BINARY,
    });
    expect(plan.mode).toBe('native-in-process');
  });
});

describe('resolveElectronBinaryPath — resolved from the installed package, never hardcoded', () => {
  const repoRoot = '/repo';
  const pathFile = join(repoRoot, 'node_modules', 'electron', 'path.txt');

  it('joins dist/ with the platform path recorded by the electron package', () => {
    const resolved = resolveElectronBinaryPath({
      repoRoot,
      existsSync: () => true,
      readFileSync: (path) => (path === pathFile ? 'Electron.app/Contents/MacOS/Electron\n' : ''),
    });
    expect(resolved).toBe(ELECTRON_BINARY);
  });

  it('returns undefined when the electron package is not installed', () => {
    const resolved = resolveElectronBinaryPath({
      repoRoot,
      existsSync: () => false,
      readFileSync: () => 'Electron.app/Contents/MacOS/Electron',
    });
    expect(resolved).toBeUndefined();
  });

  it('returns undefined when path.txt exists but the binary it names does not', () => {
    const resolved = resolveElectronBinaryPath({
      repoRoot,
      existsSync: (path) => path === pathFile,
      readFileSync: () => 'Electron.app/Contents/MacOS/Electron',
    });
    expect(resolved).toBeUndefined();
  });

  it('returns undefined for an empty path.txt rather than a bare dist/ directory', () => {
    const resolved = resolveElectronBinaryPath({
      repoRoot,
      existsSync: () => true,
      readFileSync: () => '   \n',
    });
    expect(resolved).toBeUndefined();
  });
});

describe('buildLocalChildArgs — child command line', () => {
  it('passes the original flags through and marks the child exactly once', () => {
    const args = buildLocalChildArgs('/repo/node_modules/tsx/dist/cli.mjs', '/repo/scripts/bench-retrieval.ts', [
      '--local',
      '--local-user-data=/tmp/fixture',
    ]);
    expect(args).toEqual([
      '/repo/node_modules/tsx/dist/cli.mjs',
      '/repo/scripts/bench-retrieval.ts',
      '--local',
      '--local-user-data=/tmp/fixture',
      LOCAL_CHILD_FLAG,
    ]);
  });

  it('never duplicates the marker (a stray parent --local-child cannot cause a delegation loop)', () => {
    const args = buildLocalChildArgs('/tsx', '/script', ['--local', LOCAL_CHILD_FLAG]);
    expect(args.filter((arg) => arg === LOCAL_CHILD_FLAG)).toHaveLength(1);
    expect(args[args.length - 1]).toBe(LOCAL_CHILD_FLAG);
  });
});

describe('local-suite child result hand-off', () => {
  it('round-trips a full result through the sentinel line', () => {
    const result = sampleResult();
    expect(parseLocalChildStdout(formatLocalChildResult(result))).toEqual(result);
  });

  it('ignores unrelated child stdout around the sentinel line', () => {
    const stdout = ['some incidental log', formatLocalChildResult(sampleResult()), ''].join('\n');
    expect(parseLocalChildStdout(stdout).codemem.status).toBe('ok');
  });

  it('throws with the raw output when the child emitted no result line', () => {
    expect(() => parseLocalChildStdout('boom: native module failed to load\n')).toThrow(
      /produced no .*line.*native module failed to load/s,
    );
  });

  it('throws (rather than silently returning an empty run) for entirely empty output', () => {
    expect(() => parseLocalChildStdout('')).toThrow(/\(empty\)/);
  });

  it('uses the last sentinel line so a retry inside the child cannot report a stale result', () => {
    const stale = sampleResult();
    const fresh = sampleResult();
    fresh.codemem = { status: 'failed', store: 'codemem', path: '/x', reason: 'corrupt' };
    const stdout = `${formatLocalChildResult(stale)}\n${formatLocalChildResult(fresh)}\n`;
    expect(parseLocalChildStdout(stdout).codemem.status).toBe('failed');
  });

  it('keeps the sentinel on a single line so it can never be confused with report output', () => {
    expect(formatLocalChildResult(sampleResult())).not.toContain('\n');
    expect(LOCAL_RESULT_SENTINEL.trim()).toMatch(/^__WS16_/);
  });
});
