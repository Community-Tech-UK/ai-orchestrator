import type { LoopState } from '../../shared/types/loop.types';
import { posix } from 'node:path';
import type { VerifyOutcomeLike } from './loop-coordinator-utils';
import { loopExecutionCwd } from './loop-cwd';
import { extractVerifyFailureKeys } from './verify-failure-keys';

export type BaselineVerifyClassification = 'passed' | 'unknown'
  | { kind: 'new-failures' | 'already-failing-only'; keys: string[] };

/** Comparable paths must not retain the throwaway copy's absolute prefix. */
export function normalizeVerifyPaths(output: string, cwd: string): string {
  return output.replaceAll(cwd.replaceAll('\\', '/') + '/', '').replaceAll(cwd + '/', '');
}

export function classifyVerifyAgainstBaseline(
  state: LoopState,
  outcome: VerifyOutcomeLike & { outputTruncated?: boolean },
): BaselineVerifyClassification {
  if (outcome.status === 'passed') return 'passed';
  if (outcome.status !== 'failed') return 'unknown';
  const baseline = state.preflight?.baseline;
  if (baseline?.status !== 'recorded') return 'unknown';
  const command = state.preflight?.commands.find(entry => entry.label === 'verify')?.command;
  if (command !== state.config.completion.verifyCommand.trim()) return 'unknown';
  const parsed = extractVerifyFailureKeys(normalizeVerifyPaths(outcome.output, loopExecutionCwd(state.config)), {
    truncated: outcome.outputTruncated === true,
    failureKind: outcome.failureKind ?? 'infra',
  });
  if (parsed.parse !== 'complete' || parsed.failedStep !== baseline.failedStep) return 'unknown';
  const old = new Map<string, number>();
  for (const key of baseline.keys) old.set(key, (old.get(key) ?? 0) + 1);
  const fresh: string[] = [];
  const inherited: string[] = [];
  const dirty = new Set([...(state.repoBaseline?.trackedDirtyAtStart ?? []), ...(state.repoBaseline?.untrackedAtStart ?? [])].map(file => file.replaceAll('\\', '/')));
  const prefix = baseline.diagnosticPathPrefix;
  // Older snapshots may contain Git's C-quoted output rather than actual paths.
  // Those records cannot prove which starting bytes HEAD checked.
  if (baseline.scope === 'committed-head' && [...dirty].some(file => /^".*"$/.test(file) || file.includes('\uFFFD') || file.includes('|'))) return 'unknown';
  if (baseline.scope === 'committed-head' && dirty.size > 0 && (prefix === undefined || posix.isAbsolute(prefix) || posix.normalize(prefix).startsWith('..'))) return 'unknown';
  // Runner diagnostics trim the path; compare the same representation after
  // removing the workspace prefix, while retaining raw identities above.
  const dirtyDiagnostics = new Set([...dirty].map(file => posix.relative(prefix ?? '', file).trim().replace(/^\.\//, '')));
  for (const [key, count] of parsed.keys) {
    // A committed-head snapshot cannot excuse diagnostics in files whose
    // uncommitted starting contents it never checked.
    const file = key.split('|')[2];
    const eligible = baseline.scope !== 'committed-head' || (!dirty.has(file) && !dirty.has(posix.join(prefix ?? '', file)) && !dirtyDiagnostics.has(file));
    const existing = eligible ? Math.min(count, old.get(key) ?? 0) : 0;
    inherited.push(...Array<string>(existing).fill(key));
    fresh.push(...Array<string>(count - existing).fill(key));
  }
  return fresh.length > 0
    ? { kind: 'new-failures', keys: fresh.slice(0, 200) }
    : { kind: 'already-failing-only', keys: inherited.slice(0, 200) };
}

export function inheritedVerifyFailureCount(outcome: VerifyOutcomeLike & { outputTruncated?: boolean }, classification: BaselineVerifyClassification): number {
  if (typeof classification !== 'object' || classification.kind !== 'new-failures') return 0;
  const parsed = extractVerifyFailureKeys(outcome.output, { truncated: outcome.outputTruncated === true, failureKind: outcome.failureKind ?? 'infra' });
  return Math.max(0, [...parsed.keys.values()].reduce((sum, count) => sum + count, 0) - classification.keys.length);
}
