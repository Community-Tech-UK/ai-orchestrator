import { describe, expect, it } from 'vitest';
import { classifyVerifyAgainstBaseline } from './loop-verify-baseline-compare';
import { extractVerifyFailureKeys } from './verify-failure-keys';
import type { LoopState } from '../../shared/types/loop.types';
const output = '> project@1.0.0 typecheck\nsrc/a.ts(1,2): error TS2322: wrong type';
const keys = [...extractVerifyFailureKeys(output, { truncated: false, failureKind: 'command' }).keys.keys()];
const state = { config: { workspaceCwd: '/tmp', completion: { verifyCommand: 'npm run verify' } }, preflight: { commands: [{ label: 'verify', command: 'npm run verify' }], baseline: { status: 'recorded', keys, failedStep: 'typecheck', scope: 'start-tree', failingCount: 1 } } } as unknown as LoopState;
const outcome = { status: 'failed' as const, output, failureKind: 'command' as const };
describe('baseline comparison', () => {
  it('allows only the existing multiset', () => expect(classifyVerifyAgainstBaseline(state, outcome)).toEqual({ kind: 'already-failing-only', keys }));
  it('reports only the extra occurrence', () => expect(classifyVerifyAgainstBaseline(state, { ...outcome, output: output + '\nsrc/a.ts(2,3): error TS2322: wrong type' })).toEqual({ kind: 'new-failures', keys }));
  it('fails closed for missing baseline, truncation and another failing step', () => {
    expect(classifyVerifyAgainstBaseline({ ...state, preflight: undefined }, outcome)).toBe('unknown');
    expect(classifyVerifyAgainstBaseline(state, { ...outcome, outputTruncated: true })).toBe('unknown');
    expect(classifyVerifyAgainstBaseline(state, { ...outcome, output: output.replace('typecheck', 'lint') })).toBe('unknown');
  });
});

it('does not excuse committed-head failures in dirty starting files', () => {
  const dirty = { ...state, preflight: { ...state.preflight!, baseline: { ...state.preflight!.baseline!, scope: 'committed-head' as const, diagnosticPathPrefix: '' } }, repoBaseline: { trackedDirtyAtStart: ['src/a.ts'], untrackedAtStart: [] } } as unknown as LoopState;
  expect(classifyVerifyAgainstBaseline(dirty, outcome)).toEqual({ kind: 'new-failures', keys });
});

it('old dirty baselines with no diagnostic scope cannot excuse a failure', () => {
  const old = { ...state, preflight: { ...state.preflight!, baseline: { ...state.preflight!.baseline!, scope: 'committed-head' } }, repoBaseline: { trackedDirtyAtStart: ['app/src/a.ts'], untrackedAtStart: [] } } as unknown as LoopState;
  expect(classifyVerifyAgainstBaseline(old, outcome)).toBe('unknown');
});

it('a scoped unrelated starting edit does not block an actual inherited failure', () => {
  const unrelated = { ...state, preflight: { ...state.preflight!, baseline: { ...state.preflight!.baseline!, scope: 'committed-head', diagnosticPathPrefix: 'app' } }, repoBaseline: { trackedDirtyAtStart: ['app/src/b.ts'], untrackedAtStart: [] } } as unknown as LoopState;
  expect(classifyVerifyAgainstBaseline(unrelated, outcome)).toEqual({ kind: 'already-failing-only', keys });
});

it('does not excuse nested cwd diagnostics from dirty or untracked root-relative paths', () => {
  for (const tracked of [true, false]) {
    const nested = { ...state, config: { ...state.config, workspaceCwd: '/repo/app' }, preflight: { ...state.preflight!, baseline: { ...state.preflight!.baseline!, scope: 'committed-head', diagnosticPathPrefix: 'app' } }, repoBaseline: { trackedDirtyAtStart: tracked ? ['app/src/a.ts'] : [], untrackedAtStart: tracked ? [] : ['app/src/a.ts'] } } as unknown as LoopState;
    expect(classifyVerifyAgainstBaseline(nested, outcome)).toEqual({ kind: 'new-failures', keys });
  }
});

it('fails closed for previously persisted C-quoted dirty paths', () => {
  const quoted = { ...state, preflight: { ...state.preflight!, baseline: { ...state.preflight!.baseline!, scope: 'committed-head', diagnosticPathPrefix: '' } },
    repoBaseline: { trackedDirtyAtStart: ['"src/caf/303/251.ts"'], untrackedAtStart: [] } } as unknown as LoopState;
  expect(classifyVerifyAgainstBaseline(quoted, outcome)).toBe('unknown');
});

it('fails closed when a dirty filename contains the key delimiter', () => {
  const pipeOutput = 'src/a|b.ts(1,2): error TS2322: wrong type';
  const pipeKeys = [...extractVerifyFailureKeys(pipeOutput, { truncated: false, failureKind: 'command' }).keys.keys()];
  const dirty = { ...state, preflight: { ...state.preflight!, baseline: { ...state.preflight!.baseline!, scope: 'committed-head', diagnosticPathPrefix: '', keys: pipeKeys, failedStep: undefined } },
    repoBaseline: { trackedDirtyAtStart: ['src/a|b.ts'], untrackedAtStart: [] } } as unknown as LoopState;
  expect(classifyVerifyAgainstBaseline(dirty, { ...outcome, output: pipeOutput })).toBe('unknown');
});
