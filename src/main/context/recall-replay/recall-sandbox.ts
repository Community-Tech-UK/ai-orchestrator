/** Ownership and final cleanup of one quarterly recall run, including partial forks. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimSandbox, cleanupSandbox, type SandboxClaim } from './recall-pipeline';
import { RecallProcessNotRetiredError } from './recall-cli-runner';

export interface RecallSandbox {
  sandboxCwd: string;
  claim: SandboxClaim;
  recordFork(sessionId: string): void;
  retainForUnretiredProcess(): void;
}
export interface RecallCleanupReceipt {
  removedFiles: number;
  removedDirectory: boolean;
  forkArtifactsRemoved: number;
  refused?: string;
}

/** Receipt/evidence work finishes (or throws) before cleanup; cleanup runs on every exit. */
export async function withRecallSandbox<T>(options: {
  projectsRoot: string;
  sourceSessionIds: readonly string[];
  removeForkArtifacts(ids: readonly string[]): number;
  onCleanup(receipt: RecallCleanupReceipt): void;
}, work: (sandbox: RecallSandbox) => Promise<T>): Promise<T> {
  const sandboxCwd = mkdtempSync(join(tmpdir(), 'aio-recall-'));
  let claim: SandboxClaim | undefined;
  let mayRemove = true;
  const sources = new Set(options.sourceSessionIds);
  const forks = new Set<string>();
  const recordFork = (id: string): void => {
    if (!sources.has(id) && /^[A-Za-z0-9_-]{1,128}$/.test(id)) forks.add(id);
  };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    claim = claimSandbox(options.projectsRoot, sandboxCwd);
    outcome = { ok: true, value: await work({ sandboxCwd, claim, recordFork, retainForUnretiredProcess: () => { mayRemove = false; } }) };
  } catch (error) {
    if (error instanceof RecallProcessNotRetiredError) mayRemove = false;
    outcome = { ok: false, error };
  }
  // All work errors have been captured above. Attempt each independent cleanup step
  // before propagating either the work error or any cleanup errors.
  const failures: unknown[] = [];
  if (!mayRemove) {
    try {
      options.onCleanup({ removedFiles: 0, removedDirectory: false, forkArtifactsRemoved: 0,
        refused: 'the recall process may still be using its files' });
    } catch (error) { failures.push(error); }
    failures.unshift(new RecallProcessNotRetiredError());
  } else {
    let receipt: RecallCleanupReceipt = { removedFiles: 0, removedDirectory: false, forkArtifactsRemoved: 0 };
    try {
      if (claim) receipt = { ...cleanupSandbox(options.projectsRoot, sandboxCwd, claim), forkArtifactsRemoved: 0 };
    } catch (error) { failures.push(error); }
    try { receipt.forkArtifactsRemoved = options.removeForkArtifacts([...forks]); } catch (error) { failures.push(error); }
    try { rmSync(sandboxCwd, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    try { options.onCleanup(receipt); } catch (error) { failures.push(error); }
    if (receipt.refused) failures.push(new Error(`Recall sandbox cleanup refused: ${receipt.refused}`));
  }
  if (failures.length === 1 && failures[0] instanceof RecallProcessNotRetiredError) throw failures[0];
  if (failures.length > 0) throw new AggregateError([...(!outcome.ok ? [outcome.error] : []), ...failures], 'Recall cleanup did not complete.');
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
