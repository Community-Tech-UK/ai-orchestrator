import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeForkArtifacts } from '../../../../scripts/audit/recall-replay';
import { RecallProcessNotRetiredError } from './recall-cli-runner';
import { withRecallSandbox, type RecallCleanupReceipt, type RecallSandbox } from './recall-sandbox';

describe('recall sandbox exceptional exits', () => {
  let root: string;
  let sandbox: RecallSandbox | undefined;
  let receipts: RecallCleanupReceipt[];
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'recall-owned-fixture-')); receipts = []; sandbox = undefined; });
  afterEach(() => {
    if (sandbox) rmSync(sandbox.sandboxCwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const options = () => ({
    projectsRoot: join(root, 'projects'), sourceSessionIds: ['source-placeholder'],
    removeForkArtifacts: (ids: readonly string[]) => removeForkArtifacts(join(root, 'claude-fixture'), ids),
    onCleanup: (receipt: RecallCleanupReceipt) => { receipts.push(receipt); },
  });
  const seed = (owned: RecallSandbox): void => {
    sandbox = owned;
    writeFileSync(join(owned.claim.folder, 'source-placeholder.jsonl'), 'synthetic chat copy\n');
    writeFileSync(join(owned.claim.folder, 'fork-placeholder.jsonl'), 'synthetic partial fork\n');
    const debug = join(root, 'claude-fixture/debug');
    mkdirSync(debug, { recursive: true });
    writeFileSync(join(debug, 'fork-placeholder.txt'), 'synthetic partial state');
    writeFileSync(join(debug, 'source-placeholder.txt'), 'preserve original state');
    owned.recordFork('fork-placeholder');
    owned.recordFork('source-placeholder');
  };

  it.each(['provider failure', 'source re-read failure', 'receipt write failure', 'seal write failure'])(
    'cleans private copies and partial fork state after %s, preserving original state', async phase => {
      await expect(withRecallSandbox(options(), async owned => { seed(owned); throw new Error(phase); })).rejects.toThrow(phase);
      expect(existsSync(sandbox!.claim.folder)).toBe(false);
      expect(existsSync(sandbox!.sandboxCwd)).toBe(false);
      expect(existsSync(join(root, 'claude-fixture/debug/fork-placeholder.txt'))).toBe(false);
      expect(readFileSync(join(root, 'claude-fixture/debug/source-placeholder.txt'), 'utf8')).toBe('preserve original state');
      expect(receipts).toEqual([{ removedFiles: 2, removedDirectory: true, forkArtifactsRemoved: 1 }]);
    },
  );

  it('preserves files and records a refusal when the child may still be alive', async () => {
    await expect(withRecallSandbox(options(), async owned => { seed(owned); throw new RecallProcessNotRetiredError(); }))
      .rejects.toBeInstanceOf(RecallProcessNotRetiredError);
    expect(existsSync(sandbox!.claim.folder)).toBe(true);
    expect(existsSync(join(root, 'claude-fixture/debug/fork-placeholder.txt'))).toBe(true);
    expect(receipts[0]).toMatchObject({ removedDirectory: false, refused: expect.stringContaining('process') });
  });

  it('still retains files if a receipt write fails after a caught unretired-process error', async () => {
    await expect(withRecallSandbox(options(), async owned => {
      seed(owned);
      owned.retainForUnretiredProcess();
      throw new Error('synthetic seal-write failure');
    })).rejects.toBeInstanceOf(RecallProcessNotRetiredError);
    expect(existsSync(sandbox!.claim.folder)).toBe(true);
    expect(receipts[0]).toMatchObject({ removedDirectory: false, refused: expect.stringContaining('process') });
  });

  it('attempts the other cleanup steps and reports failure if outside fork-state removal throws', async () => {
    await expect(withRecallSandbox({ ...options(), removeForkArtifacts: () => { throw new Error('synthetic write protection'); } }, async owned => { seed(owned); }))
      .rejects.toThrow('Recall cleanup did not complete');
    expect(existsSync(sandbox!.claim.folder)).toBe(false);
    expect(existsSync(sandbox!.sandboxCwd)).toBe(false);
    expect(receipts[0]).toMatchObject({ removedDirectory: true });
  });

  it('removes owned files before attempting a cleanup receipt which may itself fail', async () => {
    await expect(withRecallSandbox({ ...options(), onCleanup: () => { throw new Error('synthetic disk full'); } }, async owned => { seed(owned); }))
      .rejects.toThrow('Recall cleanup did not complete');
    expect(existsSync(sandbox!.claim.folder)).toBe(false);
    expect(existsSync(sandbox!.sandboxCwd)).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('reports a retained copy when permissions prevent checking its owned folder', async () => {
    const projects = join(root, 'projects');
    try {
      await expect(withRecallSandbox(options(), async owned => {
        seed(owned);
        chmodSync(projects, 0o000);
      })).rejects.toThrow('Recall cleanup did not complete');
    } finally { chmodSync(projects, 0o700); }
    expect(existsSync(sandbox!.claim.folder)).toBe(true);
    expect(receipts[0]).toMatchObject({ removedDirectory: false });
  });
});
